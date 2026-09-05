"""Minimal read-only web interface for Agent IP KVM."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from typing import Callable, Iterator, Protocol
from urllib.parse import urlsplit

from . import __version__
from .agent_control import (
    AgentConflictError,
    AgentControlError,
    AgentCoordinator,
    AuditLog,
    PcAgentSuggestionStore,
    PeerAuthenticationError,
    PeerTokenAuthenticator,
)
from .host_info import HostInfoStore
from .model_setup import ModelSetupError, ModelSetupStore
from .remote_model import RemoteModelError, RemoteModelStore
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
    host_info_path: Path = Path("data/controlled-host.json")
    audit_path: Path = Path("data/audit.jsonl")
    pc_agent_token_path: Path = Path("data/pc-agent-token")
    pc_agent_suggestion_path: Path = Path("data/pc-agent-suggestion.json")
    model_setup_path: Path = Path("data/model-setup-tasks.json")
    pc_agent_callback_url: str = "http://192.168.128.10:8765"
    remote_model_path: Path = Path("data/remote-model.json")


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

    def snapshot(self) -> tuple[bytes, dict[str, object]]: ...

    def pause(self) -> None: ...

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
    _SHIFTED_CHARACTERS = {
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
        "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=",
        "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "~": "`",
        "<": ",", ">": ".", "?": "/",
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
        if not isinstance(key, str) or (
            key not in KEY_USAGES and key not in self._MODIFIERS
        ):
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

    def type_text(self, text: str, *, key_delay: float = 0.008) -> dict[str, object]:
        """Type a bounded ASCII command through the boot-keyboard endpoint."""
        if not isinstance(text, str) or not text or len(text) > 1024:
            raise ValueError("text must contain between 1 and 1024 characters")
        strokes: list[tuple[str, bool]] = []
        for character in text:
            if character == " ":
                strokes.append(("space", False))
            elif "a" <= character <= "z" or character in "0123456789-= []\\;'`,./".replace(" ", ""):
                strokes.append((character, False))
            elif "A" <= character <= "Z":
                strokes.append((character.lower(), True))
            elif character in self._SHIFTED_CHARACTERS:
                strokes.append((self._SHIFTED_CHARACTERS[character], True))
            else:
                raise ValueError(f"text contains an unsupported character: {character!r}")
        adapter = self._require_adapter()
        with self._lock:
            self._arm(adapter)
            operation_error: Exception | None = None
            try:
                for key, shifted in strokes:
                    if shifted:
                        adapter.key_down("shift")
                    adapter.key_down(key)
                    adapter.key_up(key)
                    if shifted:
                        adapter.key_up("shift")
                    if key_delay:
                        time.sleep(key_delay)
            except Exception as exc:
                operation_error = exc
                raise
            finally:
                try:
                    adapter.release_all()
                except Exception:
                    if operation_error is None:
                        raise
        return {"characters": len(text)}

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

    def position_mouse(self, payload: dict[str, object]) -> dict[str, object]:
        adapter = self._require_adapter()
        x = self._integer(payload.get("x"), "x")
        y = self._integer(payload.get("y"), "y")
        wheel = self._integer(payload.get("wheel", 0), "wheel")
        if not 0 <= x <= 32767 or not 0 <= y <= 32767:
            raise ValueError("mouse position must be between 0 and 32767")
        if not -127 <= wheel <= 127:
            raise ValueError("wheel must be between -127 and 127")
        with self._lock:
            self._arm(adapter)
            adapter.mouse_position(x, y, wheel)
        return {"x": x, "y": y, "wheel": wheel}

    def click_mouse(self, payload: dict[str, object]) -> dict[str, object]:
        adapter = self._require_adapter()
        name = payload.get("button")
        if not isinstance(name, str) or name not in self._MOUSE_BUTTONS:
            raise ValueError("unsupported mouse button")
        button = self._MOUSE_BUTTONS[name]
        with self._lock:
            self._arm(adapter)
            if "x" in payload or "y" in payload:
                x = self._integer(payload.get("x"), "x")
                y = self._integer(payload.get("y"), "y")
                if not 0 <= x <= 32767 or not 0 <= y <= 32767:
                    raise ValueError("mouse position must be between 0 and 32767")
                adapter.mouse_position(x, y)
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


HidDeviceResolver = Callable[[], tuple[Path, Path | None, Path | None] | None]
HidAdapterFactory = Callable[[Path, Path | None, Path | None], HidAdapter]


def _linux_hid_device_resolver(
    gadget_root: Path,
    dev_root: Path = Path("/dev"),
    keyboard_function: str = "hid.keyboard",
    mouse_function: str = "hid.mouse",
    pointer_function: str = "hid.pointer",
) -> HidDeviceResolver:
    def resolve() -> tuple[Path, Path | None, Path | None] | None:
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
            mouse_path: Path | None = None
            if any(
                link.is_symlink()
                for link in (gadget_root / "configs").glob(f"*/{mouse_function}")
            ):
                mouse_path = resolve_hidg_path(functions / mouse_function, dev_root)
            pointer_path: Path | None = None
            if any(
                link.is_symlink()
                for link in (gadget_root / "configs").glob(f"*/{pointer_function}")
            ):
                pointer_path = resolve_hidg_path(functions / pointer_function, dev_root)
            if not os.access(keyboard_path, os.W_OK):
                return None
            if mouse_path is not None and not os.access(mouse_path, os.W_OK):
                return None
            if pointer_path is not None and not os.access(pointer_path, os.W_OK):
                return None
            if mouse_path is None and pointer_path is None:
                return None
            return keyboard_path, mouse_path, pointer_path
        except (OSError, HidError):
            return None

    return resolve


class AutoLinuxHidController(HidWebController):
    """Attach to Gadget HID endpoints when a USB host configures them."""

    def __init__(
        self,
        device_resolver: HidDeviceResolver,
        adapter_factory: HidAdapterFactory | None = None,
    ) -> None:
        super().__init__(backend="linux-auto")
        self._device_resolver = device_resolver
        self._adapter_factory = adapter_factory or (
            lambda keyboard, mouse, pointer: LinuxGadgetHidAdapter(
                keyboard, mouse, pointer_path=pointer
            )
        )
        self._device_signature: tuple[Path, Path | None, Path] | None = None

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
        self._capture_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "idle"
        self._message = "等待浏览器连接"
        self._error: str | None = None
        self._sequence = -1
        self._jpeg: bytes | None = None
        self._frame_metadata: dict[str, object] | None = None
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

    def snapshot(self) -> tuple[bytes, dict[str, object]]:
        """Return one JPEG and release the source when no live stream exists."""
        with self._condition:
            if self._jpeg is not None and self._frame_metadata is not None:
                jpeg = self._jpeg
                metadata = dict(self._frame_metadata)
                metadata["on_demand"] = False
                metadata["sha256"] = hashlib.sha256(jpeg).hexdigest()
                return jpeg, metadata

        source: VideoSource | None = None
        encoder: _FFmpegJPEGEncoder | _PassthroughJPEGEncoder | None = None
        with self._capture_lock:
            try:
                source = self._source_factory(self._config)
                mode = source.open()
                encoder = (
                    _PassthroughJPEGEncoder()
                    if mode.pixel_format == "MJPEG"
                    else self._encoder_factory(mode.width, mode.height, mode.fps)
                )
                source.start()
                frame = source.next_frame()
                jpeg = encoder.encode(frame)
                return jpeg, {
                    "source_id": source.source_id,
                    "width": frame.width,
                    "height": frame.height,
                    "sequence": frame.sequence,
                    "timestamp_ns": frame.timestamp_ns,
                    "bytes": len(jpeg),
                    "sha256": hashlib.sha256(jpeg).hexdigest(),
                    "on_demand": True,
                }
            finally:
                if source is not None:
                    source.close()
                if encoder is not None:
                    encoder.close()

    def close(self) -> None:
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=3)

    def pause(self) -> None:
        """Stop capture and release buffered frames while keeping the controller reusable."""
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=3)
            if thread.is_alive():
                raise VideoSourceError("video source did not stop while entering Agent mode")
        with self._condition:
            self._thread = None
            self._generation += 1
            self._sequence = -1
            self._jpeg = None
            self._frame_metadata = None
            self._state = "idle"
            self._message = "Agent 模式已释放视频采集"
            self._error = None
            self._stop_event.clear()
            self._condition.notify_all()

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
            self._frame_metadata = None
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
            self._frame_metadata = None
            self._thread = threading.Thread(target=self._produce, daemon=True)
            self._thread.start()

    def _produce(self) -> None:
        source: VideoSource | None = None
        encoder: _FFmpegJPEGEncoder | None = None
        try:
            with self._capture_lock:
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
                        self._frame_metadata = {
                            "source_id": source.source_id,
                            "width": frame.width,
                            "height": frame.height,
                            "sequence": frame.sequence,
                            "timestamp_ns": frame.timestamp_ns,
                            "bytes": len(jpeg),
                        }
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


def observe_stream(stream: StreamProvider, config: WebConfig) -> dict[str, object]:
    """Capture one frame and attach a conservative, pluggable state result."""
    snapshot = getattr(stream, "snapshot", None)
    if not callable(snapshot):
        raise VideoSourceError("video source does not support snapshots")
    _, metadata = snapshot()
    if config.source_kind == "synthetic":
        recognition = {
            "state": "test_pattern",
            "confidence": 1.0,
            "evidence": ["deterministic synthetic color-bar source"],
        }
    else:
        recognition = {
            "state": "unknown",
            "confidence": 0.0,
            "evidence": ["frame captured; semantic recognizer is not configured"],
        }
    return {"frame": metadata, "recognition": recognition}


def build_remote_agent_system_prompt(
    config: WebConfig,
    host_status: dict[str, object],
    stream_status: dict[str, object],
    hid_status: dict[str, object],
) -> str:
    """Describe the board, target and safe capabilities to a remote model."""
    host_data = host_status.get("data") if isinstance(host_status, dict) else None
    if not isinstance(host_data, dict):
        host_data = {}
    # Keep the prompt bounded while retaining the detailed disk and device data.
    host_json = json.dumps(host_data, ensure_ascii=False, separators=(",", ":"))[:24000]
    return (
        "你是 Agent IP KVM 的远程模型，运行在一块 Linux ARM64 开发板的服务端代理中。\n"
        "你的职责是帮助用户理解并规划对被控电脑的操作；不要把自己描述成普通云端聊天机器人。\n"
        f"开发板项目目录：/home/sunrise/agent-ip-kvm-app（配置和主机清单位于该目录的 data/ 下）；视频后端：{config.source_kind}。\n"
        f"当前视频源状态：{json.dumps(stream_status, ensure_ascii=False, separators=(',', ':'))[:2000]}\n"
        f"当前 HID 状态：{json.dumps(hid_status, ensure_ascii=False, separators=(',', ':'))[:1000]}\n"
        "开发板已经缓存了下面这份被控主机只读清单。回答系统、CPU、GPU、内存、磁盘、分区、BIOS 等问题时，优先使用这份清单；"
        "不要声称需要用户在开发板上手动查文件，也不要编造未提供的字段。\n"
        f"被控主机清单（controlled-host.json）：{host_json}\n"
        "当前远程模型只能生成说明和建议，不能绕过开发板策略直接发送键盘、鼠标、Shell、BIOS 或磁盘操作。"
        "涉及重启、安装、BIOS、分区、固件等高风险动作时，必须先给出目标、步骤、风险、预期结果和恢复方法，并明确等待用户批准。"
        "如果缺少画面证据或主机字段，直说未知，并建议通过 KVM 按需截图或只读探针补充证据。"
    )


def _read_asset(name: str) -> bytes:
    return files("agent_ip_kvm").joinpath("web_assets", name).read_bytes()


def create_handler(
    config: WebConfig,
    *,
    status_provider: Callable[[WebConfig], dict[str, object]] = collect_status,
    stream_provider: StreamProvider | None = None,
    settings_updater: SettingsUpdater | None = None,
    hid_controller: HidWebController | None = None,
    host_info_store: HostInfoStore | None = None,
    audit_log: AuditLog | None = None,
    peer_authenticator: PeerTokenAuthenticator | None = None,
    pc_agent_store: PcAgentSuggestionStore | None = None,
    agent_coordinator: AgentCoordinator | None = None,
    model_setup_store: ModelSetupStore | None = None,
    remote_model_store: RemoteModelStore | None = None,
) -> type[BaseHTTPRequestHandler]:
    stream = stream_provider or VideoStreamController(config)
    hid = hid_controller or HidWebController()
    host_info = host_info_store or HostInfoStore(config.host_info_path)
    audit = audit_log or AuditLog(config.audit_path)
    peer_auth = peer_authenticator or PeerTokenAuthenticator(config.pc_agent_token_path)
    pc_agent = pc_agent_store or PcAgentSuggestionStore(config.pc_agent_suggestion_path)
    model_setup = model_setup_store or ModelSetupStore(config.model_setup_path)
    remote_model = remote_model_store or RemoteModelStore(config.remote_model_path)
    agent = agent_coordinator or AgentCoordinator(
        hid_controller=hid,
        observe=lambda: observe_stream(stream, config),
        audit_log=audit,
    )
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
                payload["controlled_host"] = host_info.status()
                payload["pc_agent"] = {
                    "pairing_enabled": peer_auth.enabled,
                    **pc_agent.status(),
                }
                payload["model_setup"] = {"latest": model_setup.latest()}
                payload["remote_model"] = remote_model.public()
                self._send_json(payload)
                return
            if path == "/api/video/snapshot.jpg":
                self._send_snapshot()
                return
            if path == "/api/agent/audit":
                self._send_json({"events": audit.recent()})
                return
            if path == "/api/pc-agent/status":
                self._send_json(
                    {"pairing_enabled": peer_auth.enabled, **pc_agent.status()}
                )
                return
            if path == "/api/model-setup/catalog":
                self._send_json(model_setup.catalog(host_info.status()))
                return
            if path == "/api/model-setup/tasks/latest":
                self._send_json({"task": model_setup.latest()})
                return
            if path.startswith("/api/model-setup/tasks/"):
                task_id = path.rsplit("/", 1)[-1]
                try:
                    self._send_json({"task": model_setup.get(task_id)})
                except ModelSetupError as exc:
                    self._send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
                return
            if path.startswith("/api/model-setup/bootstrap/") and path.endswith(".ps1"):
                parts = path.removesuffix(".ps1").split("/")
                if len(parts) != 6:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                task_id, secret = parts[4], parts[5]
                try:
                    script = model_setup.bootstrap(
                        task_id,
                        secret,
                        base_url=config.pc_agent_callback_url,
                        token=peer_auth.token_for_local_bootstrap(),
                    )
                except (ModelSetupError, PeerAuthenticationError, OSError) as exc:
                    self._send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
                    return
                self._send_bytes(script, "text/plain; charset=utf-8")
                return
            if path in {"/api/remote-model/catalog", "/api/remote-model/config"}:
                self._send_json(remote_model.public())
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
                "/api/video/pause",
                "/api/host-info",
                "/api/hid/key",
                "/api/hid/mouse-move",
                "/api/hid/mouse-position",
                "/api/hid/mouse-click",
                "/api/hid/release",
                "/api/agent/plans",
                "/api/agent/approve",
                "/api/agent/reject",
                "/api/agent/execute",
                "/api/pc-agent/suggestions",
                "/api/model-setup/tasks",
                "/api/model-setup/launch",
                "/api/model-setup/progress",
                "/api/remote-model/config",
                "/api/remote-model/test",
                "/api/agent/chat",
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
            maximum_length = (
                65536
                if path in {"/api/host-info", "/api/pc-agent/suggestions", "/api/model-setup/progress", "/api/agent/chat"}
                else 32768
                if path.startswith("/api/agent/")
                else 4096
            )
            if length < 0 or length > maximum_length or (
                length == 0 and path not in {"/api/hid/release", "/api/video/pause"}
            ):
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
                elif path == "/api/host-info":
                    peer_auth.verify_if_enabled(self.headers.get("Authorization"))
                    result = {"controlled_host": host_info.update(payload)}
                    audit.record("controlled_host_updated")
                elif path == "/api/video/pause":
                    pause = getattr(stream, "pause", None)
                    if not callable(pause):
                        raise VideoSourceError("video stream cannot be paused")
                    pause()
                    result = {"video": stream.status()}
                elif path == "/api/hid/key":
                    result = {"hid": hid.tap_key(payload)}
                elif path == "/api/hid/mouse-move":
                    result = {"hid": hid.move_mouse(payload)}
                elif path == "/api/hid/mouse-position":
                    result = {"hid": hid.position_mouse(payload)}
                elif path == "/api/hid/mouse-click":
                    result = {"hid": hid.click_mouse(payload)}
                elif path == "/api/agent/plans":
                    result = {"plan": agent.create_plan(payload)}
                elif path == "/api/agent/approve":
                    result = {"plan": agent.approve(payload)}
                elif path == "/api/agent/reject":
                    result = {"plan": agent.reject(payload)}
                elif path == "/api/agent/execute":
                    result = {"plan": agent.execute(payload)}
                elif path == "/api/pc-agent/suggestions":
                    peer_auth.require(self.headers.get("Authorization"))
                    suggestion = pc_agent.update(payload)
                    audit.record(
                        "pc_agent_suggestion_received",
                        objective=suggestion["objective"],
                    )
                    result = {"suggestion": suggestion}
                elif path == "/api/model-setup/tasks":
                    task = model_setup.create(payload)
                    audit.record("model_setup_created", task_id=task["task_id"], model=task["model"])
                    result = {"task": task}
                elif path == "/api/model-setup/launch":
                    task_id = payload.get("task_id")
                    if not isinstance(task_id, str):
                        raise ModelSetupError("task_id is required")
                    bootstrap_path = model_setup.bootstrap_path(task_id)
                    command = (
                        "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
                        f'"iex (irm \'{config.pc_agent_callback_url}{bootstrap_path}\')"'
                    )
                    hid.tap_key({"key": "r", "modifiers": ["win"]})
                    time.sleep(0.6)
                    hid.type_text(command)
                    hid.tap_key({"key": "enter", "modifiers": []})
                    task = model_setup.mark_starting(task_id)
                    audit.record("model_setup_launched", task_id=task_id, model=task["model"])
                    result = {"task": task}
                elif path == "/api/model-setup/progress":
                    peer_auth.require(self.headers.get("Authorization"))
                    task = model_setup.update_progress(payload)
                    audit.record(
                        "model_setup_progress",
                        task_id=task["task_id"],
                        status=task["status"],
                        progress=task["progress"],
                    )
                    result = {"task": task}
                elif path == "/api/remote-model/config":
                    configured = remote_model.save(payload)
                    audit.record(
                        "remote_model_configured",
                        model=configured["model"],
                        base_url=configured["base_url"],
                    )
                    result = {"remote_model": configured}
                elif path == "/api/remote-model/test":
                    response = remote_model.chat(
                        [{"role": "user", "content": "Reply with exactly OK."}],
                        timeout=30,
                    )
                    audit.record("remote_model_tested", model=response["model"])
                    result = {
                        "remote_model": {
                            "ok": True,
                            "model": response["model"],
                            "reply": response["content"][:200],
                        }
                    }
                elif path == "/api/agent/chat":
                    messages = payload.get("messages")
                    if not isinstance(messages, list):
                        raise RemoteModelError("messages must be an array")
                    conversation = []
                    for message in messages:
                        if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
                            raise RemoteModelError("remote chat only accepts user and assistant messages")
                        conversation.append(message)
                    system = build_remote_agent_system_prompt(
                        config,
                        host_info.status(),
                        stream.status(),
                        hid.status(),
                    )
                    response = remote_model.chat([{"role": "system", "content": system}, *conversation])
                    result = {"response": response}
                else:
                    hid.release_all()
                    result = {"hid": hid.status()}
            except PeerAuthenticationError as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.UNAUTHORIZED)
                return
            except AgentConflictError as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
                return
            except (
                AgentControlError,
                json.JSONDecodeError,
                TypeError,
                ValueError,
                ModelSetupError,
                RemoteModelError,
                OSError,
                VideoSourceError,
                HidError,
            ) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json(result)

        def _send_snapshot(self) -> None:
            snapshot = getattr(stream, "snapshot", None)
            if not callable(snapshot):
                self._send_json(
                    {"error": "video source does not support snapshots"},
                    HTTPStatus.NOT_IMPLEMENTED,
                )
                return
            try:
                jpeg, metadata = snapshot()
            except (OSError, ValueError, RuntimeError) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-SHA256", str(metadata["sha256"]))
            self.end_headers()
            self.wfile.write(jpeg)

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
        self.host_info_store = HostInfoStore(config.host_info_path)
        self.audit_log = AuditLog(config.audit_path)
        self.peer_authenticator = PeerTokenAuthenticator(config.pc_agent_token_path)
        self.pc_agent_store = PcAgentSuggestionStore(config.pc_agent_suggestion_path)
        self.model_setup_store = ModelSetupStore(config.model_setup_path)
        self.remote_model_store = RemoteModelStore(config.remote_model_path)
        self.agent_coordinator = AgentCoordinator(
            hid_controller=self.hid_controller,
            observe=lambda: observe_stream(self.stream_controller, config),
            audit_log=self.audit_log,
        )
        super().__init__(
            server_address,
            create_handler(
                config,
                stream_provider=self.stream_controller,
                settings_updater=self.update_video_settings,
                hid_controller=self.hid_controller,
                host_info_store=self.host_info_store,
                audit_log=self.audit_log,
                peer_authenticator=self.peer_authenticator,
                pc_agent_store=self.pc_agent_store,
                agent_coordinator=self.agent_coordinator,
                model_setup_store=self.model_setup_store,
                remote_model_store=self.remote_model_store,
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
        "--host-info-file",
        type=Path,
        default=Path("data/controlled-host.json"),
        help="validated controlled-host inventory cache",
    )
    parser.add_argument(
        "--audit-file",
        type=Path,
        default=Path("data/audit.jsonl"),
        help="append-only Agent audit log",
    )
    parser.add_argument(
        "--pc-agent-token-file",
        type=Path,
        default=Path("data/pc-agent-token"),
        help="bearer token used by the optional PC Agent",
    )
    parser.add_argument(
        "--pc-agent-suggestion-file",
        type=Path,
        default=Path("data/pc-agent-suggestion.json"),
        help="latest authenticated PC Agent recommendation",
    )
    parser.add_argument(
        "--model-setup-file",
        type=Path,
        default=Path("data/model-setup-tasks.json"),
        help="controlled-host model installation task cache",
    )
    parser.add_argument(
        "--pc-agent-callback-url",
        default="http://192.168.128.10:8765",
        help="KVM address reachable by the controlled host over USB networking",
    )
    parser.add_argument(
        "--remote-model-file",
        type=Path,
        default=Path("data/remote-model.json"),
        help="local remote model configuration (contains the API key)",
    )
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
    parser.add_argument("--pointer-function", default="hid.pointer")
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
        host_info_path=args.host_info_file,
        audit_path=args.audit_file,
        pc_agent_token_path=args.pc_agent_token_file,
        pc_agent_suggestion_path=args.pc_agent_suggestion_file,
        model_setup_path=args.model_setup_file,
        pc_agent_callback_url=args.pc_agent_callback_url.rstrip("/"),
        remote_model_path=args.remote_model_file,
    )
    hid_adapter: HidAdapter | None = None
    hid_controller: HidWebController | None = None
    if args.hid_backend == "auto":
        hid_controller = AutoLinuxHidController(
            _linux_hid_device_resolver(
                args.gadget_root,
                keyboard_function=args.keyboard_function,
                mouse_function=args.mouse_function,
                pointer_function=args.pointer_function,
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
            pointer_path = wait_for_hidg_path(
                functions / args.pointer_function, timeout_seconds=args.hid_timeout
            )
            hid_adapter = LinuxGadgetHidAdapter(
                keyboard_path, mouse_path, pointer_path=pointer_path
            )
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
