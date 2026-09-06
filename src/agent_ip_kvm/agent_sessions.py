"""Small bounded JSON store for Agent conversations shared by browsers."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any


class AgentSessionError(ValueError):
    pass


class AgentSessionStore:
    MAX_SESSIONS = 100
    MAX_DELETED_SESSIONS = 500
    MAX_MESSAGES = 300
    MAX_MESSAGE_CHARS = 20000

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._sessions: dict[str, dict[str, Any]] = {}
        self._deleted: dict[str, float] = {}
        self._load()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [json.loads(json.dumps(item, ensure_ascii=False)) for item in self._sessions.values()]

    def deleted_ids(self) -> list[str]:
        with self._lock:
            return list(self._deleted)

    def upsert(self, session: object) -> dict[str, Any]:
        clean = self._validate(session)
        with self._lock:
            if clean["id"] in self._deleted:
                raise AgentSessionError("session was deleted")
            self._sessions[clean["id"]] = clean
            ordered = sorted(self._sessions.values(), key=lambda item: float(item.get("updatedAt", 0)), reverse=True)
            self._sessions = {item["id"]: item for item in ordered[: self.MAX_SESSIONS]}
            self._save()
            return json.loads(json.dumps(clean, ensure_ascii=False))

    def delete(self, session_id: str) -> None:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 120:
            raise AgentSessionError("invalid session id")
        with self._lock:
            self._sessions.pop(session_id, None)
            self._deleted[session_id] = time.time() * 1000
            ordered = sorted(self._deleted.items(), key=lambda item: item[1], reverse=True)
            self._deleted = dict(ordered[: self.MAX_DELETED_SESSIONS])
            self._save()

    @classmethod
    def _validate(cls, session: object) -> dict[str, Any]:
        if not isinstance(session, dict):
            raise AgentSessionError("session must be an object")
        session_id = session.get("id")
        title = session.get("title")
        messages = session.get("messages")
        if not isinstance(session_id, str) or not session_id or len(session_id) > 120:
            raise AgentSessionError("invalid session id")
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise AgentSessionError("invalid session title")
        if not isinstance(messages, list) or len(messages) > cls.MAX_MESSAGES:
            raise AgentSessionError("invalid session messages")
        clean_messages: list[dict[str, Any]] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
                raise AgentSessionError("invalid message role")
            content = message.get("content", "")
            if not isinstance(content, str) or len(content) > cls.MAX_MESSAGE_CHARS:
                raise AgentSessionError("message is too large")
            # Conversation metadata (plans and setup progress) is intentionally
            # retained, but unknown top-level values are ignored.
            item: dict[str, Any] = {"role": message["role"], "content": content}
            for key in ("id", "createdAt", "plan", "modelSetup", "remoteModelSetup", "remoteModel"):
                if key in message:
                    item[key] = message[key]
            clean_messages.append(item)
        updated = session.get("updatedAt", 0)
        created = session.get("createdAt", updated)
        if not isinstance(updated, (int, float)) or not isinstance(created, (int, float)):
            raise AgentSessionError("invalid session timestamps")
        return {"id": session_id, "title": title.strip(), "createdAt": created, "updatedAt": updated, "messages": clean_messages}

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload: Any = json.loads(self.path.read_text(encoding="utf-8"))
            for item in payload.get("sessions", []):
                try:
                    clean = self._validate(item)
                except AgentSessionError:
                    continue
                self._sessions[clean["id"]] = clean
            for item in payload.get("deleted", []):
                if not isinstance(item, dict):
                    continue
                session_id = item.get("id")
                deleted_at = item.get("deletedAt")
                if isinstance(session_id, str) and session_id and len(session_id) <= 120 and isinstance(deleted_at, (int, float)):
                    self._deleted[session_id] = float(deleted_at)
                    self._sessions.pop(session_id, None)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self._sessions = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        payload = {
            "sessions": list(self._sessions.values()),
            "deleted": [{"id": session_id, "deletedAt": deleted_at} for session_id, deleted_at in self._deleted.items()],
        }
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
