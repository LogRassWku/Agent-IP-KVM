import json
import threading
import unittest
from urllib.request import Request, urlopen

from agent_ip_kvm.video import EndOfStream, Frame, SourceCapability, SourceHealth
from agent_ip_kvm.web import VideoStreamController, WebConfig, create_server


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
            self.assertIn('id="mouse-button"', page)
            self.assertIn('id="keyboard-button"', page)
            self.assertIn('id="screen-button"', page)
            self.assertIn('id="screen-menu"', page)
            self.assertIn('id="resolution-select"', page)
            self.assertIn('id="refresh-rate-select"', page)
            self.assertNotIn('id="fullscreen-button"', page)
            self.assertIn("鼠标", page)
            self.assertIn("键盘", page)
            self.assertIn("屏幕", page)
            self.assertIn('id="settings-panel"', page)
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


if __name__ == "__main__":
    unittest.main()
