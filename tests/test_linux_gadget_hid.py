import errno
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_ip_kvm.hid import (
    HidError,
    HidState,
    HidStoppedError,
    LinuxGadgetHidAdapter,
    MouseButton,
)
from agent_ip_kvm.hid_output_cli import main
from agent_ip_kvm.hid.linux_gadget import _FdReportWriter


class FakeWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.reports: list[bytes] = []
        self.closed = False

    def write(self, report: bytes) -> None:
        self.reports.append(report)

    def close(self) -> None:
        self.closed = True


class WriterFactory:
    def __init__(self) -> None:
        self.writers: dict[Path, FakeWriter] = {}

    def __call__(self, path: Path) -> FakeWriter:
        writer = FakeWriter(path)
        self.writers[path] = writer
        return writer


class LinuxGadgetHidAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.keyboard = Path("/dev/hidg-keyboard")
        self.mouse = Path("/dev/hidg-mouse")
        self.pointer = Path("/dev/hidg-pointer")
        self.factory = WriterFactory()
        self.adapter = LinuxGadgetHidAdapter(
            self.keyboard,
            self.mouse,
            writer_factory=self.factory,
            pointer_path=self.pointer,
        )

    def test_arm_and_release_send_only_zero_reports(self) -> None:
        self.adapter.arm()
        self.adapter.release_all()
        self.adapter.close()

        self.assertEqual(self.adapter.state, HidState.CLOSED)
        self.assertEqual(self.factory.writers[self.keyboard].reports, [bytes(8)] * 3)
        self.assertEqual(self.factory.writers[self.mouse].reports, [bytes(4)] * 3)
        self.assertEqual(self.factory.writers[self.pointer].reports, [])
        self.assertTrue(self.factory.writers[self.keyboard].closed)
        self.assertTrue(self.factory.writers[self.mouse].closed)
        self.assertTrue(self.factory.writers[self.pointer].closed)

    def test_encodes_keyboard_mouse_and_emergency_stop(self) -> None:
        self.adapter.arm()
        self.adapter.key_down("shift")
        self.adapter.key_down("a")
        self.adapter.mouse_move(10, -4, 1)
        self.adapter.mouse_position(32767, 12345, -1)
        self.adapter.button_down(MouseButton.LEFT)
        self.adapter.emergency_stop()

        keyboard_reports = self.factory.writers[self.keyboard].reports
        mouse_reports = self.factory.writers[self.mouse].reports
        pointer_reports = self.factory.writers[self.pointer].reports
        self.assertEqual(keyboard_reports[1], bytes((0x02, 0, 0, 0, 0, 0, 0, 0)))
        self.assertEqual(keyboard_reports[2], bytes((0x02, 0, 0x04, 0, 0, 0, 0, 0)))
        self.assertEqual(mouse_reports[1], bytes((0, 10, 252, 1)))
        self.assertEqual(pointer_reports[0], bytes((0, 255, 127, 57, 48, 255)))
        self.assertEqual(mouse_reports[2], bytes((1, 0, 0, 0)))
        self.assertEqual(keyboard_reports[-1], bytes(8))
        self.assertEqual(mouse_reports[-1], bytes(4))
        self.assertEqual(pointer_reports[-1], bytes((0, 255, 127, 57, 48, 255)))
        self.assertEqual(self.adapter.state, HidState.STOPPED)
        with self.assertRaises(HidStoppedError):
            self.adapter.key_down("b")

    def test_rejects_unknown_key_and_out_of_range_motion(self) -> None:
        self.adapter.arm()
        with self.assertRaises(ValueError):
            self.adapter.key_down("not-a-real-key")
        with self.assertRaises(ValueError):
            self.adapter.mouse_move(128, 0)
        with self.assertRaises(ValueError):
            self.adapter.mouse_position(32768, 0)

    def test_preserves_literal_hyphen_key_while_normalising_modifier_aliases(self) -> None:
        self.adapter.arm()
        self.adapter.key_down("-")
        self.adapter.key_up("-")
        self.adapter.key_down("left-shift")

        reports = self.factory.writers[self.keyboard].reports
        self.assertEqual(reports[1], bytes((0, 0, 0x2D, 0, 0, 0, 0, 0)))
        self.assertEqual(reports[2], bytes(8))
        self.assertEqual(reports[3], bytes((0x02, 0, 0, 0, 0, 0, 0, 0)))

    def test_open_failure_enters_error_state(self) -> None:
        def fail(_: Path) -> FakeWriter:
            raise OSError("missing")

        adapter = LinuxGadgetHidAdapter(self.keyboard, self.mouse, fail)
        with self.assertRaises(HidError):
            adapter.arm()
        self.assertEqual(adapter.state, HidState.ERROR)

    def test_pointer_only_adapter_does_not_jump_to_center_when_armed(self) -> None:
        adapter = LinuxGadgetHidAdapter(
            self.keyboard,
            None,
            writer_factory=self.factory,
            pointer_path=self.pointer,
        )

        adapter.arm()
        self.assertEqual(self.factory.writers[self.pointer].reports, [])

        adapter.mouse_position(12000, 8000)
        adapter.button_down(MouseButton.LEFT)
        adapter.button_up(MouseButton.LEFT)

        pointer_reports = self.factory.writers[self.pointer].reports
        self.assertEqual(pointer_reports[0], bytes((0, 224, 46, 64, 31, 0)))
        self.assertEqual(pointer_reports[1][0], 1)
        self.assertEqual(pointer_reports[2][0], 0)

    def test_fd_writer_retries_temporary_busy_endpoint(self) -> None:
        writer = _FdReportWriter.__new__(_FdReportWriter)
        writer._fd = 7
        busy = BlockingIOError(errno.EAGAIN, "temporarily unavailable")

        with patch(
            "agent_ip_kvm.hid.linux_gadget.os.write",
            side_effect=(busy, 4),
        ) as write, patch("agent_ip_kvm.hid.linux_gadget.time.sleep") as sleep:
            writer.write(bytes((0, 1, 2, 3)))

        self.assertEqual(write.call_count, 2)
        sleep.assert_called_once()


class HidOutputCliTests(unittest.TestCase):
    def test_cli_requires_explicit_release_only_flag(self) -> None:
        with self.assertRaises(SystemExit) as context:
            main([])
        self.assertEqual(context.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
