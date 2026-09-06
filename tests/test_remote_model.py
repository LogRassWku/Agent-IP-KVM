import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

from agent_ip_kvm.remote_model import RemoteModelError, RemoteModelStore


class RemoteModelStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = RemoteModelStore(Path(self.temp.name) / "remote.json")

    def tearDown(self):
        self.temp.cleanup()

    def test_public_config_never_contains_api_key(self):
        saved = self.store.save({"api_key": "sk-" + "x" * 28, "model": "deepseek-v4-flash", "base_url": "https://api.deepseek.com"})
        self.assertTrue(saved["configured"])
        self.assertNotIn("api_key", saved)
        self.assertNotIn("api_key", self.store.catalog())

    def test_rejects_public_http_and_unknown_model(self):
        with self.assertRaises(RemoteModelError):
            self.store.save({"api_key": "sk-" + "x" * 28, "model": "deepseek-v4-flash", "base_url": "http://example.com"})
        with self.assertRaises(RemoteModelError):
            self.store.save({"api_key": "sk-" + "x" * 28, "model": "other", "base_url": "https://api.deepseek.com"})

    def test_chat_sends_tools_and_returns_validated_tool_calls(self):
        self.store.save({"api_key": "sk-" + "x" * 28, "model": "deepseek-v4-flash", "base_url": "https://api.deepseek.com"})

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _limit):
                return json.dumps(
                    {
                        "model": "deepseek-v4-flash",
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": None,
                                    "tool_calls": [
                                        {
                                            "id": "call-1",
                                            "type": "function",
                                            "function": {"name": "capture_screen", "arguments": "{}"},
                                        }
                                    ],
                                }
                            }
                        ],
                    }
                ).encode()

        tools = [
            {
                "type": "function",
                "function": {"name": "capture_screen", "parameters": {"type": "object"}},
            }
        ]
        with patch("urllib.request.urlopen", return_value=Response()) as mocked:
            result = self.store.chat(
                [{"role": "user", "content": "看看屏幕"}],
                tools=tools,
            )

        request = mocked.call_args.args[0]
        payload = json.loads(request.data.decode())
        self.assertEqual(payload["tool_choice"], "auto")
        self.assertEqual(payload["tools"], tools)
        self.assertEqual(result["tool_calls"][0]["function"]["name"], "capture_screen")


if __name__ == "__main__":
    unittest.main()
