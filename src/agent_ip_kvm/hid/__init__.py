"""Platform-independent HID adapters and USB Gadget discovery helpers."""

from .base import HidAdapter, HidError, HidState, HidStoppedError, MouseButton

from .probe import (
    GadgetInfo,
    HidProbeReport,
    HidProbeStatus,
    UdcInfo,
    probe_usb_hid,
)
from .simulated import SimulatedHidAdapter, SimulatedHidEvent, SimulatedEventKind

__all__ = [
    "GadgetInfo",
    "HidAdapter",
    "HidError",
    "HidProbeReport",
    "HidProbeStatus",
    "HidState",
    "HidStoppedError",
    "MouseButton",
    "SimulatedEventKind",
    "SimulatedHidAdapter",
    "SimulatedHidEvent",
    "UdcInfo",
    "probe_usb_hid",
]
