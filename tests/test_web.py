import json
import threading
import unittest
from urllib.request import urlopen

from agent_ip_kvm.web import WebConfig, create_server


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
            self.assertIn('id="settings-panel"', page)

        with urlopen(f"{self.base_url}/api/status", timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["source"]["backend"], "synthetic")
            self.assertEqual(payload["source"]["health"], "available")
            self.assertEqual(payload["stream"]["state"], "idle")


if __name__ == "__main__":
    unittest.main()
