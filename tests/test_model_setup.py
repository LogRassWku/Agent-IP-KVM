import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.model_setup import ModelSetupError, ModelSetupStore


class ModelSetupStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = ModelSetupStore(Path(self.temporary.name) / "tasks.json")

    def tearDown(self):
        self.temporary.cleanup()

    def test_catalog_uses_reported_windows_volumes(self):
        catalog = self.store.catalog(
            {"data": {"volumes": [{"name": "D:", "free_bytes": 42}]}}
        )
        self.assertEqual(catalog["models"][0]["id"], "qwen3.5:9b")
        self.assertEqual(catalog["locations"][0]["models_dir"], "D:\\AgentIPKVM\\Models")

    def test_task_is_persisted_and_bootstrap_hides_secret_from_public_data(self):
        created = self.store.create(
            {
                "model": "qwen3.5:9b",
                "install_dir": "D:\\AgentIPKVM\\Ollama",
                "models_dir": "D:\\AgentIPKVM\\Models",
            }
        )
        self.assertNotIn("secret", created)
        bootstrap_path = self.store.bootstrap_path(created["task_id"])
        secret = bootstrap_path.removesuffix(".ps1").rsplit("/", 1)[-1]
        script = self.store.bootstrap(
            created["task_id"], secret, base_url="http://192.168.128.10:8765", token="t" * 64
        ).decode("utf-8")
        self.assertIn("qwen3.5:9b", script)
        self.assertIn("https://ollama.com/install.ps1", script)
        self.assertIn("http://127.0.0.1:11434/api/tags", script)
        self.assertIn("Start-Process -FilePath $ollama -ArgumentList 'serve'", script)
        self.assertIn("$taskProgress = 38 + [Math]::Floor($pullPercent * 0.54)", script)
        self.assertIn("t" * 64, script)
        restored = ModelSetupStore(self.store.path)
        self.assertEqual(restored.get(created["task_id"])["model"], "qwen3.5:9b")

    def test_rejects_arbitrary_model_and_relative_path(self):
        with self.assertRaises(ModelSetupError):
            self.store.create(
                {"model": "other", "install_dir": "D:\\Ollama", "models_dir": "Models"}
            )


if __name__ == "__main__":
    unittest.main()
