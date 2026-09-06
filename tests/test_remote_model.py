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
        self.assertEqual(saved["vision_model"], "deepseek-v4-flash-vision-exp")

    def test_model_can_change_without_reentering_key_and_repairs_stale_vision_value(self):
        key = "sk-" + "a" * 32
        self.store.save(
            {
                "api_key": key,
                "model": "deepseek-v4-flash",
                "vision_model": "deepseek-v4-flash-vision-exp",
                "base_url": "https://api.deepseek.com",
            }
        )
        updated = self.store.save(
            {
                "api_key": "",
                "model": "deepseek-v4-pro",
                "vision_model": "",
                "base_url": "https://api.deepseek.com",
            }
        )
        self.assertEqual(updated["model"], "deepseek-v4-pro")
        self.assertEqual(updated["vision_model"], "deepseek-v4-flash-vision-exp")
        persisted = json.loads(self.store.path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["api_key"], key)

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

    def test_analyze_image_sends_one_jpeg_to_dedicated_vision_model(self):
        self.store.save({"api_key": "sk-" + "x" * 28, "model": "deepseek-v4-flash", "base_url": "https://api.deepseek.com"})

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _limit):
                return json.dumps(
                    {
                        "model": "deepseek-v4-flash-vision-exp",
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": json.dumps(
                                        {
                                            "screen_type": "bios_uefi",
                                            "summary": "UEFI 设置界面",
                                            "visible_text": ["Boot"],
                                            "interactive_elements": [],
                                            "confidence": 0.96,
                                            "safety_notes": ["只读观察"],
                                        },
                                        ensure_ascii=False,
                                    ),
                                }
                            }
                        ],
                    }
                ).encode()

        with patch("urllib.request.urlopen", return_value=Response()) as mocked:
            result = self.store.analyze_image(b"\xff\xd8jpeg\xff\xd9", "识别当前界面")

        request = mocked.call_args.args[0]
        payload = json.loads(request.data.decode())
        self.assertEqual(payload["model"], "deepseek-v4-flash-vision-exp")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        content = payload["messages"][0]["content"]
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(result["analysis"]["screen_type"], "bios_uefi")


if __name__ == "__main__":
    unittest.main()
