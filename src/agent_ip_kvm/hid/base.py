"""Platform-independent contract for keyboard and mouse output adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum


class HidState(str, Enum):
    READY = "ready"
    STOPPED = "stopped"
    CLOSED = "closed"
    ERROR = "error"


class MouseButton(str, Enum):
    LEFT = "left"
    RIGHT = "right"
    MIDDLE = "middle"
    BACK = "back"
    FORWARD = "forward"


class HidError(RuntimeError):
    """A HID adapter could not complete an operation."""


class HidStoppedError(HidError):
    """Input was rejected because the emergency stop is active."""


class HidAdapter(ABC):
    """Common safety contract implemented by every HID output backend."""

    @property
    @abstractmethod
    def state(self) -> HidState:
        """Return whether this adapter accepts input."""

    @abstractmethod
    def key_down(self, key: str) -> None:
        """Press one named key and keep it held until released."""

    @abstractmethod
    def key_up(self, key: str) -> None:
        """Release one named key."""

    @abstractmethod
    def mouse_move(self, delta_x: int, delta_y: int, wheel: int = 0) -> None:
        """Send one relative mouse movement and optional wheel movement."""

    def mouse_position(self, x: int, y: int, wheel: int = 0) -> None:
        """Place the pointer at absolute coordinates in the 0..32767 range."""
        raise HidError("absolute pointer output is not available")

    @abstractmethod
    def button_down(self, button: MouseButton) -> None:
        """Press one mouse button and keep it held until released."""

    @abstractmethod
    def button_up(self, button: MouseButton) -> None:
        """Release one mouse button."""

    @abstractmethod
    def release_all(self) -> None:
        """Release every held key and mouse button; repeated calls are safe."""

    @abstractmethod
    def emergency_stop(self) -> None:
        """Release all input and reject new actions until explicitly armed."""

    @abstractmethod
    def arm(self) -> None:
        """Explicitly allow input after construction or an emergency stop."""

    @abstractmethod
    def close(self) -> None:
        """Release all input and close the adapter; repeated calls are safe."""

    def __enter__(self) -> HidAdapter:
        self.arm()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()
