"""Recoverable background jobs for remote Agent requests."""

from __future__ import annotations

import json
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any


class AgentChatJobError(ValueError):
    pass


class AgentChatJobStore:
    """Keep bounded Agent results long enough for browsers to reconnect."""

    MAX_JOBS = 100

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._request_ids: dict[str, str] = {}

    def create(self, request_id: str, work: Callable[[], dict[str, object]]) -> dict[str, object]:
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 120:
            raise AgentChatJobError("request_id must be a non-empty string")
        request_id = request_id.strip()
        with self._lock:
            existing_id = self._request_ids.get(request_id)
            if existing_id is not None:
                return self._public(self._jobs[existing_id])
            now = time.time() * 1000
            job_id = uuid.uuid4().hex
            job: dict[str, Any] = {
                "job_id": job_id,
                "request_id": request_id,
                "status": "queued",
                "created_at": now,
                "updated_at": now,
            }
            self._jobs[job_id] = job
            self._request_ids[request_id] = job_id
            self._trim_locked()
        threading.Thread(target=self._run, args=(job_id, work), daemon=True, name=f"agent-chat-{job_id[:8]}").start()
        return self.get(job_id)

    def get(self, job_id: str) -> dict[str, object]:
        if not isinstance(job_id, str) or not job_id or len(job_id) > 120:
            raise AgentChatJobError("invalid Agent job id")
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise AgentChatJobError("Agent job not found")
            return self._public(job)

    def _run(self, job_id: str, work: Callable[[], dict[str, object]]) -> None:
        self._update(job_id, status="running")
        try:
            result = work()
            json.dumps(result, ensure_ascii=False)
        except Exception as exc:  # The browser receives a bounded job failure instead of losing the request.
            self._update(job_id, status="failed", error=str(exc)[:1000])
            return
        self._update(job_id, status="completed", result=result)

    def _update(self, job_id: str, **values: object) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.update(values)
            job["updated_at"] = time.time() * 1000

    def _trim_locked(self) -> None:
        if len(self._jobs) <= self.MAX_JOBS:
            return
        removable = sorted(
            (job for job in self._jobs.values() if job["status"] in {"completed", "failed"}),
            key=lambda job: float(job["updated_at"]),
        )
        while len(self._jobs) > self.MAX_JOBS and removable:
            job = removable.pop(0)
            self._jobs.pop(job["job_id"], None)
            self._request_ids.pop(job["request_id"], None)

    @staticmethod
    def _public(job: dict[str, Any]) -> dict[str, object]:
        return json.loads(json.dumps(job, ensure_ascii=False))
