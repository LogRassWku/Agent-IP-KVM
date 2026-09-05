"""Controlled-host model installation tasks and bootstrap script rendering."""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MODEL_CATALOG = (
    {
        "id": "qwen3.5:9b",
        "name": "Qwen3.5 9B",
        "description": "推荐：视觉、工具调用与复杂任务，约 6.6 GB",
        "size_bytes": 6_600_000_000,
        "recommended": True,
    },
    {
        "id": "qwen3.5:4b",
        "name": "Qwen3.5 4B",
        "description": "轻量：显存压力更低，约 3.4 GB",
        "size_bytes": 3_400_000_000,
        "recommended": False,
    },
)

_MODEL_IDS = {item["id"] for item in MODEL_CATALOG}
_WINDOWS_PATH = re.compile(r"^[A-Za-z]:\\[^\r\n\"'|<>?*]*$")
_TASK_STATUSES = {
    "awaiting_start",
    "starting",
    "downloading_runtime",
    "installing_runtime",
    "downloading_model",
    "verifying",
    "completed",
    "failed",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ModelSetupError(ValueError):
    """Raised when a model setup request or progress report is invalid."""


@dataclass(slots=True)
class ModelSetupTask:
    task_id: str
    secret: str
    model: str
    install_dir: str
    models_dir: str
    status: str
    progress: int
    message: str
    created_at: str
    updated_at: str
    events: list[dict[str, object]]

    def public(self) -> dict[str, object]:
        return {
            "task_id": self.task_id,
            "model": self.model,
            "install_dir": self.install_dir,
            "models_dir": self.models_dir,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "events": list(self.events),
        }


class ModelSetupStore:
    """Persist small, finite model installation tasks on the KVM device."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._tasks: dict[str, ModelSetupTask] = {}
        self._load()

    def catalog(self, host_status: dict[str, object]) -> dict[str, object]:
        locations: list[dict[str, object]] = []
        data = host_status.get("data") if isinstance(host_status, dict) else None
        volumes = data.get("volumes", []) if isinstance(data, dict) else []
        for volume in volumes:
            if not isinstance(volume, dict):
                continue
            name = volume.get("name")
            free = volume.get("free_bytes")
            if isinstance(name, str) and re.fullmatch(r"[A-Za-z]:", name):
                locations.append(
                    {
                        "drive": name.upper(),
                        "models_dir": f"{name.upper()}\\AgentIPKVM\\Models",
                        "free_bytes": free if isinstance(free, int) else None,
                    }
                )
        if not locations:
            locations.append(
                {"drive": "C:", "models_dir": "C:\\AgentIPKVM\\Models", "free_bytes": None}
            )
        return {"models": list(MODEL_CATALOG), "locations": locations}

    def create(self, payload: dict[str, object]) -> dict[str, object]:
        model = payload.get("model")
        if not isinstance(model, str) or model not in _MODEL_IDS:
            raise ModelSetupError("unsupported model")
        install_dir = self._path(payload.get("install_dir"), "install_dir")
        models_dir = self._path(payload.get("models_dir"), "models_dir")
        now = _utc_now()
        task = ModelSetupTask(
            task_id=str(uuid.uuid4()),
            secret=secrets.token_urlsafe(24),
            model=model,
            install_dir=install_dir,
            models_dir=models_dir,
            status="awaiting_start",
            progress=0,
            message="等待向被控电脑发送安装指令",
            created_at=now,
            updated_at=now,
            events=[{"at": now, "status": "awaiting_start", "message": "配置任务已创建"}],
        )
        with self._lock:
            self._tasks[task.task_id] = task
            self._save()
        return task.public()

    def get(self, task_id: str) -> dict[str, object]:
        with self._lock:
            return self._task(task_id).public()

    def latest(self) -> dict[str, object] | None:
        with self._lock:
            if not self._tasks:
                return None
            return max(self._tasks.values(), key=lambda task: task.created_at).public()

    def mark_starting(self, task_id: str) -> dict[str, object]:
        return self._update(task_id, "starting", 2, "正在被控电脑上启动配置程序")

    def update_progress(self, payload: dict[str, object]) -> dict[str, object]:
        task_id = payload.get("task_id")
        status = payload.get("status")
        progress = payload.get("progress")
        message = payload.get("message")
        if not isinstance(task_id, str):
            raise ModelSetupError("task_id is required")
        if not isinstance(status, str) or status not in _TASK_STATUSES:
            raise ModelSetupError("unsupported setup status")
        if isinstance(progress, bool) or not isinstance(progress, int) or not 0 <= progress <= 100:
            raise ModelSetupError("progress must be between 0 and 100")
        if not isinstance(message, str) or not message.strip() or len(message) > 500:
            raise ModelSetupError("message must be a short non-empty string")
        return self._update(task_id, status, progress, message.strip())

    def bootstrap(self, task_id: str, secret: str, *, base_url: str, token: str) -> bytes:
        if not secrets.compare_digest(secret, self._secret(task_id)):
            raise ModelSetupError("invalid or expired bootstrap address")
        task = self.get(task_id)
        values = {
            "__KVM_URL__": self._ps_quote(base_url),
            "__PAIRING_TOKEN__": self._ps_quote(token),
            "__TASK_ID__": self._ps_quote(task_id),
            "__MODEL__": self._ps_quote(str(task["model"])),
            "__INSTALL_DIR__": self._ps_quote(str(task["install_dir"])),
            "__MODELS_DIR__": self._ps_quote(str(task["models_dir"])),
        }
        template = Path(__file__).with_name("pc_agent_install.ps1").read_text(encoding="utf-8")
        for marker, value in values.items():
            template = template.replace(marker, value)
        # Invoke-Expression treats a UTF-8 BOM as part of the first identifier.
        return template.encode("utf-8")

    def bootstrap_path(self, task_id: str) -> str:
        with self._lock:
            task = self._task(task_id)
            return f"/api/model-setup/bootstrap/{task.task_id}/{task.secret}.ps1"

    def _update(self, task_id: str, status: str, progress: int, message: str) -> dict[str, object]:
        with self._lock:
            task = self._task(task_id)
            task.status = status
            task.progress = progress
            task.message = message
            task.updated_at = _utc_now()
            task.events.append({"at": task.updated_at, "status": status, "message": message})
            task.events = task.events[-100:]
            self._save()
            return task.public()

    def _secret(self, task_id: str) -> str:
        with self._lock:
            return self._task(task_id).secret

    def _task(self, task_id: str) -> ModelSetupTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise ModelSetupError("unknown model setup task")
        return task

    @staticmethod
    def _path(value: object, name: str) -> str:
        if not isinstance(value, str) or not _WINDOWS_PATH.fullmatch(value.strip()):
            raise ModelSetupError(f"{name} must be an absolute Windows path")
        value = value.strip().rstrip("\\")
        if len(value) > 240:
            raise ModelSetupError(f"{name} is too long")
        return value

    @staticmethod
    def _ps_quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload: Any = json.loads(self.path.read_text(encoding="utf-8"))
            for item in payload.get("tasks", []):
                task = ModelSetupTask(**item)
                self._tasks[task.task_id] = task
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self._tasks = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        payload = {"tasks": [vars_for_task(task) for task in self._tasks.values()]}
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)


def vars_for_task(task: ModelSetupTask) -> dict[str, object]:
    return {name: getattr(task, name) for name in task.__dataclass_fields__}
