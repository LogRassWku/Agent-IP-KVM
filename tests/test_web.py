import json
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from agent_ip_kvm.hid import SimulatedEventKind, SimulatedHidAdapter
from agent_ip_kvm.video import EndOfStream, Frame, SourceCapability, SourceHealth
from agent_ip_kvm.web import (
    AutoLinuxHidController,
    HidWebController,
    VideoStreamController,
    WebConfig,
    create_server,
)


class StaticStream:
    def frames(self):
        yield 7, b"\xff\xd8test\xff\xd9"

    def status(self):
        return {"state": "streaming", "message": "test", "sequence": 7, "error": None}

    def close(self):
        pass


class FiniteSource:
    source_id = "test:finite"

    def __init__(self):
        self.sent = False

    def capabilities(self):
        return (SourceCapability(1, 1, 30.0, "RGB24"),)

    def open(self, capability=None):
        return self.capabilities()[0]

    def start(self):
        pass

    def next_frame(self):
        if self.sent:
            raise EndOfStream("done")
        self.sent = True
        return Frame(1, 1, "RGB24", b"\x00\x00\x00", 0, 1)

    def stop(self):
        pass

    def close(self):
        pass

    def health(self):
        return SourceHealth.STREAMING


class PassthroughEncoder:
    def __init__(self, width, height, fps):
        pass

    def encode(self, frame):
        return b"\xff\xd8frame\xff\xd9"

    def close(self):
        pass


class WebInterfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = create_server("127.0.0.1", 0, WebConfig())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_serves_page_and_structured_status(self) -> None:
        with urlopen(f"{self.base_url}/", timeout=2) as response:
            page = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("Agent IP KVM", page)
            self.assertNotIn('class="brand"', page)
            self.assertNotIn('class="brand-name"', page)
            self.assertIn('id="agent-mode-button"', page)
            self.assertIn('id="agent-shell"', page)
            self.assertIn('id="agent-composer"', page)
            self.assertIn('id="agent-input"', page)
            self.assertIn('id="agent-sidebar"', page)
            self.assertIn('id="new-agent-chat"', page)
            self.assertIn('id="agent-session-list"', page)
            self.assertIn('id="agent-chat-title"', page)
            self.assertIn('id="agent-model-button"', page)
            self.assertIn('id="agent-model-menu"', page)
            self.assertNotIn('id="agent-model-select"', page)
            self.assertNotIn('class="agent-suggestions"', page)
            self.assertNotIn('id="mouse-button"', page)
            self.assertIn('id="keyboard-button"', page)
            self.assertIn('id="screen-button"', page)
            self.assertIn('id="screen-menu"', page)
            self.assertIn('id="power-button"', page)
            self.assertIn('id="power-menu"', page)
            self.assertIn('class="zoom-buttons"', page)
            self.assertIn('id="zoom-out"', page)
            self.assertIn('id="zoom-in"', page)
            self.assertNotIn('id="zoom-range"', page)
            self.assertNotIn('id="cursor-size-select"', page)
            self.assertNotIn('id="mouse-capture"', page)
            self.assertIn('id="onscreen-keyboard"', page)
            self.assertIn('id="sticky-keys"', page)
            self.assertNotIn('id="release-keys"', page)
            self.assertNotIn('class="keyboard-heading"', page)
            self.assertIn('data-key="enter"', page)
            self.assertIn('id="resolution-select"', page)
            self.assertIn('id="refresh-rate-select"', page)
            self.assertNotIn('id="fullscreen-button"', page)
            self.assertIn("键盘", page)
            self.assertIn("屏幕", page)
            self.assertIn('id="settings-panel"', page)
            self.assertIn('id="host-info-list"', page)
            self.assertIn('id="host-info-state"', page)
            self.assertIn('id="host-storage"', page)
            self.assertIn('id="video-frame"', page)
            self.assertIn("No Signal", page)
            self.assertNotIn("暂无视频画面", page)
            self.assertNotIn('id="connection"', page)

        with urlopen(f"{self.base_url}/api/status", timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["source"]["backend"], "synthetic")
            self.assertEqual(payload["source"]["health"], "available")
            self.assertEqual(payload["stream"]["state"], "idle")
            self.assertEqual(payload["hid"]["state"], "disabled")
            self.assertFalse(payload["hid"]["enabled"])
            self.assertFalse(payload["power"]["available"])
            self.assertEqual(payload["power"]["mode"], "unconfigured")

    def test_power_endpoint_reports_unconfigured_hardware(self) -> None:
        request = Request(
            f"{self.base_url}/api/power",
            data=json.dumps({"action": "wake"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=2)
        self.assertEqual(caught.exception.code, 501)
        payload = json.load(caught.exception)
        self.assertIn("电源控制线", payload["error"])

    def test_hid_controller_taps_and_releases_one_key(self) -> None:
        adapter = SimulatedHidAdapter()
        controller = HidWebController(adapter, backend="simulated")

        result = controller.tap_key({"key": "a", "modifiers": ["shift"]})

        self.assertEqual(result, {"key": "a", "modifiers": ["shift"]})
        self.assertEqual(
            [event.kind for event in adapter.events],
            [
                SimulatedEventKind.ARMED,
                SimulatedEventKind.KEY_DOWN,
                SimulatedEventKind.KEY_DOWN,
                SimulatedEventKind.KEY_UP,
                SimulatedEventKind.KEY_UP,
            ],
        )
        self.assertEqual(adapter.pressed_keys, frozenset())

    def test_hid_controller_taps_standalone_modifier(self) -> None:
        adapter = SimulatedHidAdapter()
        controller = HidWebController(adapter, backend="simulated")

        result = controller.tap_key({"key": "win", "modifiers": []})

        self.assertEqual(result, {"key": "win", "modifiers": []})
        self.assertEqual(
            [event.kind for event in adapter.events],
            [
                SimulatedEventKind.ARMED,
                SimulatedEventKind.KEY_DOWN,
                SimulatedEventKind.KEY_UP,
            ],
        )
        self.assertEqual(adapter.pressed_keys, frozenset())

    def test_hid_controller_types_bounded_ascii_command(self) -> None:
        adapter = SimulatedHidAdapter()
        controller = HidWebController(adapter, backend="simulated")

        command = "PowerShell -c \"irm 'http://127.0.0.1/a.ps1'\""
        result = controller.type_text(command, key_delay=0)

        self.assertEqual(result["characters"], len(command))
        self.assertEqual(adapter.pressed_keys, frozenset())
        self.assertGreater(len(adapter.events), 47 * 2)

        with self.assertRaisesRegex(ValueError, "unsupported character"):
            controller.type_text("包含中文", key_delay=0)

    def test_hid_controller_rejects_unknown_keys_before_output(self) -> None:
        adapter = SimulatedHidAdapter()
        controller = HidWebController(adapter, backend="simulated")

        with self.assertRaisesRegex(ValueError, "unsupported key"):
            controller.tap_key({"key": "power", "modifiers": []})

        self.assertEqual(adapter.events, ())

    def test_hid_controller_maps_relative_mouse_and_click(self) -> None:
        adapter = SimulatedHidAdapter()
        controller = HidWebController(adapter, backend="simulated")

        movement = controller.move_mouse(
            {"delta_x": 200, "delta_y": -140, "wheel": 1}
        )
        click = controller.click_mouse({"button": "left"})

        self.assertEqual(movement, {"delta_x": 200, "delta_y": -140, "wheel": 1})
        self.assertEqual(click, {"button": "left"})
        self.assertEqual(
            [event.kind for event in adapter.events],
            [
                SimulatedEventKind.ARMED,
                SimulatedEventKind.MOUSE_MOVE,
                SimulatedEventKind.MOUSE_MOVE,
                SimulatedEventKind.MOUSE_MOVE,
                SimulatedEventKind.BUTTON_DOWN,
                SimulatedEventKind.BUTTON_UP,
            ],
        )
        self.assertEqual(adapter.pressed_buttons, frozenset())

    def test_hid_controller_maps_absolute_pointer_position(self) -> None:
        adapter = SimulatedHidAdapter()
        controller = HidWebController(adapter, backend="simulated")

        position = controller.position_mouse({"x": 16384, "y": 8192, "wheel": -1})

        self.assertEqual(position, {"x": 16384, "y": 8192, "wheel": -1})
        self.assertEqual(adapter.events[-1].kind, SimulatedEventKind.MOUSE_POSITION)
        self.assertEqual((adapter.events[-1].x, adapter.events[-1].y), (16384, 8192))

    def test_auto_hid_controller_tracks_endpoint_connection(self) -> None:
        current = {"devices": None}
        adapters = []

        def resolver():
            return current["devices"]

        def factory(keyboard, mouse, pointer):
            adapter = SimulatedHidAdapter()
            adapters.append(adapter)
            return adapter

        controller = AutoLinuxHidController(resolver, factory)
        self.assertEqual(controller.status()["state"], "disconnected")

        current["devices"] = ("keyboard", None, "pointer")
        self.assertTrue(controller.status()["enabled"])
        controller.tap_key({"key": "a", "modifiers": []})
        self.assertEqual(adapters[0].pressed_keys, frozenset())

        current["devices"] = None
        self.assertEqual(controller.status()["state"], "disconnected")
        self.assertFalse(controller.status()["enabled"])

    def test_auto_hid_controller_supports_relative_mouse_without_absolute_pointer(self) -> None:
        current = {"devices": ("keyboard", "mouse", None)}

        def factory(keyboard, mouse, pointer):
            self.assertEqual((keyboard, mouse, pointer), ("keyboard", "mouse", None))
            return SimulatedHidAdapter()

        controller = AutoLinuxHidController(lambda: current["devices"], factory)
        self.assertTrue(controller.status()["enabled"])
        self.assertEqual(
            controller.move_mouse({"delta_x": 4, "delta_y": -3, "wheel": 0}),
            {"delta_x": 4, "delta_y": -3, "wheel": 0},
        )

    def test_web_hid_key_endpoint_uses_explicit_adapter(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        adapter = SimulatedHidAdapter()
        self.server = create_server(
            "127.0.0.1",
            0,
            WebConfig(),
            hid_adapter=adapter,
            hid_backend="simulated",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        request = Request(
            f"{self.base_url}/api/hid/key",
            data=json.dumps({"key": "enter", "modifiers": []}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["hid"]["key"], "enter")

        request = Request(
            f"{self.base_url}/api/hid/mouse-move",
            data=json.dumps(
                {"delta_x": 12, "delta_y": -8, "wheel": 1}
            ).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["hid"]["delta_x"], 12)

        request = Request(
            f"{self.base_url}/api/hid/mouse-position",
            data=json.dumps({"x": 32767, "y": 0, "wheel": 0}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["hid"]["x"], 32767)

        request = Request(
            f"{self.base_url}/api/hid/mouse-click",
            data=json.dumps({"button": "left"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["hid"]["button"], "left")

        self.assertEqual(adapter.pressed_keys, frozenset())
        self.assertEqual(adapter.pressed_buttons, frozenset())

    def test_web_hid_rejects_cross_origin_requests(self) -> None:
        request = Request(
            f"{self.base_url}/api/hid/key",
            data=json.dumps({"key": "enter", "modifiers": []}).encode(),
            headers={
                "Content-Type": "application/json",
                "Origin": "https://example.invalid",
            },
            method="POST",
        )

        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=2)
        self.assertEqual(caught.exception.code, 403)

    def test_serves_mjpeg_frames(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        from agent_ip_kvm.web import create_handler
        from http.server import ThreadingHTTPServer

        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            create_handler(WebConfig(), stream_provider=StaticStream()),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

        with urlopen(f"{self.base_url}/api/stream.mjpg", timeout=2) as response:
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "multipart/x-mixed-replace")
            self.assertIn(b"Content-Type: image/jpeg", body)
            self.assertIn(b"X-Sequence: 7", body)
            self.assertIn(b"\xff\xd8test\xff\xd9", body)

    def test_accepts_supported_video_setting_update(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        from agent_ip_kvm.web import create_handler
        from http.server import ThreadingHTTPServer

        updates = []

        def update(payload):
            updates.append(payload)
            return payload

        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            create_handler(
                WebConfig(),
                stream_provider=StaticStream(),
                settings_updater=update,
            ),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        request = Request(
            f"{self.base_url}/api/video-settings",
            data=json.dumps({"width": 1280, "height": 720, "fps": 60}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["video"]["fps"], 60)
        self.assertEqual(updates, [{"width": 1280, "height": 720, "fps": 60}])

    def test_stream_controller_reports_file_end_after_last_frame(self) -> None:
        controller = VideoStreamController(
            WebConfig(),
            source_factory=lambda config: FiniteSource(),
            encoder_factory=PassthroughEncoder,
        )
        self.assertEqual(list(controller.frames()), [(0, b"\xff\xd8frame\xff\xd9")])
        self.assertEqual(controller.status()["state"], "ended")

    def test_stream_controller_pause_discards_frame_and_can_restart(self) -> None:
        controller = VideoStreamController(
            WebConfig(),
            source_factory=lambda config: FiniteSource(),
            encoder_factory=PassthroughEncoder,
        )
        self.assertEqual(next(controller.frames()), (0, b"\xff\xd8frame\xff\xd9"))

        controller.pause()

        self.assertEqual(controller.status()["state"], "idle")
        self.assertIsNone(controller.status()["sequence"])
        self.assertEqual(list(controller.frames()), [(0, b"\xff\xd8frame\xff\xd9")])
        controller.close()


if __name__ == "__main__":
    unittest.main()
