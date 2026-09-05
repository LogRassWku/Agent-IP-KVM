"""Linux V4L2 device discovery and capability probing."""

from __future__ import annotations

import glob
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Iterable, Protocol, Sequence

from .base import SourceCapability


class DiscoveryStatus(str, Enum):
    OK = "ok"
    NO_DEVICES = "no_devices"
    UNSUPPORTED_PLATFORM = "unsupported_platform"
    TOOL_MISSING = "tool_missing"
    PARTIAL = "partial"


class V4L2NodeKind(str, Enum):
    VIDEO_CAPTURE = "video_capture"
    METADATA_CAPTURE = "metadata_capture"
    OTHER = "other"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class V4L2DeviceInfo:
    device_path: str
    display_name: str
    driver: str | None
    bus_info: str | None
    node_kind: V4L2NodeKind
    supports_video_capture: bool
    capabilities: tuple[SourceCapability, ...]
    error: str | None = None

    @property
    def source_id(self) -> str:
        return f"v4l2:{self.device_path}"


@dataclass(frozen=True, slots=True)
class V4L2DiscoveryReport:
    status: DiscoveryStatus
    devices: tuple[V4L2DeviceInfo, ...]
    message: str


class CommandResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[Sequence[str]], CommandResult]


def _default_runner(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=5,
    )


def parse_device_info(
    text: str,
) -> tuple[str | None, str | None, str | None, V4L2NodeKind]:
    """Parse the stable labels printed by ``v4l2-ctl --info``."""

    values: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"\s*(Driver name|Card type|Bus info)\s*:\s*(.+?)\s*$", line)
        if match:
            values[match.group(1)] = match.group(2)

    capability_text = _device_caps_body(text) or text
    if re.search(r"^\s*Video Capture(?: Multiplanar)?\s*$", capability_text, re.MULTILINE):
        node_kind = V4L2NodeKind.VIDEO_CAPTURE
    elif re.search(r"^\s*Metadata Capture\s*$", capability_text, re.MULTILINE):
        node_kind = V4L2NodeKind.METADATA_CAPTURE
    else:
        node_kind = V4L2NodeKind.OTHER
    return (
        values.get("Card type"),
        values.get("Driver name"),
        values.get("Bus info"),
        node_kind,
    )


def _device_caps_body(text: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.match(r"\s*Device Caps\s*:", line):
            continue
        heading_indent = len(line) - len(line.lstrip())
        body: list[str] = []
        for child in lines[index + 1 :]:
            if not child.strip():
                continue
            child_indent = len(child) - len(child.lstrip())
            if child_indent <= heading_indent:
                break
            body.append(child)
        return "\n".join(body)
    return ""


def parse_format_capabilities(text: str) -> tuple[SourceCapability, ...]:
    """Extract discrete pixel format, size, and frame-rate combinations."""

    pixel_format: str | None = None
    size: tuple[int, int] | None = None
    capabilities: list[SourceCapability] = []

    for line in text.splitlines():
        format_match = re.match(r"\s*\[\d+\]:\s*'([^']+)'", line)
        if format_match:
            pixel_format = format_match.group(1)
            size = None
            continue

        size_match = re.match(r"\s*Size:\s*Discrete\s+(\d+)x(\d+)", line)
        if size_match:
            size = (int(size_match.group(1)), int(size_match.group(2)))
            continue

        interval_match = re.match(
            r"\s*Interval:\s*Discrete\s+.+?\(([0-9.]+)\s+fps\)", line
        )
        if interval_match and pixel_format is not None and size is not None:
            capabilities.append(
                SourceCapability(
                    width=size[0],
                    height=size[1],
                    fps=float(interval_match.group(1)),
                    pixel_format=pixel_format,
                )
            )

    return tuple(dict.fromkeys(capabilities))


def discover_v4l2_devices(
    *,
    device_paths: Iterable[str] | None = None,
    platform_name: str | None = None,
    tool_path: str | None = None,
    runner: CommandRunner | None = None,
) -> V4L2DiscoveryReport:
    """Find V4L2 nodes and query each without starting video capture."""

    current_platform = platform_name or platform.system()
    if current_platform != "Linux":
        return V4L2DiscoveryReport(
            status=DiscoveryStatus.UNSUPPORTED_PLATFORM,
            devices=(),
            message=f"V4L2 discovery requires Linux; current platform is {current_platform}",
        )

    paths = tuple(sorted(device_paths if device_paths is not None else glob.glob("/dev/video*")))
    if not paths:
        return V4L2DiscoveryReport(
            status=DiscoveryStatus.NO_DEVICES,
            devices=(),
            message="no /dev/video* devices were found",
        )

    executable = tool_path or shutil.which("v4l2-ctl")
    if executable is None:
        return V4L2DiscoveryReport(
            status=DiscoveryStatus.TOOL_MISSING,
            devices=(),
            message="v4l2-ctl is required; install the v4l-utils package",
        )

    run = runner or _default_runner
    devices = tuple(_probe_device(path, executable, run) for path in paths)
    failed = sum(device.error is not None for device in devices)
    status = DiscoveryStatus.PARTIAL if failed else DiscoveryStatus.OK
    message = (
        f"found {len(devices)} V4L2 device(s); {failed} probe(s) failed"
        if failed
        else f"found {len(devices)} V4L2 device(s)"
    )
    return V4L2DiscoveryReport(status=status, devices=devices, message=message)


def _probe_device(path: str, executable: str, runner: CommandRunner) -> V4L2DeviceInfo:
    fallback_name = Path(path).name
    try:
        info_result = runner((executable, "--device", path, "--info"))
        if info_result.returncode != 0:
            return _failed_device(path, fallback_name, info_result.stderr or info_result.stdout)

        display_name, driver, bus_info, node_kind = parse_device_info(info_result.stdout)
        formats_result = runner((executable, "--device", path, "--list-formats-ext"))
        if formats_result.returncode != 0:
            return V4L2DeviceInfo(
                device_path=path,
                display_name=display_name or fallback_name,
                driver=driver,
                bus_info=bus_info,
                node_kind=node_kind,
                supports_video_capture=node_kind is V4L2NodeKind.VIDEO_CAPTURE,
                capabilities=(),
                error=_clean_error(formats_result.stderr or formats_result.stdout),
            )

        return V4L2DeviceInfo(
            device_path=path,
            display_name=display_name or fallback_name,
            driver=driver,
            bus_info=bus_info,
            node_kind=node_kind,
            supports_video_capture=node_kind is V4L2NodeKind.VIDEO_CAPTURE,
            capabilities=parse_format_capabilities(formats_result.stdout),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return _failed_device(path, fallback_name, str(exc))


def _failed_device(path: str, display_name: str, message: str) -> V4L2DeviceInfo:
    return V4L2DeviceInfo(
        device_path=path,
        display_name=display_name,
        driver=None,
        bus_info=None,
        node_kind=V4L2NodeKind.UNKNOWN,
        supports_video_capture=False,
        capabilities=(),
        error=_clean_error(message),
    )


def _clean_error(message: str) -> str:
    cleaned = " ".join(message.split())
    return cleaned or "v4l2-ctl returned an unknown error"
