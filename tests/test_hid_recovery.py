import json
import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.hid import (
    GadgetInfo,
    HidProbeReport,
    HidProbeStatus,
    RecoveryBundleError,
    UdcInfo,
    build_composite_gadget_plan,
    write_recovery_bundle,
)


def _rdk_plan():
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
    return build_composite_gadget_plan(report)


class HidRecoveryBundleTests(unittest.TestCase):
    def test_writes_guarded_recovery_bundle_with_temporary_apply(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "recovery"
            bundle = write_recovery_bundle(_rdk_plan(), output)

            manifest = json.loads(bundle.manifest.read_text(encoding="utf-8"))
            preflight = bundle.preflight_script.read_text(encoding="utf-8")
            rollback = bundle.rollback_script.read_text(encoding="utf-8")
            temporary_apply = bundle.temporary_apply_script.read_text(encoding="utf-8")
            instructions = bundle.instructions.read_text(encoding="utf-8")

            self.assertTrue(manifest["generated_only"])
            self.assertEqual(manifest["configuration_name"], "c.1")
            self.assertIn("READ ONLY", preflight)
            self.assertIn('MODE="${1:---dry-run}"', rollback)
            self.assertIn("--apply requires root", rollback)
            self.assertIn("hid.keyboard", rollback)
            self.assertIn("hid.mouse", rollback)
            self.assertIn("hid.pointer", rollback)
            self.assertIn("不依赖 USB QuickLink", instructions)
            self.assertIn('MODE="${1:---dry-run}"', temporary_apply)
            self.assertIn("nohup sh -c", temporary_apply)
            self.assertLess(
                temporary_apply.index("nohup sh -c"),
                temporary_apply.index('printf \'\\n\' > "$GADGET/UDC"'),
            )
            self.assertIn("No keyboard or mouse report was sent", temporary_apply)
            self.assertIn('ln -s functions/hid.keyboard "configs/$CONFIGURATION"', temporary_apply)
            self.assertIn('ln -s functions/hid.pointer "configs/$CONFIGURATION"', temporary_apply)
            self.assertIn('if [ -n "$CURRENT_UDC" ]', rollback)
            self.assertIn('rm -- "$OS_DESC_LINK"', rollback)
            self.assertIn('ln -s "configs/$CONFIGURATION" os_desc', rollback)
            self.assertIn('enabled OS descriptor configuration link is missing', temporary_apply)
            self.assertEqual(bundle.keyboard_descriptor.read_bytes(), _rdk_plan().hid_functions[0].report_descriptor)
            self.assertEqual(bundle.mouse_descriptor.read_bytes(), _rdk_plan().hid_functions[1].report_descriptor)
            self.assertEqual(bundle.pointer_descriptor.read_bytes(), _rdk_plan().hid_functions[2].report_descriptor)

    def test_refuses_to_overwrite_nonempty_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "recovery"
            output.mkdir()
            (output / "keep.txt").write_text("keep", encoding="utf-8")
            with self.assertRaises(RecoveryBundleError):
                write_recovery_bundle(_rdk_plan(), output)


if __name__ == "__main__":
    unittest.main()
