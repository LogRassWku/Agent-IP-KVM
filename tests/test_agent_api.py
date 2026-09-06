import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_ip_kvm.hid import SimulatedHidAdapter
from agent_ip_kvm.web import HidWebController, WebConfig, build_remote_agent_system_prompt, create_handler


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


class ScriptedRemoteModel:
    def __init__(self):
        self.responses = []
        self.requests = []

    def public(self):
        return {"provider": "DeepSeek", "model": "deepseek-v4-flash", "configured": True}

    def chat(self, messages, *, timeout=90, tools=None, tool_choice="auto"):
        self.requests.append({"messages": messages, "tools": tools, "tool_choice": tool_choice})
        if not self.responses:
            raise AssertionError("unexpected remote model call")
        return self.responses.pop(0)


def tool_call_response(name, arguments, call_id="call-1"):
    tool_calls = [
        {
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
        }
    ]
    return {
        "content": "",
        "model": "deepseek-v4-flash",
        "usage": None,
        "tool_calls": tool_calls,
        "message": {"role": "assistant", "content": None, "tool_calls": tool_calls},
    }


def text_response(content):
    return {
        "content": content,
        "model": "deepseek-v4-flash",
        "usage": None,
        "tool_calls": [],
        "message": {"role": "assistant", "content": content},
    }


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
            model_setup_path=root / "model-setup.json",
            agent_sessions_path=root / "agent-sessions.json",
        )
        self.adapter = SimulatedHidAdapter()
        self.controller = HidWebController(self.adapter, backend="simulated")
        self.remote_model = ScriptedRemoteModel()
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            create_handler(
                config,
                stream_provider=SnapshotStream(),
                hid_controller=self.controller,
                remote_model_store=self.remote_model,
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
        with urlopen(request, timeout=5) as response:
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

    def test_remote_agent_prompt_contains_board_and_host_context(self):
        prompt = build_remote_agent_system_prompt(
            WebConfig(source_kind="v4l2"),
            {"data": {"hostname": "TARGET", "volumes": [{"name": "C:"}]}},
            {"state": "idle"},
            {"enabled": True},
        )
        self.assertIn("/home/sunrise/agent-ip-kvm-app", prompt)
        self.assertIn("TARGET", prompt)
        self.assertIn("v4l2", prompt)
        self.assertIn("必须调用 capture_screen", prompt)
        self.assertIn("调用 propose_hid_actions", prompt)
        self.assertIn("等待网页审批", prompt)

    def test_remote_agent_can_capture_screen_through_a_read_only_tool(self):
        self.remote_model.responses = [
            tool_call_response("capture_screen", {"purpose": "查看当前界面"}),
            text_response("已取得当前屏幕；识别结果为测试画面。"),
        ]

        _, result = self.post(
            "/api/agent/chat",
            {"messages": [{"role": "user", "content": "看看当前屏幕"}]},
        )

        self.assertEqual(result["response"]["tool_count"], 1)
        self.assertEqual(result["plans"], [])
        names = {
            item["function"]["name"] for item in self.remote_model.requests[0]["tools"]
        }
        self.assertEqual(
            names,
            {"get_controlled_host_info", "get_kvm_status", "capture_screen", "propose_hid_actions"},
        )
        tool_message = self.remote_model.requests[1]["messages"][-1]
        self.assertEqual(tool_message["role"], "tool")
        self.assertIn("test_pattern", tool_message["content"])

    def test_remote_agent_hid_tool_creates_approval_card_before_input(self):
        self.remote_model.responses = [
            tool_call_response(
                "propose_hid_actions",
                {
                    "objective": "打开开始菜单",
                    "actions": [{"type": "key_tap", "key": "win", "modifiers": []}],
                },
            ),
            text_response("已创建按键计划，正在等待你的批准。"),
        ]

        _, result = self.post(
            "/api/agent/chat",
            {"messages": [{"role": "user", "content": "帮我打开开始菜单"}]},
        )

        plan = result["plans"][0]
        self.assertEqual(plan["status"], "pending_approval")
        self.assertEqual(len(self.adapter.events), 0)
        self.post(
            "/api/agent/approve",
            {"plan_id": plan["plan_id"], "digest": plan["digest"]},
        )
        self.post("/api/agent/execute", {"plan_id": plan["plan_id"]})
        self.assertGreater(len(self.adapter.events), 0)

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

    def test_agent_sessions_are_shared_through_board_store(self):
        session = {"id": "shared-1", "title": "共享会话", "createdAt": 1, "updatedAt": 2, "messages": [{"role": "user", "content": "你好"}]}
        status, saved = self.post("/api/agent/sessions", {"session": session})
        self.assertEqual(status, 200)
        self.assertEqual(saved["session"]["title"], "共享会话")
        with urlopen(self.base_url + "/api/agent/sessions", timeout=2) as response:
            self.assertEqual(json.load(response)["sessions"][0]["id"], "shared-1")
        request = Request(self.base_url + "/api/agent/sessions/shared-1", method="DELETE")
        with urlopen(request, timeout=2) as response:
            self.assertEqual(response.status, 200)

    def test_model_setup_task_bootstrap_launch_and_authenticated_progress(self):
        status, created = self.post(
            "/api/model-setup/tasks",
            {
                "model": "qwen3.5:9b",
                "install_dir": "D:\\AgentIPKVM\\Ollama",
                "models_dir": "D:\\AgentIPKVM\\Models",
            },
        )
        self.assertEqual(status, 200)
        task_id = created["task"]["task_id"]
        self.assertNotIn("secret", created["task"])

        _, launched = self.post("/api/model-setup/launch", {"task_id": task_id})
        self.assertEqual(launched["task"]["status"], "starting")
        with urlopen(self.base_url + f"/api/model-setup/tasks/{task_id}", timeout=2) as response:
            self.assertEqual(json.load(response)["task"]["model"], "qwen3.5:9b")

        with self.assertRaises(HTTPError) as caught:
            self.post(
                "/api/model-setup/progress",
                {"task_id": task_id, "status": "completed", "progress": 100, "message": "done"},
            )
        self.assertEqual(caught.exception.code, 401)
        _, completed = self.post(
            "/api/model-setup/progress",
            {"task_id": task_id, "status": "completed", "progress": 100, "message": "done"},
            self.token,
        )
        self.assertEqual(completed["task"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
