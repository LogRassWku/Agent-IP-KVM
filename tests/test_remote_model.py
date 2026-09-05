import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
