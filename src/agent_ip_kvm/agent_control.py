"""Guarded Agent planning, approval, execution, and peer authentication."""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

class AgentControlError(RuntimeError):
    """An Agent request is invalid or cannot be executed safely."""


class AgentConflictError(AgentControlError):
    """An Agent request conflicts with the current plan state."""


class PeerAuthenticationError(AgentControlError):
    """A PC Agent request did not provide the configured pairing token."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class AuditLog:
    """Append compact JSON events for later review without storing screenshots."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def record(self, event: str, **details: object) -> dict[str, object]:
        entry = {
            "timestamp": _utc_now(),
            "monotonic_ns": time.monotonic_ns(),
            "event": event,
            **details,
        }
        encoded = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(encoded + "\n")
        return entry

    def recent(self, limit: int = 50) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        with self._lock:
            try:
                lines = self.path.read_text(encoding="utf-8").splitlines()
            except OSError:
                return []
        entries: list[dict[str, object]] = []
        for line in lines[-max(1, min(limit, 200)) :]:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                entries.append(value)
        return entries


class PeerTokenAuthenticator:
    """Verify a bearer token stored outside the Git repository."""

    def __init__(self, token_path: Path | None) -> None:
        self.path = Path(token_path) if token_path is not None else None

    @property
    def enabled(self) -> bool:
        return bool(self._token())

    def token_for_local_bootstrap(self) -> str:
        """Return the pairing secret to trusted server-side bootstrap code only."""
        token = self._token()
        if token is None:
            raise PeerAuthenticationError("PC Agent pairing is not configured")
        return token

    def require(self, authorization: str | None) -> None:
        token = self._token()
        if token is None:
            raise PeerAuthenticationError("PC Agent pairing is not configured")
        scheme, _, supplied = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not supplied or not hmac.compare_digest(token, supplied):
            raise PeerAuthenticationError("invalid PC Agent pairing token")

    def verify_if_enabled(self, authorization: str | None) -> None:
        if self.enabled:
            self.require(authorization)

    def _token(self) -> str | None:
        if self.path is None:
            return None
        try:
            token = self.path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return token if 24 <= len(token) <= 256 else None


