import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.agent_control import (
    AgentConflictError,
    AgentCoordinator,
    AuditLog,
    PcAgentSuggestionStore,
    PeerAuthenticationError,
    PeerTokenAuthenticator,
)
from agent_ip_kvm.hid import SimulatedEventKind, SimulatedHidAdapter
from agent_ip_kvm.web import HidWebController


class AgentControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.adapter = SimulatedHidAdapter()
        self.hid = HidWebController(self.adapter, backend="simulated")
        self.audit = AuditLog(self.root / "audit.jsonl")
        self.observations = 0

        def observe():
            self.observations += 1
            return {
                "frame": {"sha256": f"frame-{self.observations}", "bytes": 12},
                "recognition": {"state": "test_pattern", "confidence": 1.0},
            }

        self.coordinator = AgentCoordinator(
            hid_controller=self.hid,
            observe=observe,
            audit_log=self.audit,
        )

    def tearDown(self) -> None:
        self.hid.close()
        self.temporary.cleanup()

    def test_read_only_observation_executes_without_approval(self) -> None:
        plan = self.coordinator.create_plan({"objective": "看看当前屏幕"})
        self.assertEqual(plan["risk"], "read_only")
        self.assertFalse(plan["approval_required"])

        completed = self.coordinator.execute({"plan_id": plan["plan_id"]})

        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["result"][0]["result"]["recognition"]["state"], "test_pattern")
        self.assertEqual(
            [entry["event"] for entry in self.audit.recent()],
            [
                "plan_created",
                "plan_execution_started",
                "agent_action_completed",
                "plan_execution_completed",
            ],
        )

    def test_hid_action_requires_digest_bound_approval_and_verifies_afterward(self) -> None:
        plan = self.coordinator.create_plan({"objective": "按下 Win 键"})
        self.assertEqual(plan["risk"], "low")
        with self.assertRaises(AgentConflictError):
            self.coordinator.execute({"plan_id": plan["plan_id"]})
        with self.assertRaises(AgentConflictError):
            self.coordinator.approve({"plan_id": plan["plan_id"], "digest": "wrong"})

        approved = self.coordinator.approve(
            {"plan_id": plan["plan_id"], "digest": plan["digest"]}
        )
        completed = self.coordinator.execute({"plan_id": approved["plan_id"]})

        self.assertEqual(completed["status"], "completed")
        self.assertIn("verification", completed["result"][0])
        self.assertEqual(
            [event.kind for event in self.adapter.events],
            [SimulatedEventKind.ARMED, SimulatedEventKind.KEY_DOWN, SimulatedEventKind.KEY_UP],
        )

    def test_bios_objective_is_high_risk_even_when_plan_only_observes(self) -> None:
        plan = self.coordinator.create_plan({"objective": "修改 BIOS 启动顺序"})
        self.assertEqual(plan["risk"], "high")
        self.assertEqual(plan["status"], "pending_approval")

    def test_pairing_token_and_pc_suggestion_cache(self) -> None:
        token_path = self.root / "token"
        token_path.write_text("a" * 32, encoding="utf-8")
        authenticator = PeerTokenAuthenticator(token_path)
        self.assertTrue(authenticator.enabled)
        with self.assertRaises(PeerAuthenticationError):
            authenticator.require("Bearer wrong")
        authenticator.require("Bearer " + "a" * 32)

        store = PcAgentSuggestionStore(self.root / "suggestion.json")
        report = store.update(
            {"objective": "安装系统", "summary": "先核对磁盘", "steps": ["读取磁盘"]}
        )
        self.assertEqual(report["schema_version"], 1)
        self.assertEqual(store.status()["status"], "available")


if __name__ == "__main__":
    unittest.main()
