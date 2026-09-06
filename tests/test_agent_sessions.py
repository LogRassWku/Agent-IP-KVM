import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.agent_sessions import AgentSessionError, AgentSessionStore


class AgentSessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AgentSessionStore(Path(self.temp.name) / "sessions.json")

    def tearDown(self):
        self.temp.cleanup()

    def test_upsert_round_trips_and_persists(self):
        session = {"id": "s1", "title": "测试", "createdAt": 1, "updatedAt": 2, "messages": [{"role": "user", "content": "你好"}]}
        saved = self.store.upsert(session)
        self.assertEqual(saved["id"], "s1")
        restored = AgentSessionStore(self.store.path)
        self.assertEqual(restored.list()[0]["messages"][0]["content"], "你好")

    def test_rejects_unknown_roles_and_oversized_messages(self):
        base = {"id": "s1", "title": "测试", "createdAt": 1, "updatedAt": 2, "messages": []}
        with self.assertRaises(AgentSessionError):
            self.store.upsert({**base, "messages": [{"role": "system", "content": "x"}]})
        with self.assertRaises(AgentSessionError):
            self.store.upsert({**base, "messages": [{"role": "user", "content": "x" * 20001}]})

    def test_delete_tombstone_persists_and_prevents_stale_restore(self):
        session = {"id": "s1", "title": "测试", "createdAt": 1, "updatedAt": 2, "messages": []}
        self.store.upsert(session)
        self.store.delete("s1")
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.store.deleted_ids(), ["s1"])
        restored = AgentSessionStore(self.store.path)
        self.assertEqual(restored.deleted_ids(), ["s1"])
        with self.assertRaises(AgentSessionError):
            restored.upsert(session)


if __name__ == "__main__":
    unittest.main()
