import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.hid import HidProbeStatus, probe_usb_hid


class HidProbeTests(unittest.TestCase):
    def test_reports_unsupported_platform(self) -> None:
        report = probe_usb_hid(platform_name="Windows")
        self.assertEqual(report.status, HidProbeStatus.UNSUPPORTED_PLATFORM)
        self.assertFalse(report.safe_to_modify_now)

    def test_reports_missing_udc(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "proc").mkdir()
            (root / "proc" / "mounts").write_text("configfs /sys/kernel/config configfs rw 0 0\n")
            report = probe_usb_hid(
                platform_name="Linux",
                sys_root=root / "sys",
                proc_root=root / "proc",
                boot_root=root / "boot",
                kernel_release="test",
            )
        self.assertEqual(report.status, HidProbeStatus.NO_UDC)

    def test_detects_bound_management_gadget(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            udc = root / "sys" / "class" / "udc" / "35300000.usb"
            udc.mkdir(parents=True)
            (udc / "state").write_text("configured\n")
            (udc / "current_speed").write_text("high-speed\n")
            (udc / "maximum_speed").write_text("high-speed\n")

            gadget = root / "sys" / "kernel" / "config" / "usb_gadget" / "g_comp"
            (gadget / "functions" / "rndis.0").mkdir(parents=True)
            (gadget / "functions" / "ecm.0").mkdir()
            (gadget / "UDC").write_text("35300000.usb\n")

            (root / "proc").mkdir()
            (root / "proc" / "mounts").write_text("configfs /sys/kernel/config configfs rw 0 0\n")
            (root / "boot").mkdir()
            (root / "boot" / "config-test").write_text("CONFIG_USB_CONFIGFS_F_HID=y\n")

            report = probe_usb_hid(
                platform_name="Linux",
                sys_root=root / "sys",
                proc_root=root / "proc",
                boot_root=root / "boot",
                kernel_release="test",
            )

        self.assertEqual(report.status, HidProbeStatus.IN_USE)
        self.assertTrue(report.hid_kernel_support)
        self.assertFalse(report.safe_to_modify_now)
        self.assertTrue(report.gadgets[0].carries_management_network)
        self.assertEqual(report.gadgets[0].functions, ("ecm.0", "rndis.0"))


if __name__ == "__main__":
    unittest.main()