class PcAgentSuggestionStore:
    """Persist the latest authenticated PC Agent recommendation."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def update(self, payload: dict[str, object]) -> dict[str, object]:
        objective = payload.get("objective")
        summary = payload.get("summary")
        steps = payload.get("steps", [])
        sources = payload.get("sources", [])
        if not isinstance(objective, str) or not objective.strip() or len(objective) > 1000:
            raise ValueError("objective must be a non-empty string up to 1000 characters")
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 4000:
            raise ValueError("summary must be a non-empty string up to 4000 characters")
        if not isinstance(steps, list) or len(steps) > 32 or any(
            not isinstance(item, str) or not item.strip() or len(item) > 500 for item in steps
        ):
            raise ValueError("steps must contain at most 32 short strings")
        if not isinstance(sources, list) or len(sources) > 16 or any(
            not isinstance(item, str) or len(item) > 1000 for item in sources
        ):
            raise ValueError("sources must contain at most 16 strings")
        report = {
            "schema_version": 1,
            "received_at": _utc_now(),
            "objective": objective.strip(),
            "summary": summary.strip(),
            "steps": [item.strip() for item in steps],
            "sources": sources,
        }
        encoded = json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_bytes(encoded)
            temporary.replace(self.path)
        return report

    def status(self) -> dict[str, object]:
        if not self.path.exists():
            return {"status": "empty", "message": "尚未收到 PC Agent 建议"}
        with self._lock:
            try:
                report = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {"status": "error", "message": "PC Agent 建议缓存不可读"}
        return {"status": "available", "message": "已收到 PC Agent 建议", "data": report}


@dataclass(slots=True)
class AgentPlan:
    plan_id: str
    objective: str
    model: str
    risk: str
    actions: list[dict[str, object]]
    summary: str
    target: str
    evidence: dict[str, object]
    expected_result: str
    recovery: str
    digest: str
    status: str
    created_at: str
    expires_at_monotonic: float
    approved_at: str | None = None
    result: list[dict[str, object]] = field(default_factory=list)

    def public(self) -> dict[str, object]:
        return {
            "plan_id": self.plan_id,
            "objective": self.objective,
            "model": self.model,
            "risk": self.risk,
            "actions": self.actions,
            "summary": self.summary,
            "target": self.target,
            "evidence": self.evidence,
            "expected_result": self.expected_result,
            "recovery": self.recovery,
            "digest": self.digest,
            "status": self.status,
            "created_at": self.created_at,
            "approved_at": self.approved_at,
            "approval_required": self.risk != "read_only",
            "result": self.result,
        }


class AgentCoordinator:
    """Keep model proposals separate from approval and deterministic execution."""

    _RISK_LEVELS = {"read_only": 0, "low": 1, "high": 2, "critical": 3}
    _HIGH_RISK_WORDS = (
        "bios", "uefi", "secure boot", "安全启动", "启动项", "启动顺序",
        "重启", "reboot", "安装", "install", "分区", "partition", "格式化", "format",
    )
    _CRITICAL_WORDS = ("刷写", "flash firmware", "固件", "清盘", "wipe", "erase disk")

    def __init__(
        self,
        *,
        hid_controller: object,
        observe: Callable[[], dict[str, object]],
        audit_log: AuditLog,
        approval_seconds: float = 300.0,
    ) -> None:
        self._hid = hid_controller
        self._observe = observe
        self._audit = audit_log
        self._approval_seconds = approval_seconds
        self._plans: dict[str, AgentPlan] = {}
        self._lock = threading.Lock()

    def create_plan(self, payload: dict[str, object]) -> dict[str, object]:
        objective = payload.get("objective")
        model = payload.get("model", "board-agent")
        if not isinstance(objective, str) or not objective.strip() or len(objective) > 2000:
            raise ValueError("objective must be a non-empty string up to 2000 characters")
        if not isinstance(model, str) or not model.strip() or len(model) > 80:
            raise ValueError("model must be a short string")
        objective = objective.strip()
        supplied_actions = payload.get("actions")
        if supplied_actions is None:
            actions, summary = self._prototype_actions(objective)
        else:
            actions = self._validate_actions(supplied_actions)
            summary = "执行经过结构校验的 Agent 动作计划"
        risk = self._risk_for(objective, actions)
        target = payload.get("target", "当前已连接的被控主机")
        if not isinstance(target, str) or not target.strip() or len(target) > 200:
            raise ValueError("target must be a short string")
        evidence = self._observe() if risk != "read_only" else {}
        expected_result = summary
        recovery = "出现异常时停止计划并释放全部 HID 输入"
        created_at = _utc_now()
        canonical = json.dumps(
            {
                "objective": objective,
                "model": model,
                "risk": risk,
                "actions": actions,
                "target": target.strip(),
                "evidence": evidence,
                "expected_result": expected_result,
                "recovery": recovery,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        plan = AgentPlan(
            plan_id=uuid.uuid4().hex,
            objective=objective,
            model=model.strip(),
            risk=risk,
            actions=actions,
            summary=summary,
            target=target.strip(),
            evidence=evidence,
            expected_result=expected_result,
            recovery=recovery,
            digest=hashlib.sha256(canonical).hexdigest(),
            status="ready" if risk == "read_only" else "pending_approval",
            created_at=created_at,
            expires_at_monotonic=time.monotonic() + self._approval_seconds,
        )
        with self._lock:
            self._plans[plan.plan_id] = plan
        self._audit.record(
            "plan_created",
            plan_id=plan.plan_id,
            plan_digest=plan.digest,
            risk=plan.risk,
            model=plan.model,
            action_types=[action["type"] for action in actions],
        )
        return plan.public()

    def approve(self, payload: dict[str, object]) -> dict[str, object]:
        plan = self._lookup(payload)
        digest = payload.get("digest")
        if not isinstance(digest, str) or not hmac.compare_digest(plan.digest, digest):
            raise AgentConflictError("plan digest changed; review the current plan again")
        with self._lock:
            self._check_current(plan, {"pending_approval"})
            plan.status = "approved"
            plan.approved_at = _utc_now()
        self._audit.record(
            "plan_approved", plan_id=plan.plan_id, plan_digest=plan.digest, risk=plan.risk
        )
        return plan.public()

    def reject(self, payload: dict[str, object]) -> dict[str, object]:
        plan = self._lookup(payload)
        with self._lock:
            self._check_current(plan, {"pending_approval", "approved", "ready"})
            plan.status = "rejected"
        self._audit.record("plan_rejected", plan_id=plan.plan_id, plan_digest=plan.digest)
        return plan.public()

    def execute(self, payload: dict[str, object]) -> dict[str, object]:
        plan = self._lookup(payload)
        allowed = {"ready"} if plan.risk == "read_only" else {"approved"}
        with self._lock:
            self._check_current(plan, allowed)
            plan.status = "executing"
        self._audit.record(
            "plan_execution_started", plan_id=plan.plan_id, plan_digest=plan.digest
        )
        results: list[dict[str, object]] = []
        try:
            for index, action in enumerate(plan.actions):
                result = self._execute_action(action)
                entry: dict[str, object] = {
                    "index": index,
                    "type": action["type"],
                    "result": result,
                }
                if action["type"] not in {"observe", "wait"}:
                    entry["verification"] = self._observe()
                results.append(entry)
                evidence = entry.get("verification", result)
                frame = evidence.get("frame", {}) if isinstance(evidence, dict) else {}
                self._audit.record(
                    "agent_action_completed",
                    plan_id=plan.plan_id,
                    plan_digest=plan.digest,
                    action_index=index,
                    action_type=action["type"],
                    frame_sha256=frame.get("sha256") if isinstance(frame, dict) else None,
                )
            with self._lock:
                plan.result = results
                plan.status = "completed"
            self._audit.record(
                "plan_execution_completed",
                plan_id=plan.plan_id,
                plan_digest=plan.digest,
                result_types=[item["type"] for item in results],
            )
        except Exception as exc:
            try:
                self._hid.release_all()
            except Exception:
                pass
            with self._lock:
                plan.status = "failed"
                plan.result = results + [{"error": str(exc)}]
            self._audit.record(
                "plan_execution_failed",
                plan_id=plan.plan_id,
                plan_digest=plan.digest,
                error=type(exc).__name__,
            )
            raise AgentControlError(f"Agent action failed: {exc}") from exc
        return plan.public()

    def get(self, plan_id: str) -> dict[str, object]:
        with self._lock:
            plan = self._plans.get(plan_id)
        if plan is None:
            raise AgentControlError("unknown Agent plan")
        return plan.public()

    def _lookup(self, payload: dict[str, object]) -> AgentPlan:
        plan_id = payload.get("plan_id")
        if not isinstance(plan_id, str):
            raise ValueError("plan_id is required")
        with self._lock:
            plan = self._plans.get(plan_id)
        if plan is None:
            raise AgentControlError("unknown Agent plan")
        return plan

    def _check_current(self, plan: AgentPlan, allowed: set[str]) -> None:
        if time.monotonic() > plan.expires_at_monotonic:
            plan.status = "expired"
            raise AgentConflictError("plan approval expired; create and review a new plan")
        if plan.status not in allowed:
            raise AgentConflictError(f"plan cannot be used while status is {plan.status}")

    def _execute_action(self, action: dict[str, object]) -> dict[str, object]:
        kind = action["type"]
        if kind == "observe":
            return self._observe()
        if kind == "key_tap":
            return self._hid.tap_key(
                {"key": action["key"], "modifiers": action.get("modifiers", [])}
            )
        if kind == "wait":
            seconds = float(action["seconds"])
            time.sleep(seconds)
            return {"seconds": seconds}
        if kind == "release_all":
            self._hid.release_all()
            return {"released": True}
        raise AgentControlError(f"unsupported Agent action: {kind}")

    def _validate_actions(self, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list) or not value or len(value) > 16:
            raise ValueError("actions must contain between 1 and 16 items")
        actions: list[dict[str, object]] = []
        for item in value:
            if not isinstance(item, dict):
                raise ValueError("each action must be an object")
            kind = item.get("type")
            if kind == "observe" or kind == "release_all":
                if set(item) != {"type"}:
                    raise ValueError(f"{kind} does not accept extra fields")
                actions.append({"type": kind})
            elif kind == "key_tap":
                key = item.get("key")
                modifiers = item.get("modifiers", [])
                if not isinstance(key, str) or len(key) > 20:
                    raise ValueError("key_tap requires a short key name")
                if not isinstance(modifiers, list) or len(modifiers) > 4 or any(
                    not isinstance(modifier, str) for modifier in modifiers
                ):
                    raise ValueError("key_tap modifiers are invalid")
                actions.append({"type": kind, "key": key, "modifiers": modifiers})
            elif kind == "wait":
                seconds = item.get("seconds")
                if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
                    raise ValueError("wait seconds must be a number")
                if not 0 <= float(seconds) <= 2:
                    raise ValueError("wait must be between 0 and 2 seconds")
                actions.append({"type": kind, "seconds": float(seconds)})
            else:
                raise ValueError("unsupported Agent action type")
        return actions

    def _prototype_actions(self, objective: str) -> tuple[list[dict[str, object]], str]:
        lowered = objective.lower().replace(" ", "")
        if any(word in lowered for word in ("按下win", "开始菜单", "windows键")):
            return ([{"type": "key_tap", "key": "win", "modifiers": []}], "按下并释放 Win 键")
        if any(word in lowered for word in ("按下enter", "按下回车", "回车键")):
            return ([{"type": "key_tap", "key": "enter", "modifiers": []}], "按下并释放 Enter 键")
        return ([{"type": "observe"}], "取得一张按需截图并识别当前画面状态")

    def _risk_for(self, objective: str, actions: list[dict[str, object]]) -> str:
        lowered = objective.lower()
        if any(word in lowered for word in self._CRITICAL_WORDS):
            return "critical"
        if any(word in lowered for word in self._HIGH_RISK_WORDS):
            return "high"
        if any(action["type"] in {"key_tap"} for action in actions):
            return "low"
        return "read_only"
