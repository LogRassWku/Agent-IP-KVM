import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_ip_kvm.hid import SimulatedHidAdapter
from agent_ip_kvm.web import HidWebController, WebConfig, create_handler


class SnapshotStream:
    jpeg = b"\xff\xd8snapshot\xff\xd9"

    def frames(self):
        yield 1, self.jpeg

    def status(self):
        return {"state": "idle", "message": "test", "sequence": None, "error": None}

    def snapshot(self):
        return self.jpeg, {
            "source_id": "synthetic:test",
            "width": 1,
            "height": 1,
            "sequence": 1,
            "timestamp_ns": 1,
            "bytes": len(self.jpeg),
            "sha256": "a" * 64,
            "on_demand": True,
        }

    def pause(self):
        return None

    def close(self):
        return None


class AgentApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.token = "p" * 32
        (root / "token").write_text(self.token, encoding="utf-8")
        config = WebConfig(
            host_info_path=root / "host.json",
            audit_path=root / "audit.jsonl",
            pc_agent_token_path=root / "token",
            pc_agent_suggestion_path=root / "suggestion.json",
        )
        self.adapter = SimulatedHidAdapter()
        self.controller = HidWebController(self.adapter, backend="simulated")
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            create_handler(
                config,
                stream_provider=SnapshotStream(),
                hid_controller=self.controller,
            ),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.controller.close()
        self.temporary.cleanup()

    def post(self, path, payload, token=None):
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(
            self.base_url + path,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            return response.status, json.load(response)

    def test_full_plan_approval_execution_and_audit_loop(self):
        _, created = self.post("/api/agent/plans", {"objective": "按下 Win 键"})
        plan = created["plan"]
        with self.assertRaises(HTTPError) as caught:
            self.post("/api/agent/execute", {"plan_id": plan["plan_id"]})
        self.assertEqual(caught.exception.code, 409)

        self.post(
            "/api/agent/approve",
            {"plan_id": plan["plan_id"], "digest": plan["digest"]},
        )
        _, executed = self.post("/api/agent/execute", {"plan_id": plan["plan_id"]})
        self.assertEqual(executed["plan"]["status"], "completed")
        self.assertEqual(
            executed["plan"]["result"][0]["verification"]["recognition"]["state"],
            "test_pattern",
        )
        with urlopen(self.base_url + "/api/agent/audit", timeout=2) as response:
            events = json.load(response)["events"]
        self.assertEqual(events[-1]["event"], "plan_execution_completed")

    def test_snapshot_and_authenticated_pc_agent_relay(self):
        with urlopen(self.base_url + "/api/video/snapshot.jpg", timeout=2) as response:
            self.assertEqual(response.read(), SnapshotStream.jpeg)
            self.assertEqual(response.headers["X-Frame-SHA256"], "a" * 64)

        suggestion = {"objective": "检查磁盘", "summary": "磁盘状态正常", "steps": []}
        with self.assertRaises(HTTPError) as caught:
            self.post("/api/pc-agent/suggestions", suggestion)
        self.assertEqual(caught.exception.code, 401)
        status, result = self.post("/api/pc-agent/suggestions", suggestion, self.token)
        self.assertEqual(status, 200)
        self.assertEqual(result["suggestion"]["objective"], "检查磁盘")
        with urlopen(self.base_url + "/api/pc-agent/status", timeout=2) as response:
            self.assertEqual(json.load(response)["status"], "available")


if __name__ == "__main__":
    unittest.main()
