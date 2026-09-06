import unittest

from agent_ip_kvm.hid import (
    BOOT_KEYBOARD_REPORT_DESCRIPTOR,
    ABSOLUTE_POINTER_REPORT_DESCRIPTOR,
    KEYBOARD_FUNCTION,
    MOUSE_FUNCTION,
    POINTER_FUNCTION,
    POWER_FUNCTION,
    RELATIVE_MOUSE_REPORT_DESCRIPTOR,
    SYSTEM_CONTROL_REPORT_DESCRIPTOR,
    GadgetInfo,
    HidProbeReport,
    HidProbeStatus,
    UdcInfo,
    build_composite_gadget_plan,
)


class HidDescriptorTests(unittest.TestCase):
    def test_standard_report_lengths_match_function_plans(self) -> None:
        self.assertEqual(KEYBOARD_FUNCTION.report_length, 8)
        self.assertEqual(MOUSE_FUNCTION.report_length, 4)
        self.assertEqual(POINTER_FUNCTION.report_length, 6)
        self.assertEqual(POWER_FUNCTION.report_length, 1)
        self.assertEqual(len(BOOT_KEYBOARD_REPORT_DESCRIPTOR), 63)
        self.assertEqual(len(RELATIVE_MOUSE_REPORT_DESCRIPTOR), 52)
        self.assertEqual(len(ABSOLUTE_POINTER_REPORT_DESCRIPTOR), 58)
        self.assertEqual(len(SYSTEM_CONTROL_REPORT_DESCRIPTOR), 27)
        self.assertEqual(BOOT_KEYBOARD_REPORT_DESCRIPTOR[-1], 0xC0)
        self.assertEqual(RELATIVE_MOUSE_REPORT_DESCRIPTOR[-2:], b"\xc0\xc0")


class CompositeGadgetPlanTests(unittest.TestCase):
    def test_preserves_existing_management_functions_and_flags_rebind(self) -> None:
        report = HidProbeReport(
            status=HidProbeStatus.IN_USE,
            message="active",
            configfs_mounted=True,
            hid_kernel_support=True,
            safe_to_modify_now=False,
            udcs=(UdcInfo("35300000.usb", "configured", "high-speed", "high-speed"),),
            gadgets=(
                GadgetInfo(
                    "g_comp",
                    "35300000.usb",
                    ("ecm.0", "mass_storage.0", "rndis.0"),
                    True,
                ),
            ),
        )

        plan = build_composite_gadget_plan(report)

        self.assertEqual(plan.gadget_name, "g_comp")
        self.assertEqual(
            plan.planned_functions,
            ("ecm.0", "mass_storage.0", "rndis.0", "hid.keyboard", "hid.mouse", "hid.pointer", "hid.power"),
        )
        self.assertTrue(plan.retains_management_network)
        self.assertTrue(plan.requires_rebind)
        self.assertTrue(plan.requires_local_recovery)
        self.assertTrue(plan.as_dict()["generated_only"])


if __name__ == "__main__":
    unittest.main()
