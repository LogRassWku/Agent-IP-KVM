import unittest
from pathlib import Path

from agent_ip_kvm.hid import (
    HidError,
    HidState,
    HidStoppedError,
    LinuxGadgetHidAdapter,
    MouseButton,
)
from agent_ip_kvm.hid_output_cli import main


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
        center = bytes((0, 0, 64, 0, 64, 0))
        self.assertEqual(self.factory.writers[self.pointer].reports, [center] * 3)
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
        self.assertEqual(pointer_reports[1], bytes((0, 255, 127, 57, 48, 255)))
        self.assertEqual(pointer_reports[2], bytes((1, 255, 127, 57, 48, 0)))
        self.assertEqual(keyboard_reports[-1], bytes(8))
        self.assertEqual(mouse_reports[-1], bytes(4))
        self.assertEqual(pointer_reports[-1], bytes((0, 255, 127, 57, 48, 0)))
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

    def test_open_failure_enters_error_state(self) -> None:
        def fail(_: Path) -> FakeWriter:
            raise OSError("missing")

        adapter = LinuxGadgetHidAdapter(self.keyboard, self.mouse, fail)
        with self.assertRaises(HidError):
            adapter.arm()
        self.assertEqual(adapter.state, HidState.ERROR)


class HidOutputCliTests(unittest.TestCase):
    def test_cli_requires_explicit_release_only_flag(self) -> None:
        with self.assertRaises(SystemExit) as context:
            main([])
        self.assertEqual(context.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
