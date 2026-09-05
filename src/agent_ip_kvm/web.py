"""Minimal read-only web interface for Agent IP KVM."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import threading
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from typing import Callable, Iterator, Protocol
from urllib.parse import urlsplit

from . import __version__
from .video import (
    EndOfStream,
    FFmpegFileVideoSource,
    FFmpegV4L2VideoSource,
    Frame,
    SyntheticVideoSource,
    VideoSource,
    VideoSourceError,
    discover_v4l2_devices,
)


@dataclass(slots=True)
class WebConfig:
    source_kind: str = "synthetic"
    file_path: str | None = None
    device_path: str = "/dev/video0"
    width: int = 1920
    height: int = 1080
    fps: float = 30.0


def _make_source(config: WebConfig) -> VideoSource:
    if config.source_kind == "file":
        if not config.file_path:
            raise ValueError("file source requires a local video path")
        return FFmpegFileVideoSource(Path(config.file_path))
    if config.source_kind == "v4l2":
        return FFmpegV4L2VideoSource(
            config.device_path,
            width=config.width,
            height=config.height,
            fps=config.fps,
        )
    return SyntheticVideoSource()


def collect_status(config: WebConfig) -> dict[str, object]:
    source_payload: dict[str, object] = {
        "backend": config.source_kind,
        "source_id": None,
        "health": "unavailable",
        "capabilities": [],
        "error": None,
    }
    try:
        source = _make_source(config)
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
            "message": "等待浏览器连接",
        },
        "source": source_payload,
        "v4l2": {
            "status": report.status.value,
            "message": report.message,
            "devices": devices,
        },
    }


class StreamProvider(Protocol):
    def frames(self) -> Iterator[tuple[int, bytes]]: ...

    def status(self) -> dict[str, object]: ...

    def close(self) -> None: ...


SettingsUpdater = Callable[[dict[str, object]], dict[str, object]]


class _FFmpegJPEGEncoder:
    """Keep one FFmpeg process alive while converting RGB24 frames to JPEG."""

    def __init__(self, width: int, height: int, fps: float) -> None:
        executable = shutil.which("ffmpeg")
        if executable is None:
            raise VideoSourceError("ffmpeg is required to stream video in the browser")
        command = (
            executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            f"{width}x{height}",
            "-framerate",
            str(fps),
            "-i",
            "pipe:0",
            "-an",
            "-threads",
            "4",
            "-thread_type",
            "slice",
            "-pixel_format",
            "yuvj420p",
            "-c:v",
            "mjpeg",
            "-q:v",
            "5",
            "-f",
            "image2pipe",
            "-flush_packets",
            "1",
            "pipe:1",
        )
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            raise VideoSourceError(f"unable to start video encoder: {exc}") from exc
        self._buffer = bytearray()

    def encode(self, frame: Frame) -> bytes:
        process = self._process
        if process.stdin is None or process.stdout is None:
            raise VideoSourceError("video encoder pipe is unavailable")
        try:
            process.stdin.write(frame.data)
            process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise VideoSourceError(self._error_message("video encoder stopped")) from exc

        while True:
            start = self._buffer.find(b"\xff\xd8")
            end = self._buffer.find(b"\xff\xd9", max(start + 2, 0))
            if start >= 0 and end >= 0:
                jpeg = bytes(self._buffer[start : end + 2])
                del self._buffer[: end + 2]
                return jpeg
            chunk = process.stdout.read1(65536)
            if not chunk:
                raise VideoSourceError(self._error_message("video encoder returned no frame"))
            self._buffer.extend(chunk)
            if len(self._buffer) > 16 * 1024 * 1024:
                raise VideoSourceError("video encoder produced an oversized frame")

    def close(self) -> None:
        process = self._process
        if process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def _error_message(self, fallback: str) -> str:
        if self._process.stderr is None:
            return fallback
        raw = self._process.stderr.read()
        detail = " ".join(raw.decode("utf-8", errors="replace").split())
        return f"{fallback}: {detail}" if detail else fallback


class _PassthroughJPEGEncoder:
    def encode(self, frame: Frame) -> bytes:
        frame.validate()
        return frame.data

    def close(self) -> None:
        return


class VideoStreamController:
    """Capture and encode once, then share the latest frame with all viewers."""

    _TERMINAL_STATES = {"ended", "error", "stopped"}

    def __init__(
        self,
        config: WebConfig,
        *,
        source_factory: Callable[[WebConfig], VideoSource] = _make_source,
        encoder_factory: Callable[[int, int, float], _FFmpegJPEGEncoder] = _FFmpegJPEGEncoder,
    ) -> None:
        self._config = config
        self._source_factory = source_factory
        self._encoder_factory = encoder_factory
        self._condition = threading.Condition()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "idle"
        self._message = "等待浏览器连接"
        self._error: str | None = None
        self._sequence = -1
        self._jpeg: bytes | None = None
        self._generation = 0

    def frames(self) -> Iterator[tuple[int, bytes]]:
        self._ensure_started()
        last_sequence = -1
        with self._condition:
            generation = self._generation
        while True:
            with self._condition:
                self._condition.wait_for(
                    lambda: self._sequence != last_sequence
                    or self._state in self._TERMINAL_STATES
                    or self._generation != generation,
                    timeout=5,
                )
                if self._generation != generation:
                    return
                if self._sequence != last_sequence and self._jpeg is not None:
                    last_sequence = self._sequence
                    current = (last_sequence, self._jpeg)
                else:
                    current = None
                    terminal = self._state in self._TERMINAL_STATES
            if current is not None:
                yield current
            elif terminal:
                return

    def status(self) -> dict[str, object]:
        with self._condition:
            return {
                "state": self._state,
                "message": self._message,
                "sequence": self._sequence if self._sequence >= 0 else None,
                "error": self._error,
            }

    def close(self) -> None:
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=3)

    def update_mode(self, width: int, height: int, fps: float) -> None:
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=3)
            if thread.is_alive():
                raise VideoSourceError("video source did not stop before reconfiguration")
        with self._condition:
            self._config.width = width
            self._config.height = height
            self._config.fps = fps
            self._thread = None
            self._generation += 1
            self._sequence = -1
            self._jpeg = None
            self._state = "idle"
            self._message = "等待浏览器连接"
            self._error = None
            self._stop_event.clear()
            self._condition.notify_all()

    def _ensure_started(self) -> None:
        with self._condition:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._state = "starting"
            self._message = "正在启动视频流"
            self._error = None
            self._sequence = -1
            self._jpeg = None
            self._thread = threading.Thread(target=self._produce, daemon=True)
            self._thread.start()

    def _produce(self) -> None:
        source: VideoSource | None = None
        encoder: _FFmpegJPEGEncoder | None = None
        try:
            source = self._source_factory(self._config)
            mode = source.open()
            if mode.pixel_format == "MJPEG":
                encoder = _PassthroughJPEGEncoder()
            else:
                encoder = self._encoder_factory(mode.width, mode.height, mode.fps)
            source.start()
            self._set_state("streaming", "视频流传输中")
            while not self._stop_event.is_set():
                frame = source.next_frame()
                jpeg = encoder.encode(frame)
                with self._condition:
                    self._sequence = frame.sequence
                    self._jpeg = jpeg
                    self._condition.notify_all()
        except EndOfStream:
            self._set_state("ended", "视频已结束")
        except (OSError, ValueError, RuntimeError) as exc:
            self._set_state("error", "视频流不可用", str(exc))
        finally:
            if source is not None:
                source.close()
            if encoder is not None:
                encoder.close()
            if self._stop_event.is_set():
                self._set_state("stopped", "视频流已停止")

    def _set_state(self, state: str, message: str, error: str | None = None) -> None:
        with self._condition:
            self._state = state
            self._message = message
            self._error = error
            self._condition.notify_all()


def _read_asset(name: str) -> bytes:
    return files("agent_ip_kvm").joinpath("web_assets", name).read_bytes()


def create_handler(
    config: WebConfig,
    *,
    status_provider: Callable[[WebConfig], dict[str, object]] = collect_status,
    stream_provider: StreamProvider | None = None,
    settings_updater: SettingsUpdater | None = None,
) -> type[BaseHTTPRequestHandler]:
    stream = stream_provider or VideoStreamController(config)
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
                payload = status_provider(config)
                payload["stream"] = stream.status()
                self._send_json(payload)
                return
            if path == "/api/stream.mjpg":
                self._send_mjpeg()
                return
            asset = assets.get(path)
            if asset is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            name, content_type = asset
            self._send_bytes(_read_asset(name), content_type)

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path != "/api/video-settings" or settings_updater is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > 4096:
                self._send_json({"error": "invalid request body"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("request body must be a JSON object")
                video = settings_updater(payload)
            except (json.JSONDecodeError, TypeError, ValueError, VideoSourceError) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"video": video})

        def _send_json(
            self,
            payload: dict[str, object],
            status: HTTPStatus = HTTPStatus.OK,
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8", status)

        def _send_bytes(
            self,
            body: bytes,
            content_type: str,
            status: HTTPStatus = HTTPStatus.OK,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'")
            self.end_headers()
            self.wfile.write(body)

        def _send_mjpeg(self) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                for sequence, jpeg in stream.frames():
                    header = (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(jpeg)}\r\n".encode("ascii")
                        + f"X-Sequence: {sequence}\r\n\r\n".encode("ascii")
                    )
                    self.wfile.write(header)
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

        def log_message(self, format: str, *args: object) -> None:
            return

    return RequestHandler


class KVMHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], config: WebConfig) -> None:
        self.config = config
        self.stream_controller = VideoStreamController(config)
        super().__init__(
            server_address,
            create_handler(
                config,
                stream_provider=self.stream_controller,
                settings_updater=self.update_video_settings,
            ),
        )

    def update_video_settings(self, payload: dict[str, object]) -> dict[str, object]:
        if self.config.source_kind != "v4l2":
            raise ValueError("current video source does not support mode changes")
        try:
            width = int(payload["width"])
            height = int(payload["height"])
            fps = float(payload["fps"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("width, height, and fps are required") from exc

        report = discover_v4l2_devices(device_paths=(self.config.device_path,))
        device = next(
            (item for item in report.devices if item.device_path == self.config.device_path),
            None,
        )
        supported = device is not None and any(
            mode.width == width
            and mode.height == height
            and abs(mode.fps - fps) < 0.01
            and mode.pixel_format in {"MJPG", "MJPEG"}
            for mode in device.capabilities
        )
        if not supported:
            raise ValueError("selected MJPEG mode is not supported by the capture device")

        self.stream_controller.update_mode(width, height, fps)
        return {"width": width, "height": height, "fps": fps}

    def server_close(self) -> None:
        self.stream_controller.close()
        super().server_close()


def create_server(host: str, port: int, config: WebConfig) -> KVMHTTPServer:
    return KVMHTTPServer((host, port), config)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-web")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--source", choices=("synthetic", "file", "v4l2"), default="synthetic")
    parser.add_argument("--file", help="local video path when --source=file")
    parser.add_argument("--device", default="/dev/video0", help="V4L2 device when --source=v4l2")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=float, default=30.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.source == "file" and not args.file:
        _parser().error("--file is required when --source=file")
    config = WebConfig(
        source_kind=args.source,
        file_path=args.file,
        device_path=args.device,
        width=args.width,
        height=args.height,
        fps=args.fps,
    )
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
