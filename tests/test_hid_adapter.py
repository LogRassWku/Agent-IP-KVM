import unittest

from agent_ip_kvm.hid import (
    HidState,
    HidStoppedError,
    MouseButton,
    SimulatedEventKind,
    SimulatedHidAdapter,
)


class SimulatedHidAdapterTests(unittest.TestCase):
    def test_records_keyboard_and_mouse_without_hardware(self) -> None:
        adapter = SimulatedHidAdapter()
        adapter.arm()
        adapter.key_down("Shift")
        adapter.key_down("A")
        adapter.mouse_move(12, -4, 1)
        adapter.button_down(MouseButton.LEFT)
        adapter.key_up("a")

        self.assertEqual(adapter.pressed_keys, frozenset({"shift"}))
        self.assertEqual(adapter.pressed_buttons, frozenset({MouseButton.LEFT}))
        self.assertEqual(
            [event.kind for event in adapter.events],
            [
                SimulatedEventKind.ARMED,
                SimulatedEventKind.KEY_DOWN,
                SimulatedEventKind.KEY_DOWN,
                SimulatedEventKind.MOUSE_MOVE,
                SimulatedEventKind.BUTTON_DOWN,
                SimulatedEventKind.KEY_UP,
            ],
        )

    def test_emergency_stop_releases_everything_and_blocks_input(self) -> None:
        adapter = SimulatedHidAdapter()
        adapter.arm()
        adapter.key_down("ctrl")
        adapter.button_down(MouseButton.RIGHT)

        adapter.emergency_stop()

        self.assertEqual(adapter.state, HidState.STOPPED)
        self.assertFalse(adapter.pressed_keys)
        self.assertFalse(adapter.pressed_buttons)
        self.assertEqual(adapter.events[-2].kind, SimulatedEventKind.RELEASE_ALL)
        self.assertEqual(adapter.events[-1].kind, SimulatedEventKind.EMERGENCY_STOP)
        with self.assertRaises(HidStoppedError):
            adapter.key_down("enter")

    def test_close_releases_input_even_when_context_fails(self) -> None:
        adapter = SimulatedHidAdapter()

        with self.assertRaisesRegex(RuntimeError, "test failure"):
            with adapter:
                adapter.key_down("alt")
                adapter.button_down(MouseButton.MIDDLE)
                raise RuntimeError("test failure")

        self.assertEqual(adapter.state, HidState.CLOSED)
        self.assertFalse(adapter.pressed_keys)
        self.assertFalse(adapter.pressed_buttons)
        self.assertEqual(adapter.events[-2].kind, SimulatedEventKind.RELEASE_ALL)
        self.assertEqual(adapter.events[-1].kind, SimulatedEventKind.CLOSED)

    def test_motion_is_limited_to_one_standard_relative_report(self) -> None:
        adapter = SimulatedHidAdapter()
        adapter.arm()

        with self.assertRaises(ValueError):
            adapter.mouse_move(128, 0)
        with self.assertRaises(TypeError):
            adapter.mouse_move(True, 0)


if __name__ == "__main__":
    unittest.main()
