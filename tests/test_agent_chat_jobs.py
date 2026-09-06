import threading
import unittest

from agent_ip_kvm.agent_chat_jobs import AgentChatJobError, AgentChatJobStore


class AgentChatJobStoreTests(unittest.TestCase):
    def test_repeated_request_id_reuses_job_and_keeps_result(self):
        store = AgentChatJobStore()
        release = threading.Event()
        calls = []

        def work():
            calls.append(True)
            release.wait(1)
            return {"response": {"content": "完成"}}

        first = store.create("request-1", work)
        second = store.create("request-1", work)
        self.assertEqual(first["job_id"], second["job_id"])
        release.set()
        for _ in range(100):
            result = store.get(first["job_id"])
            if result["status"] == "completed":
                break
            threading.Event().wait(0.01)
        self.assertEqual(result["result"]["response"]["content"], "完成")
        self.assertEqual(len(calls), 1)

    def test_failure_is_reported_and_unknown_job_is_rejected(self):
        store = AgentChatJobStore()
        failed = store.create("request-2", lambda: (_ for _ in ()).throw(RuntimeError("network down")))
        for _ in range(100):
            failed = store.get(failed["job_id"])
            if failed["status"] == "failed":
                break
            threading.Event().wait(0.01)
        self.assertEqual(failed["error"], "network down")
        with self.assertRaises(AgentChatJobError):
            store.get("missing")


if __name__ == "__main__":
    unittest.main()
