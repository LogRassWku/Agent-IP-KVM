"""Linux USB Gadget HID output adapter."""

from __future__ import annotations

import os
import stat
import time
from pathlib import Path
from typing import Callable, Protocol

from .base import HidAdapter, HidError, HidState, HidStoppedError, MouseButton


KEY_USAGES = {
    **{chr(ord("a") + offset): 0x04 + offset for offset in range(26)},
    **{str(number): usage for number, usage in zip(range(1, 10), range(0x1E, 0x27))},
    "0": 0x27,
    "enter": 0x28,
    "escape": 0x29,
    "esc": 0x29,
    "backspace": 0x2A,
    "tab": 0x2B,
    "space": 0x2C,
    "-": 0x2D,
    "=": 0x2E,
    "[": 0x2F,
    "]": 0x30,
    "\\": 0x31,
    ";": 0x33,
    "'": 0x34,
    "`": 0x35,
    ",": 0x36,
    ".": 0x37,
    "/": 0x38,
    "capslock": 0x39,
    "f1": 0x3A,
    "f2": 0x3B,
    "f3": 0x3C,
    "f4": 0x3D,
    "f5": 0x3E,
    "f6": 0x3F,
    "f7": 0x40,
    "f8": 0x41,
    "f9": 0x42,
    "f10": 0x43,
    "f11": 0x44,
    "f12": 0x45,
    "delete": 0x4C,
    "home": 0x4A,
    "pageup": 0x4B,
    "end": 0x4D,
    "pagedown": 0x4E,
    "right": 0x4F,
    "left": 0x50,
    "down": 0x51,
    "up": 0x52,
}

MODIFIER_BITS = {
    "left_ctrl": 0x01,
    "ctrl": 0x01,
    "left_shift": 0x02,
    "shift": 0x02,
    "left_alt": 0x04,
    "alt": 0x04,
    "left_meta": 0x08,
    "meta": 0x08,
    "win": 0x08,
    "right_ctrl": 0x10,
    "right_shift": 0x20,
    "right_alt": 0x40,
    "right_meta": 0x80,
}

BUTTON_BITS = {
    MouseButton.LEFT: 0x01,
    MouseButton.RIGHT: 0x02,
    MouseButton.MIDDLE: 0x04,
    MouseButton.BACK: 0x08,
    MouseButton.FORWARD: 0x10,
}


class ReportWriter(Protocol):
    def write(self, report: bytes) -> None: ...

    def close(self) -> None: ...


class _FdReportWriter:
    def __init__(self, path: Path) -> None:
        flags = os.O_WRONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
        self._fd = os.open(path, flags)

    def write(self, report: bytes) -> None:
        remaining = memoryview(report)
        while remaining:
            written = os.write(self._fd, remaining)
            if written <= 0:
                raise OSError("HID report write returned no progress")
            remaining = remaining[written:]

    def close(self) -> None:
        if self._fd >= 0:
            os.close(self._fd)
            self._fd = -1


def _parse_device_number(value: str) -> tuple[int, int]:
    try:
        major_text, minor_text = value.strip().split(":", 1)
        major = int(major_text)
        minor = int(minor_text)
    except (ValueError, TypeError) as exc:
        raise HidError(f"invalid ConfigFS HID device number: {value!r}") from exc
    if major < 0 or minor < 0:
        raise HidError(f"invalid ConfigFS HID device number: {value!r}")
    return major, minor


def resolve_hidg_path(function_directory: Path, dev_root: Path = Path("/dev")) -> Path:
    """Resolve a ConfigFS HID function to its matching /dev/hidg node."""

    dev_attribute = function_directory / "dev"
    try:
        expected = _parse_device_number(dev_attribute.read_text(encoding="ascii"))
    except OSError as exc:
        raise HidError(f"cannot read HID function device number: {dev_attribute}") from exc

    for candidate in sorted(dev_root.glob("hidg*")):
        try:
            device_stat = candidate.stat()
        except OSError:
            continue
        if not stat.S_ISCHR(device_stat.st_mode):
            continue
        actual = (os.major(device_stat.st_rdev), os.minor(device_stat.st_rdev))
        if actual == expected:
            return candidate
    raise HidError(
        f"no /dev/hidg node matches {function_directory.name} device {expected[0]}:{expected[1]}"
    )


