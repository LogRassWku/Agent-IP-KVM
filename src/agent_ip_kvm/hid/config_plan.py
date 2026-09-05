"""Generate a declarative ConfigFS HID plan without changing the system."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .descriptors import (
    ABSOLUTE_POINTER_REPORT_DESCRIPTOR,
    BOOT_KEYBOARD_REPORT_DESCRIPTOR,
    RELATIVE_MOUSE_REPORT_DESCRIPTOR,
)
from .probe import GadgetInfo, HidProbeReport, HidProbeStatus


class HidConfigPlanError(RuntimeError):
    """A safe offline plan cannot be generated from the probe result."""


@dataclass(frozen=True, slots=True)
class HidFunctionPlan:
    name: str
    role: str
    protocol: int
    subclass: int
    report_length: int
    report_descriptor: bytes

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "role": self.role,
            "protocol": self.protocol,
            "subclass": self.subclass,
            "report_length": self.report_length,
            "report_descriptor_size": len(self.report_descriptor),
            "report_descriptor_sha256": hashlib.sha256(self.report_descriptor).hexdigest(),
            "report_descriptor_hex": self.report_descriptor.hex(),
        }


KEYBOARD_FUNCTION = HidFunctionPlan(
    name="hid.keyboard",
    role="boot_keyboard",
    protocol=1,
    subclass=1,
    report_length=8,
    report_descriptor=BOOT_KEYBOARD_REPORT_DESCRIPTOR,
)

MOUSE_FUNCTION = HidFunctionPlan(
    name="hid.mouse",
    role="relative_mouse",
    protocol=2,
    subclass=1,
    report_length=4,
    report_descriptor=RELATIVE_MOUSE_REPORT_DESCRIPTOR,
)

POINTER_FUNCTION = HidFunctionPlan(
    name="hid.pointer",
    role="absolute_pointer",
    protocol=0,
    subclass=0,
    report_length=6,
    report_descriptor=ABSOLUTE_POINTER_REPORT_DESCRIPTOR,
)


@dataclass(frozen=True, slots=True)
class CompositeGadgetPlan:
    gadget_name: str
    udc: str
    existing_functions: tuple[str, ...]
    planned_functions: tuple[str, ...]
    hid_functions: tuple[HidFunctionPlan, ...]
    retains_management_network: bool
    requires_rebind: bool
    requires_local_recovery: bool
    warnings: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "generated_only": True,
            "gadget_name": self.gadget_name,
            "udc": self.udc,
            "existing_functions": list(self.existing_functions),
            "planned_functions": list(self.planned_functions),
            "hid_functions": [function.as_dict() for function in self.hid_functions],
            "retains_management_network": self.retains_management_network,
            "requires_rebind": self.requires_rebind,
            "requires_local_recovery": self.requires_local_recovery,
            "warnings": list(self.warnings),
        }


def _select_gadget(report: HidProbeReport, gadget_name: str | None) -> GadgetInfo | None:
    if gadget_name is not None:
        for gadget in report.gadgets:
            if gadget.name == gadget_name:
                return gadget
        raise HidConfigPlanError(f"gadget {gadget_name!r} was not found")
    if len(report.gadgets) == 1:
        return report.gadgets[0]
    if len(report.gadgets) > 1:
        raise HidConfigPlanError("multiple gadgets were found; select one by name")
    return None


def build_composite_gadget_plan(
    report: HidProbeReport,
    *,
    gadget_name: str | None = None,
) -> CompositeGadgetPlan:
    """Build a JSON-ready plan; this function performs no filesystem writes."""

    if report.status in {
        HidProbeStatus.UNSUPPORTED_PLATFORM,
        HidProbeStatus.NO_UDC,
        HidProbeStatus.CONFIGFS_UNAVAILABLE,
    }:
        raise HidConfigPlanError(report.message)
    if report.hid_kernel_support is False:
        raise HidConfigPlanError("the running kernel does not enable ConfigFS HID")

    selected = _select_gadget(report, gadget_name)
    existing_functions = selected.functions if selected else ()
    planned_functions = tuple(
        dict.fromkeys(
            (
                *existing_functions,
                KEYBOARD_FUNCTION.name,
                MOUSE_FUNCTION.name,
                POINTER_FUNCTION.name,
            )
        )
    )
    udc = selected.udc if selected and selected.udc else report.udcs[0].name
    requires_rebind = bool(selected and selected.udc)
    retains_management_network = bool(selected and selected.carries_management_network)
    requires_local_recovery = requires_rebind and retains_management_network

    warnings: list[str] = []
    if report.hid_kernel_support is None:
        warnings.append("kernel HID support could not be confirmed from the readable kernel config")
    if requires_rebind:
        warnings.append("applying this plan requires USB disconnect and re-enumeration")
    if requires_local_recovery:
        warnings.append("the active gadget carries management networking; prepare local recovery first")

    return CompositeGadgetPlan(
        gadget_name=selected.name if selected else gadget_name or "agent_ip_kvm",
        udc=udc,
        existing_functions=existing_functions,
        planned_functions=planned_functions,
        hid_functions=(KEYBOARD_FUNCTION, MOUSE_FUNCTION, POINTER_FUNCTION),
        retains_management_network=retains_management_network,
        requires_rebind=requires_rebind,
        requires_local_recovery=requires_local_recovery,
        warnings=tuple(warnings),
    )
