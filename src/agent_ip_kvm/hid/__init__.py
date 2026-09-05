"""Platform-independent HID adapters and USB Gadget discovery helpers."""

from .base import HidAdapter, HidError, HidState, HidStoppedError, MouseButton
from .config_plan import (
    CompositeGadgetPlan,
    HidConfigPlanError,
    HidFunctionPlan,
    KEYBOARD_FUNCTION,
    MOUSE_FUNCTION,
    build_composite_gadget_plan,
)
from .descriptors import BOOT_KEYBOARD_REPORT_DESCRIPTOR, RELATIVE_MOUSE_REPORT_DESCRIPTOR
from .linux_gadget import (
    LinuxGadgetHidAdapter,
    resolve_hidg_path,
    wait_for_hidg_path,
)

from .probe import (
    GadgetInfo,
    HidProbeReport,
    HidProbeStatus,
    UdcInfo,
    probe_usb_hid,
)
from .recovery import RecoveryBundle, RecoveryBundleError, write_recovery_bundle
from .simulated import SimulatedHidAdapter, SimulatedHidEvent, SimulatedEventKind

__all__ = [
    "GadgetInfo",
    "BOOT_KEYBOARD_REPORT_DESCRIPTOR",
    "CompositeGadgetPlan",
    "HidAdapter",
    "HidError",
    "HidConfigPlanError",
    "HidFunctionPlan",
    "HidProbeReport",
    "HidProbeStatus",
    "HidState",
    "HidStoppedError",
    "LinuxGadgetHidAdapter",
    "MouseButton",
    "KEYBOARD_FUNCTION",
    "MOUSE_FUNCTION",
    "RELATIVE_MOUSE_REPORT_DESCRIPTOR",
    "RecoveryBundle",
    "RecoveryBundleError",
    "SimulatedEventKind",
    "SimulatedHidAdapter",
    "SimulatedHidEvent",
    "UdcInfo",
    "build_composite_gadget_plan",
    "probe_usb_hid",
    "resolve_hidg_path",
    "wait_for_hidg_path",
    "write_recovery_bundle",
]