def wait_for_hidg_path(
    function_directory: Path,
    dev_root: Path = Path("/dev"),
    timeout_seconds: float = 10.0,
) -> Path:
    """Wait briefly for udev to create the node after USB Gadget binding."""

    deadline = time.monotonic() + timeout_seconds
    last_error: HidError | None = None
    while True:
        try:
            return resolve_hidg_path(function_directory, dev_root)
        except HidError as exc:
            last_error = exc
        if time.monotonic() >= deadline:
            assert last_error is not None
            raise last_error
        time.sleep(0.1)


class LinuxGadgetHidAdapter(HidAdapter):
    """Write keyboard, relative mouse, and optional absolute pointer reports."""

    def __init__(
        self,
        keyboard_path: Path,
        mouse_path: Path,
        writer_factory: Callable[[Path], ReportWriter] = _FdReportWriter,
        *,
        pointer_path: Path | None = None,
    ) -> None:
        self._keyboard_path = Path(keyboard_path)
        self._mouse_path = Path(mouse_path)
        self._pointer_path = Path(pointer_path) if pointer_path is not None else None
        self._writer_factory = writer_factory
        self._keyboard_writer: ReportWriter | None = None
        self._mouse_writer: ReportWriter | None = None
        self._pointer_writer: ReportWriter | None = None
        self._state = HidState.CLOSED
        self._modifier_mask = 0
        self._pressed_keys: list[int] = []
        self._button_mask = 0
        self._pointer_x = 16384
        self._pointer_y = 16384

    @property
    def state(self) -> HidState:
        return self._state

    def _require_ready(self) -> None:
        if self._state is HidState.STOPPED:
            raise HidStoppedError("emergency stop is active; call arm() before sending input")
        if self._state is not HidState.READY:
            raise HidError("HID adapter is not ready; call arm() before sending input")

    @staticmethod
    def _normalise_key(key: str) -> str:
        if not isinstance(key, str):
            raise TypeError("key must be a string")
        normalised = key.strip().lower().replace("-", "_").replace(" ", "_")
        if not normalised:
            raise ValueError("key must not be empty")
        return normalised

    @staticmethod
    def _validate_axis(value: int, name: str) -> None:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"{name} must be an integer")
        if not -127 <= value <= 127:
            raise ValueError(f"{name} must be between -127 and 127")

    def _write_one(self, writer: ReportWriter | None, report: bytes, name: str) -> None:
        if writer is None:
            raise HidError(f"{name} HID device is not open")
        try:
            writer.write(report)
        except OSError as exc:
            self._state = HidState.ERROR
            raise HidError(f"failed to write {name} HID report: {exc}") from exc

    def _write_keyboard(self) -> None:
        self._ensure_writer("_keyboard_writer", self._keyboard_path, "keyboard")
        keys = bytes(self._pressed_keys + [0] * (6 - len(self._pressed_keys)))
        self._write_one(
            self._keyboard_writer,
            bytes((self._modifier_mask, 0)) + keys,
            "keyboard",
        )

    def _write_mouse(self, delta_x: int = 0, delta_y: int = 0, wheel: int = 0) -> None:
        self._ensure_writer("_mouse_writer", self._mouse_path, "mouse")
        self._write_one(
            self._mouse_writer,
            bytes((self._button_mask, delta_x & 0xFF, delta_y & 0xFF, wheel & 0xFF)),
            "mouse",
        )

    def _write_pointer(self, wheel: int = 0) -> None:
        if self._pointer_path is None:
            raise HidError("absolute pointer HID device is not configured")
        self._ensure_writer("_pointer_writer", self._pointer_path, "absolute pointer")
        report = (
            bytes((self._button_mask,))
            + self._pointer_x.to_bytes(2, "little")
            + self._pointer_y.to_bytes(2, "little")
            + bytes((wheel & 0xFF,))
        )
        self._write_one(self._pointer_writer, report, "absolute pointer")

    def _ensure_writer(self, attribute: str, path: Path, name: str) -> None:
        if getattr(self, attribute) is not None:
            return
        try:
            setattr(self, attribute, self._writer_factory(path))
        except OSError as exc:
            self._state = HidState.ERROR
            raise HidError(f"failed to open {name} HID device") from exc

    def arm(self) -> None:
        if self._state is HidState.READY:
            return
        candidates = [
            ("_keyboard_writer", self._keyboard_path),
            ("_mouse_writer", self._mouse_path),
        ]
        if self._pointer_path is not None:
            candidates.append(("_pointer_writer", self._pointer_path))
        for attribute, path in candidates:
            if getattr(self, attribute) is not None:
                continue
            try:
                setattr(self, attribute, self._writer_factory(path))
            except OSError:
                continue
        if not any(getattr(self, attribute) is not None for attribute, _ in candidates):
            self._state = HidState.ERROR
            raise HidError("failed to open Linux USB Gadget HID devices")
        self._state = HidState.READY
        self.release_all()

    def key_down(self, key: str) -> None:
        self._require_ready()
        normalised = self._normalise_key(key)
        if normalised in MODIFIER_BITS:
            bit = MODIFIER_BITS[normalised]
            if self._modifier_mask & bit:
                return
            self._modifier_mask |= bit
        else:
            try:
                usage = KEY_USAGES[normalised]
            except KeyError as exc:
                raise ValueError(f"unsupported key: {key!r}") from exc
            if usage in self._pressed_keys:
                return
            if len(self._pressed_keys) >= 6:
                raise HidError("standard boot keyboard supports at most six held keys")
            self._pressed_keys.append(usage)
        self._write_keyboard()

    def key_up(self, key: str) -> None:
        self._require_ready()
        normalised = self._normalise_key(key)
        if normalised in MODIFIER_BITS:
            bit = MODIFIER_BITS[normalised]
            if not self._modifier_mask & bit:
                return
            self._modifier_mask &= ~bit
        else:
            try:
                usage = KEY_USAGES[normalised]
            except KeyError as exc:
                raise ValueError(f"unsupported key: {key!r}") from exc
            if usage not in self._pressed_keys:
                return
            self._pressed_keys.remove(usage)
        self._write_keyboard()

    def mouse_move(self, delta_x: int, delta_y: int, wheel: int = 0) -> None:
        self._require_ready()
        self._validate_axis(delta_x, "delta_x")
        self._validate_axis(delta_y, "delta_y")
        self._validate_axis(wheel, "wheel")
        if delta_x or delta_y or wheel:
            self._write_mouse(delta_x, delta_y, wheel)

    def mouse_position(self, x: int, y: int, wheel: int = 0) -> None:
        self._require_ready()
        self._validate_absolute_axis(x, "x")
        self._validate_absolute_axis(y, "y")
        self._validate_axis(wheel, "wheel")
        self._pointer_x = x
        self._pointer_y = y
        self._write_pointer(wheel)

    @staticmethod
    def _validate_absolute_axis(value: int, name: str) -> None:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"{name} must be an integer")
        if not 0 <= value <= 32767:
            raise ValueError(f"{name} must be between 0 and 32767")

    def button_down(self, button: MouseButton) -> None:
        self._require_ready()
        if not isinstance(button, MouseButton):
            raise TypeError("button must be a MouseButton")
        bit = BUTTON_BITS[button]
        if self._button_mask & bit:
            return
        self._button_mask |= bit
        if self._pointer_writer is not None:
            self._write_pointer()
        else:
            self._write_mouse()

    def button_up(self, button: MouseButton) -> None:
        self._require_ready()
        if not isinstance(button, MouseButton):
            raise TypeError("button must be a MouseButton")
        bit = BUTTON_BITS[button]
        if not self._button_mask & bit:
            return
        self._button_mask &= ~bit
        if self._pointer_writer is not None:
            self._write_pointer()
        else:
            self._write_mouse()

    def release_all(self) -> None:
        self._modifier_mask = 0
        self._pressed_keys.clear()
        self._button_mask = 0
        errors: list[HidError] = []
        if self._keyboard_writer is not None:
            try:
                self._write_one(self._keyboard_writer, bytes(8), "keyboard")
            except HidError as exc:
                errors.append(exc)
        if self._mouse_writer is not None:
            try:
                self._write_one(self._mouse_writer, bytes(4), "mouse")
            except HidError as exc:
                errors.append(exc)
        if self._pointer_writer is not None:
            try:
                self._write_pointer()
            except HidError as exc:
                errors.append(exc)
        if errors:
            self._state = HidState.ERROR
            details = "; ".join(str(error) for error in errors)
            raise HidError(f"failed to release all HID input: {details}") from errors[0]

    def emergency_stop(self) -> None:
        if self._state is HidState.STOPPED:
            return
        self.release_all()
        self._state = HidState.STOPPED

    def _close_writers(self) -> None:
        for attribute in ("_keyboard_writer", "_mouse_writer", "_pointer_writer"):
            writer = getattr(self, attribute)
            if writer is not None:
                try:
                    writer.close()
                finally:
                    setattr(self, attribute, None)

    def close(self) -> None:
        if self._state is HidState.CLOSED:
            return
        release_error: HidError | None = None
        try:
            self.release_all()
        except HidError as exc:
            release_error = exc
        finally:
            self._close_writers()
            self._state = HidState.CLOSED
        if release_error is not None:
            raise release_error
