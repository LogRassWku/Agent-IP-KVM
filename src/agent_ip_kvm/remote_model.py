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

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        timeout: float = 90.0,
        tools: list[dict[str, object]] | None = None,
        tool_choice: str = "auto",
    ) -> dict[str, object]:
        if not isinstance(messages, list) or not messages or len(messages) > 48:
            raise RemoteModelError("messages must contain 1 to 48 items")
        clean: list[dict[str, Any]] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant", "tool"}:
                raise RemoteModelError("messages contain an unsupported role")
            role = str(message["role"])
            content = message.get("content")
            max_content = 32000 if role in {"system", "tool"} else 12000
            tool_calls = self._clean_tool_calls(message.get("tool_calls")) if role == "assistant" else []
            if content is not None and (not isinstance(content, str) or len(content) > max_content):
                raise RemoteModelError("message content is invalid")
            if role != "assistant" and (not isinstance(content, str) or not content.strip()):
                raise RemoteModelError("message content is invalid")
            if role == "assistant" and not tool_calls and (not isinstance(content, str) or not content.strip()):
                raise RemoteModelError("assistant message must contain content or tool calls")
            item: dict[str, Any] = {"role": role, "content": content}
            if role == "assistant" and tool_calls:
                item["tool_calls"] = tool_calls
            if role == "tool":
                tool_call_id = message.get("tool_call_id")
                if not isinstance(tool_call_id, str) or not tool_call_id or len(tool_call_id) > 128:
                    raise RemoteModelError("tool message requires a valid tool_call_id")
                item["tool_call_id"] = tool_call_id
            clean.append(item)
        if tools is not None:
            if not isinstance(tools, list) or not tools or len(tools) > 16:
                raise RemoteModelError("tools must contain 1 to 16 definitions")
            if tool_choice not in {"auto", "none", "required"}:
                raise RemoteModelError("unsupported tool choice")
            try:
                encoded_tools = json.dumps(tools, ensure_ascii=False)
            except (TypeError, ValueError) as exc:
                raise RemoteModelError("tools are not JSON serializable") from exc
            if len(encoded_tools) > 64000:
                raise RemoteModelError("tool definitions are too large")
        with self._lock:
            config = dict(self._config)
        if not config.get("api_key"):
            raise RemoteModelError("remote model is not configured")
        endpoint = config["base_url"] + "/chat/completions"
        payload: dict[str, object] = {
            "model": config["model"],
            "messages": clean,
            "stream": False,
        }
        if tools is not None:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
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
            response_message = result["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RemoteModelError("remote API returned an invalid chat response") from exc
        if not isinstance(response_message, dict):
            raise RemoteModelError("remote API returned an invalid assistant message")
        content = response_message.get("content")
        tool_calls = self._clean_tool_calls(response_message.get("tool_calls"))
        if content is not None and not isinstance(content, str):
            raise RemoteModelError("remote API response content is invalid")
        if not tool_calls and (not isinstance(content, str) or not content.strip()):
            raise RemoteModelError("remote API response contains neither text nor tool calls")
        clean_message: dict[str, object] = {"role": "assistant", "content": content}
        if tool_calls:
            clean_message["tool_calls"] = tool_calls
        return {
            "content": content or "",
            "model": result.get("model", config["model"]),
            "usage": result.get("usage"),
            "tool_calls": tool_calls,
            "message": clean_message,
        }

    @staticmethod
    def _clean_tool_calls(value: object) -> list[dict[str, object]]:
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > 8:
            raise RemoteModelError("remote API returned invalid tool calls")
        clean: list[dict[str, object]] = []
        for call in value:
            if not isinstance(call, dict) or call.get("type") != "function":
                raise RemoteModelError("remote API returned an unsupported tool call")
            call_id = call.get("id")
            function = call.get("function")
            if not isinstance(call_id, str) or not call_id or len(call_id) > 128:
                raise RemoteModelError("remote API returned an invalid tool call id")
            if not isinstance(function, dict):
                raise RemoteModelError("remote API returned an invalid tool function")
            name = function.get("name")
            arguments = function.get("arguments")
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
                raise RemoteModelError("remote API returned an invalid tool name")
            if not isinstance(arguments, str) or len(arguments) > 12000:
                raise RemoteModelError("remote API returned invalid tool arguments")
            clean.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments},
                }
            )
        return clean

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
