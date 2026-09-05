"""Read-only discovery of Linux USB Gadget HID capability."""

from __future__ import annotations

import gzip
import platform
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path


class HidProbeStatus(str, Enum):
    UNSUPPORTED_PLATFORM = "unsupported_platform"
    NO_UDC = "no_udc"
    CONFIGFS_UNAVAILABLE = "configfs_unavailable"
    READY = "ready"
    IN_USE = "in_use"


@dataclass(frozen=True, slots=True)
class UdcInfo:
    name: str
    state: str | None
    current_speed: str | None
    maximum_speed: str | None


@dataclass(frozen=True, slots=True)
class GadgetInfo:
    name: str
    udc: str | None
    functions: tuple[str, ...]
    carries_management_network: bool


@dataclass(frozen=True, slots=True)
class HidProbeReport:
    status: HidProbeStatus
    message: str
    configfs_mounted: bool
    hid_kernel_support: bool | None
    safe_to_modify_now: bool
    udcs: tuple[UdcInfo, ...]
    gadgets: tuple[GadgetInfo, ...]

    def as_dict(self) -> dict[str, object]:
        result = asdict(self)
        result["status"] = self.status.value
        return result


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip() or None
    except (OSError, PermissionError):
        return None


def _read_kernel_config(
    proc_root: Path,
    boot_root: Path,
    kernel_release: str,
) -> dict[str, str]:
    text: str | None = None
    compressed = proc_root / "config.gz"
    try:
        if compressed.is_file():
            with gzip.open(compressed, "rt", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
    except (OSError, PermissionError):
        text = None

    if text is None:
        text = _read_text(boot_root / f"config-{kernel_release}")
    if text is None:
        return {}

    values: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("CONFIG_") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def _configfs_is_mounted(proc_root: Path) -> bool:
    mounts = _read_text(proc_root / "mounts") or ""
    return any(
        len(parts) >= 3 and parts[2] == "configfs"
        for line in mounts.splitlines()
        if (parts := line.split())
    )


def _probe_udcs(udc_root: Path) -> tuple[UdcInfo, ...]:
    try:
        entries = sorted(udc_root.iterdir(), key=lambda path: path.name)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return ()
    return tuple(
        UdcInfo(
            name=entry.name,
            state=_read_text(entry / "state"),
            current_speed=_read_text(entry / "current_speed"),
            maximum_speed=_read_text(entry / "maximum_speed"),
        )
        for entry in entries
    )


def _probe_gadgets(gadget_root: Path) -> tuple[GadgetInfo, ...]:
    try:
        entries = sorted(gadget_root.iterdir(), key=lambda path: path.name)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return ()

    gadgets: list[GadgetInfo] = []
    for entry in entries:
        functions_root = entry / "functions"
        try:
            functions = tuple(sorted(item.name for item in functions_root.iterdir()))
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            functions = ()
        udc = _read_text(entry / "UDC")
        gadgets.append(
            GadgetInfo(
                name=entry.name,
                udc=udc,
                functions=functions,
                carries_management_network=bool(udc)
                and any(name.startswith(("rndis.", "ecm.", "ncm.")) for name in functions),
            )
        )
    return tuple(gadgets)


def probe_usb_hid(
    *,
    platform_name: str | None = None,
    sys_root: Path = Path("/sys"),
    proc_root: Path = Path("/proc"),
    boot_root: Path = Path("/boot"),
    kernel_release: str | None = None,
) -> HidProbeReport:
    """Inspect USB Gadget prerequisites without creating or changing a gadget."""

    current_platform = platform_name or platform.system()
    if current_platform != "Linux":
        return HidProbeReport(
            status=HidProbeStatus.UNSUPPORTED_PLATFORM,
            message="USB Gadget HID probing is only available on Linux",
            configfs_mounted=False,
            hid_kernel_support=None,
            safe_to_modify_now=False,
            udcs=(),
            gadgets=(),
        )

    configfs_mounted = _configfs_is_mounted(proc_root)
    udcs = _probe_udcs(sys_root / "class" / "udc")
    gadgets = _probe_gadgets(sys_root / "kernel" / "config" / "usb_gadget")
    config = _read_kernel_config(
        proc_root,
        boot_root,
        kernel_release or platform.release(),
    )
    hid_value = config.get("CONFIG_USB_CONFIGFS_F_HID")
    hid_kernel_support = None if hid_value is None else hid_value in {"y", "m"}

    if not udcs:
        status = HidProbeStatus.NO_UDC
        message = "no USB Device Controller is exposed by this system"
    elif not configfs_mounted or not (sys_root / "kernel" / "config" / "usb_gadget").is_dir():
        status = HidProbeStatus.CONFIGFS_UNAVAILABLE
        message = "USB Gadget ConfigFS is not mounted or unavailable"
    elif any(gadget.udc for gadget in gadgets):
        status = HidProbeStatus.IN_USE
        if any(gadget.carries_management_network for gadget in gadgets):
            message = "an active gadget carries a management network; changing it may disconnect this session"
        else:
            message = "a USB gadget is already bound; changing it requires a controlled rebind"
    else:
        status = HidProbeStatus.READY
        message = "USB Gadget prerequisites are available and no gadget is currently bound"

    safe_to_modify_now = status is HidProbeStatus.READY and hid_kernel_support is not False
    return HidProbeReport(
        status=status,
        message=message,
        configfs_mounted=configfs_mounted,
        hid_kernel_support=hid_kernel_support,
        safe_to_modify_now=safe_to_modify_now,
        udcs=udcs,
        gadgets=gadgets,
    )
