"""Minimal read-only web interface for Agent IP KVM."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
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
from .hid import (
    HidAdapter,
    HidError,
    HidState,
    LinuxGadgetHidAdapter,
    MouseButton,
    SimulatedHidAdapter,
)
from .hid.linux_gadget import KEY_USAGES, resolve_hidg_path, wait_for_hidg_path
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


class HidWebController:
    """Expose a deliberately small, serialized HID surface to the Web UI."""

    _MODIFIERS = {"ctrl", "shift", "alt", "win"}
    _MOUSE_BUTTONS = {
        "left": MouseButton.LEFT,
        "right": MouseButton.RIGHT,
        "middle": MouseButton.MIDDLE,
    }

    def __init__(self, adapter: HidAdapter | None = None, *, backend: str = "disabled") -> None:
        self._adapter = adapter
        self._backend = backend
        self._lock = threading.Lock()

    def status(self) -> dict[str, object]:
        adapter = self._adapter
        return {
            "enabled": adapter is not None,
            "backend": self._backend,
            "state": adapter.state.value if adapter is not None else (
                "disabled" if self._backend == "disabled" else "disconnected"
            ),
        }

    def tap_key(self, payload: dict[str, object]) -> dict[str, object]:
        adapter = self._require_adapter()
        key = payload.get("key")
        modifiers = payload.get("modifiers", [])
        if not isinstance(key, str) or key not in KEY_USAGES:
            raise ValueError("unsupported key")
        if not isinstance(modifiers, list) or any(
            not isinstance(item, str) or item not in self._MODIFIERS for item in modifiers
        ):
            raise ValueError("unsupported modifier")
        if len(set(modifiers)) != len(modifiers):
            raise ValueError("duplicate modifier")

        with self._lock:
            if adapter.state is HidState.CLOSED:
                adapter.arm()
            if adapter.state is not HidState.READY:
                raise HidError(f"HID is not ready: {adapter.state.value}")
            operation_error: Exception | None = None
            try:
                for modifier in modifiers:
                    adapter.key_down(modifier)
                adapter.key_down(key)
                adapter.key_up(key)
                for modifier in reversed(modifiers):
                    adapter.key_up(modifier)
            except Exception as exc:
                operation_error = exc
                raise
            finally:
                try:
                    adapter.release_all()
                except Exception:
                    if operation_error is None:
                        raise
        return {"key": key, "modifiers": modifiers}

    def move_mouse(self, payload: dict[str, object]) -> dict[str, object]:
        adapter = self._require_adapter()
        delta_x = self._integer(payload.get("delta_x", 0), "delta_x")
        delta_y = self._integer(payload.get("delta_y", 0), "delta_y")
        wheel = self._integer(payload.get("wheel", 0), "wheel")
        if not -4096 <= delta_x <= 4096 or not -4096 <= delta_y <= 4096:
            raise ValueError("mouse movement must be between -4096 and 4096")
        if not -127 <= wheel <= 127:
            raise ValueError("wheel must be between -127 and 127")
        with self._lock:
            self._arm(adapter)
            remaining_x, remaining_y = delta_x, delta_y
            while remaining_x or remaining_y:
                step_x = max(-127, min(127, remaining_x))
                step_y = max(-127, min(127, remaining_y))
                adapter.mouse_move(step_x, step_y)
                remaining_x -= step_x
                remaining_y -= step_y
            if wheel:
                adapter.mouse_move(0, 0, wheel)
        return {"delta_x": delta_x, "delta_y": delta_y, "wheel": wheel}

    def click_mouse(self, payload: dict[str, object]) -> dict[str, object]:
        adapter = self._require_adapter()
        name = payload.get("button")
        if not isinstance(name, str) or name not in self._MOUSE_BUTTONS:
            raise ValueError("unsupported mouse button")
        button = self._MOUSE_BUTTONS[name]
        with self._lock:
            self._arm(adapter)
            operation_error: Exception | None = None
            try:
                adapter.button_down(button)
                adapter.button_up(button)
            except Exception as exc:
                operation_error = exc
                raise
            finally:
                try:
                    adapter.release_all()
                except Exception:
                    if operation_error is None:
                        raise
        return {"button": name}

    def release_all(self) -> None:
        adapter = self._require_adapter()
        with self._lock:
            if adapter.state is HidState.CLOSED:
                adapter.arm()
            adapter.release_all()

    def close(self) -> None:
        adapter = self._adapter
        if adapter is not None:
            with self._lock:
                adapter.close()

    def _require_adapter(self) -> HidAdapter:
        if self._adapter is None:
            raise HidError("HID output is not enabled on this server")
        return self._adapter

    @staticmethod
    def _integer(value: object, name: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"{name} must be an integer")
        return value

    @staticmethod
    def _arm(adapter: HidAdapter) -> None:
        if adapter.state is HidState.CLOSED:
            adapter.arm()
        if adapter.state is not HidState.READY:
            raise HidError(f"HID is not ready: {adapter.state.value}")


HidDeviceResolver = Callable[[], tuple[Path, Path] | None]
HidAdapterFactory = Callable[[Path, Path], HidAdapter]


def _linux_hid_device_resolver(
    gadget_root: Path,
    dev_root: Path = Path("/dev"),
    keyboard_function: str = "hid.keyboard",
    mouse_function: str = "hid.mouse",
) -> HidDeviceResolver:
    def resolve() -> tuple[Path, Path] | None:
        try:
            udc_name = (gadget_root / "UDC").read_text(encoding="ascii").strip()
            if not udc_name:
                return None
            state = Path("/sys/class/udc", udc_name, "state").read_text(
                encoding="ascii"
            ).strip()
            if state != "configured":
                return None
            functions = gadget_root / "functions"
            keyboard_path = resolve_hidg_path(functions / keyboard_function, dev_root)
            mouse_path = resolve_hidg_path(functions / mouse_function, dev_root)
            if not os.access(keyboard_path, os.W_OK) or not os.access(mouse_path, os.W_OK):
                return None
            return keyboard_path, mouse_path
        except (OSError, HidError):
            return None

    return resolve


class AutoLinuxHidController(HidWebController):
    """Attach to Gadget HID endpoints when a USB host configures them."""

    def __init__(
        self,
        device_resolver: HidDeviceResolver,
        adapter_factory: HidAdapterFactory = LinuxGadgetHidAdapter,
    ) -> None:
        super().__init__(backend="linux-auto")
        self._device_resolver = device_resolver
        self._adapter_factory = adapter_factory
        self._device_signature: tuple[Path, Path] | None = None

    def status(self) -> dict[str, object]:
        self._sync()
        return super().status()

    def _require_adapter(self) -> HidAdapter:
        self._sync()
        return super()._require_adapter()

    def _sync(self) -> None:
        signature = self._device_resolver()
        with self._lock:
            if signature == self._device_signature and self._adapter is not None:
                if self._adapter.state is not HidState.ERROR:
                    return
            if self._adapter is not None:
                with contextlib.suppress(HidError, OSError):
                    self._adapter.close()
                self._adapter = None
                self._device_signature = None
            if signature is not None:
                self._adapter = self._adapter_factory(*signature)
                self._device_signature = signature


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
    hid_controller: HidWebController | None = None,
) -> type[BaseHTTPRequestHandler]:
    stream = stream_provider or VideoStreamController(config)
    hid = hid_controller or HidWebController()
    assets = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/cursor-small.svg": ("cursor-small.svg", "image/svg+xml"),
        "/cursor-medium.svg": ("cursor-medium.svg", "image/svg+xml"),
        "/cursor-large.svg": ("cursor-large.svg", "image/svg+xml"),
    }

    class RequestHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/api/status":
                payload = status_provider(config)
                payload["stream"] = stream.status()
                payload["hid"] = hid.status()
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
            if path not in {
                "/api/video-settings",
                "/api/hid/key",
                "/api/hid/mouse-move",
                "/api/hid/mouse-click",
                "/api/hid/release",
            }:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if content_type != "application/json":
                self._send_json(
                    {"error": "Content-Type must be application/json"},
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                )
                return
            origin = self.headers.get("Origin")
            host = self.headers.get("Host")
            if origin:
                parsed_origin = urlsplit(origin)
                if parsed_origin.scheme not in {"http", "https"} or parsed_origin.netloc != host:
                    self._send_json(
                        {"error": "cross-origin control requests are not allowed"},
                        HTTPStatus.FORBIDDEN,
                    )
                    return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length < 0 or length > 4096 or (length == 0 and path != "/api/hid/release"):
                self._send_json({"error": "invalid request body"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                payload = json.loads(self.rfile.read(length)) if length else {}
                if not isinstance(payload, dict):
                    raise ValueError("request body must be a JSON object")
                if path == "/api/video-settings":
                    if settings_updater is None:
                        self.send_error(HTTPStatus.NOT_FOUND)
                        return
                    result = {"video": settings_updater(payload)}
                elif path == "/api/hid/key":
                    result = {"hid": hid.tap_key(payload)}
                elif path == "/api/hid/mouse-move":
                    result = {"hid": hid.move_mouse(payload)}
                elif path == "/api/hid/mouse-click":
                    result = {"hid": hid.click_mouse(payload)}
                else:
                    hid.release_all()
                    result = {"hid": hid.status()}
            except (json.JSONDecodeError, TypeError, ValueError, VideoSourceError, HidError) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json(result)

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

    def __init__(
        self,
        server_address: tuple[str, int],
        config: WebConfig,
        hid_adapter: HidAdapter | None = None,
        *,
        hid_backend: str = "disabled",
        hid_controller: HidWebController | None = None,
    ) -> None:
        self.config = config
        self.stream_controller = VideoStreamController(config)
        self.hid_controller = hid_controller or HidWebController(
            hid_adapter, backend=hid_backend
        )
        super().__init__(
            server_address,
            create_handler(
                config,
                stream_provider=self.stream_controller,
                settings_updater=self.update_video_settings,
                hid_controller=self.hid_controller,
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
        self.hid_controller.close()
        super().server_close()


def create_server(
    host: str,
    port: int,
    config: WebConfig,
    hid_adapter: HidAdapter | None = None,
    *,
    hid_backend: str = "disabled",
    hid_controller: HidWebController | None = None,
) -> KVMHTTPServer:
    return KVMHTTPServer(
        (host, port),
        config,
        hid_adapter=hid_adapter,
        hid_backend=hid_backend,
        hid_controller=hid_controller,
    )


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
    parser.add_argument(
        "--enable-hid",
        action="store_true",
        help="explicitly enable Web keyboard output",
    )
    parser.add_argument(
        "--hid-backend",
        choices=("auto", "linux", "simulated"),
        default="auto",
        help="auto discovers connected Linux Gadget HID endpoints",
    )
    parser.add_argument(
        "--gadget-root",
        type=Path,
        default=Path("/sys/kernel/config/usb_gadget/g_comp"),
    )
    parser.add_argument("--keyboard-function", default="hid.keyboard")
    parser.add_argument("--mouse-function", default="hid.mouse")
    parser.add_argument("--hid-timeout", type=float, default=10.0)
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
    hid_adapter: HidAdapter | None = None
    hid_controller: HidWebController | None = None
    if args.hid_backend == "auto":
        hid_controller = AutoLinuxHidController(
            _linux_hid_device_resolver(
                args.gadget_root,
                keyboard_function=args.keyboard_function,
                mouse_function=args.mouse_function,
            )
        )
    elif args.enable_hid:
        if args.hid_backend == "simulated":
            hid_adapter = SimulatedHidAdapter()
        else:
            functions = args.gadget_root / "functions"
            keyboard_path = wait_for_hidg_path(
                functions / args.keyboard_function, timeout_seconds=args.hid_timeout
            )
            mouse_path = wait_for_hidg_path(
                functions / args.mouse_function, timeout_seconds=args.hid_timeout
            )
            hid_adapter = LinuxGadgetHidAdapter(keyboard_path, mouse_path)
    server = create_server(
        args.host,
        args.port,
        config,
        hid_adapter=hid_adapter,
        hid_backend=args.hid_backend if args.enable_hid else "disabled",
        hid_controller=hid_controller,
    )
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
