"""In-memory HID adapter for safe development without connected hardware."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .base import HidAdapter, HidError, HidState, HidStoppedError, MouseButton


class SimulatedEventKind(str, Enum):
    ARMED = "armed"
    KEY_DOWN = "key_down"
    KEY_UP = "key_up"
    MOUSE_MOVE = "mouse_move"
    BUTTON_DOWN = "button_down"
    BUTTON_UP = "button_up"
    RELEASE_ALL = "release_all"
    EMERGENCY_STOP = "emergency_stop"
    CLOSED = "closed"


@dataclass(frozen=True, slots=True)
class SimulatedHidEvent:
    sequence: int
    kind: SimulatedEventKind
    key: str | None = None
    button: MouseButton | None = None
    delta_x: int = 0
    delta_y: int = 0
    wheel: int = 0


class SimulatedHidAdapter(HidAdapter):
    """Record HID actions in memory while enforcing the real safety lifecycle."""

    def __init__(self) -> None:
        self._state = HidState.CLOSED
        self._pressed_keys: set[str] = set()
        self._pressed_buttons: set[MouseButton] = set()
        self._events: list[SimulatedHidEvent] = []
        self._next_sequence = 0

    @property
    def state(self) -> HidState:
        return self._state

    @property
    def pressed_keys(self) -> frozenset[str]:
        return frozenset(self._pressed_keys)

    @property
    def pressed_buttons(self) -> frozenset[MouseButton]:
        return frozenset(self._pressed_buttons)

    @property
    def events(self) -> tuple[SimulatedHidEvent, ...]:
        return tuple(self._events)

    def _record(self, kind: SimulatedEventKind, **values: object) -> None:
        self._events.append(
            SimulatedHidEvent(sequence=self._next_sequence, kind=kind, **values)
        )
        self._next_sequence += 1

    def _require_ready(self) -> None:
        if self._state is HidState.STOPPED:
            raise HidStoppedError("emergency stop is active; call arm() before sending input")
        if self._state is not HidState.READY:
            raise HidError("HID adapter is closed; call arm() before sending input")

    @staticmethod
    def _normalise_key(key: str) -> str:
        normalised = key.strip().lower()
        if not normalised:
            raise ValueError("key must not be empty")
        return normalised

    @staticmethod
    def _validate_axis(value: int, name: str) -> None:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"{name} must be an integer")
        if not -127 <= value <= 127:
            raise ValueError(f"{name} must be between -127 and 127")

    def arm(self) -> None:
        if self._state is HidState.READY:
            return
        self._pressed_keys.clear()
        self._pressed_buttons.clear()
        self._state = HidState.READY
        self._record(SimulatedEventKind.ARMED)

    def key_down(self, key: str) -> None:
        self._require_ready()
        normalised = self._normalise_key(key)
        if normalised in self._pressed_keys:
            return
        self._pressed_keys.add(normalised)
        self._record(SimulatedEventKind.KEY_DOWN, key=normalised)

    def key_up(self, key: str) -> None:
        self._require_ready()
        normalised = self._normalise_key(key)
        if normalised not in self._pressed_keys:
            return
        self._pressed_keys.remove(normalised)
        self._record(SimulatedEventKind.KEY_UP, key=normalised)

    def mouse_move(self, delta_x: int, delta_y: int, wheel: int = 0) -> None:
        self._require_ready()
        self._validate_axis(delta_x, "delta_x")
        self._validate_axis(delta_y, "delta_y")
        self._validate_axis(wheel, "wheel")
        if delta_x == 0 and delta_y == 0 and wheel == 0:
            return
        self._record(
            SimulatedEventKind.MOUSE_MOVE,
            delta_x=delta_x,
            delta_y=delta_y,
            wheel=wheel,
        )

    def button_down(self, button: MouseButton) -> None:
        self._require_ready()
        if not isinstance(button, MouseButton):
            raise TypeError("button must be a MouseButton")
        if button in self._pressed_buttons:
            return
        self._pressed_buttons.add(button)
        self._record(SimulatedEventKind.BUTTON_DOWN, button=button)

    def button_up(self, button: MouseButton) -> None:
        self._require_ready()
        if not isinstance(button, MouseButton):
            raise TypeError("button must be a MouseButton")
        if button not in self._pressed_buttons:
            return
        self._pressed_buttons.remove(button)
        self._record(SimulatedEventKind.BUTTON_UP, button=button)

    def release_all(self) -> None:
        had_input = bool(self._pressed_keys or self._pressed_buttons)
        self._pressed_keys.clear()
        self._pressed_buttons.clear()
        if had_input:
            self._record(SimulatedEventKind.RELEASE_ALL)

    def emergency_stop(self) -> None:
        if self._state is HidState.STOPPED:
            return
        self.release_all()
        self._state = HidState.STOPPED
        self._record(SimulatedEventKind.EMERGENCY_STOP)

    def close(self) -> None:
        if self._state is HidState.CLOSED:
            return
        self.release_all()
        self._state = HidState.CLOSED
        self._record(SimulatedEventKind.CLOSED)
