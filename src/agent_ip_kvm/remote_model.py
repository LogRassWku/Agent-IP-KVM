"""Small, provider-neutral OpenAI-compatible remote model adapter."""

from __future__ import annotations

import json
import os
import re
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REMOTE_MODEL_CATALOG = (
    {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "description": "默认：速度和能力平衡，支持工具调用",
    },
    {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "description": "更强：复杂任务，响应和费用更高",
    },
    {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat（兼容）",
        "description": "兼容旧配置，官方建议逐步迁移到 V4 Flash",
    },
    {
        "id": "deepseek-reasoner",
        "name": "DeepSeek Reasoner（兼容）",
        "description": "兼容旧配置，官方建议逐步迁移到 V4 系列",
    },
)

_MODEL_IDS = {item["id"] for item in REMOTE_MODEL_CATALOG}
_KEY_RE = re.compile(r"^[A-Za-z0-9._\-]{20,256}$")


class RemoteModelError(ValueError):
    """Raised when remote model configuration or requests are invalid."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RemoteModelStore:
    """Persist a single local remote-model configuration and proxy chat calls."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._config: dict[str, str] = {}
        self._load()

    @property
    def configured(self) -> bool:
        with self._lock:
            return bool(self._config.get("api_key"))

    def catalog(self) -> dict[str, object]:
        with self._lock:
            config = dict(self._config)
        return {
            "provider": "DeepSeek",
            "base_url": config.get("base_url", "https://api.deepseek.com"),
            "model": config.get("model", "deepseek-v4-flash"),
            "models": list(REMOTE_MODEL_CATALOG),
            "configured": bool(config.get("api_key")),
            "updated_at": config.get("updated_at"),
        }

    def public(self) -> dict[str, object]:
        return self.catalog()

    def save(self, payload: dict[str, object]) -> dict[str, object]:
        base_url = payload.get("base_url", "https://api.deepseek.com")
        model = payload.get("model", "deepseek-v4-flash")
        api_key = payload.get("api_key")
        if not isinstance(base_url, str):
            raise RemoteModelError("base_url must be a string")
        base_url = base_url.strip().rstrip("/")
        if not self._valid_base_url(base_url):
            raise RemoteModelError("base_url must use HTTPS (or HTTP for a private LAN endpoint)")
        if not isinstance(model, str) or model not in _MODEL_IDS:
            raise RemoteModelError("unsupported remote model")
        if not isinstance(api_key, str) or not _KEY_RE.fullmatch(api_key.strip()):
            raise RemoteModelError("api_key must be a non-empty provider key")
        now = _utc_now()
        with self._lock:
            self._config = {"base_url": base_url, "model": model, "api_key": api_key.strip(), "updated_at": now}
            self._save()
        return self.public()

    def clear(self) -> dict[str, object]:
        with self._lock:
            self._config = {}
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
        return self.public()

    def chat(self, messages: list[dict[str, str]], *, timeout: float = 90.0) -> dict[str, object]:
        if not isinstance(messages, list) or not messages or len(messages) > 30:
            raise RemoteModelError("messages must contain 1 to 30 items")
        clean: list[dict[str, str]] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}:
                raise RemoteModelError("messages contain an unsupported role")
            content = message.get("content")
            if not isinstance(content, str) or not content.strip() or len(content) > 12000:
                raise RemoteModelError("message content is invalid")
            clean.append({"role": str(message["role"]), "content": content})
        with self._lock:
            config = dict(self._config)
        if not config.get("api_key"):
            raise RemoteModelError("remote model is not configured")
        endpoint = config["base_url"] + "/chat/completions"
        body = json.dumps({"model": config["model"], "messages": clean, "stream": False}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(2_000_000)
        except urllib.error.HTTPError as exc:
            detail = exc.read(2_000).decode("utf-8", errors="replace")
            raise RemoteModelError(f"remote API returned HTTP {exc.code}: {detail[:300]}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RemoteModelError(f"remote API connection failed: {exc}") from exc
        try:
            result: Any = json.loads(raw.decode("utf-8"))
            content = result["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RemoteModelError("remote API returned an invalid chat response") from exc
        if not isinstance(content, str):
            raise RemoteModelError("remote API response content is not text")
        return {"content": content, "model": result.get("model", config["model"]), "usage": result.get("usage")}

    @staticmethod
    def _valid_base_url(value: str) -> bool:
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        if parsed.path or parsed.query or parsed.fragment or not parsed.hostname:
            return False
        if parsed.scheme == "https":
            return True
        if parsed.scheme != "http":
            return False
        host = parsed.hostname.lower()
        return host in {"localhost", "127.0.0.1", "::1"} or host.startswith("192.168.") or host.startswith("10.")

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload: Any = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                self._config = {key: str(payload[key]) for key in ("base_url", "model", "api_key", "updated_at") if key in payload}
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self._config = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(json.dumps(self._config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

