"""Minimal read-only web interface for Agent IP KVM."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from . import __version__
from .video import FFmpegFileVideoSource, SyntheticVideoSource, discover_v4l2_devices


@dataclass(frozen=True, slots=True)
class WebConfig:
    source_kind: str = "synthetic"
    file_path: str | None = None


def collect_status(config: WebConfig) -> dict[str, object]:
    source_payload: dict[str, object] = {
        "backend": config.source_kind,
        "source_id": None,
        "health": "unavailable",
        "capabilities": [],
        "error": None,
    }
    try:
        if config.source_kind == "file":
            if not config.file_path:
                raise ValueError("file source requires a local video path")
            source = FFmpegFileVideoSource(Path(config.file_path))
        else:
            source = SyntheticVideoSource()
        capabilities = source.capabilities()
        source_payload.update(
            {
                "source_id": source.source_id,
                "health": "available",
                "capabilities": [asdict(capability) for capability in capabilities],
            }
        )
    except (OSError, ValueError, RuntimeError) as exc:
        source_payload["error"] = str(exc)

    report = discover_v4l2_devices()
    devices = [
        {
            "source_id": device.source_id,
            "device_path": device.device_path,
            "display_name": device.display_name,
            "driver": device.driver,
            "bus_info": device.bus_info,
            "node_kind": device.node_kind.value,
            "supports_video_capture": device.supports_video_capture,
            "capabilities": [asdict(capability) for capability in device.capabilities],
            "error": device.error,
        }
        for device in report.devices
    ]
    return {
        "service": {"name": "Agent IP KVM", "version": __version__},
        "stream": {
            "state": "idle",
            "message": "视频源已就绪，实时画面将在下一步接入",
        },
        "source": source_payload,
        "v4l2": {
            "status": report.status.value,
            "message": report.message,
            "devices": devices,
        },
    }


def _read_asset(name: str) -> bytes:
    return files("agent_ip_kvm").joinpath("web_assets", name).read_bytes()


def create_handler(
    config: WebConfig,
    *,
    status_provider: Callable[[WebConfig], dict[str, object]] = collect_status,
) -> type[BaseHTTPRequestHandler]:
    assets = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    }

    class RequestHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/api/status":
                self._send_json(status_provider(config))
                return
            asset = assets.get(path)
            if asset is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            name, content_type = asset
            self._send_bytes(_read_asset(name), content_type)

        def _send_json(self, payload: dict[str, object]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8")

        def _send_bytes(self, body: bytes, content_type: str) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    return RequestHandler


def create_server(host: str, port: int, config: WebConfig) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), create_handler(config))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-web")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--source", choices=("synthetic", "file"), default="synthetic")
    parser.add_argument("--file", help="local video path when --source=file")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.source == "file" and not args.file:
        _parser().error("--file is required when --source=file")
    config = WebConfig(source_kind=args.source, file_path=args.file)
    server = create_server(args.host, args.port, config)
    print(f"Agent IP KVM web interface: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

