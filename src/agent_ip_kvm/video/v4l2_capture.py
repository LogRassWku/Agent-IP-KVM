"""Live Linux V4L2 capture backed by FFmpeg with MJPEG passthrough."""

from __future__ import annotations

import platform
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable

from .base import Frame, SourceCapability, SourceHealth, VideoSource, VideoSourceError


ProcessFactory = Callable[..., subprocess.Popen[bytes]]


class FFmpegV4L2VideoSource(VideoSource):
    """Read complete MJPEG frames from a Linux V4L2 capture node."""

    def __init__(
        self,
        device_path: str | Path = "/dev/video0",
        *,
        width: int = 1920,
        height: int = 1080,
        fps: float = 30.0,
        ffmpeg_path: str | None = None,
        process_factory: ProcessFactory | None = None,
        platform_name: str | None = None,
    ) -> None:
        self._path = Path(device_path)
        self._mode = SourceCapability(width, height, fps, "MJPEG")
        self._ffmpeg_path = ffmpeg_path
        self._process_factory = process_factory or subprocess.Popen
        self._platform_name = platform_name or platform.system()
        self._process: subprocess.Popen[bytes] | None = None
        self._health = SourceHealth.CLOSED
        self._sequence = 0
        self._buffer = bytearray()

    @property
    def source_id(self) -> str:
        return f"v4l2:{self._path}"

    def capabilities(self) -> tuple[SourceCapability, ...]:
        self._validate_configuration()
        return (self._mode,)

    def open(self, capability: SourceCapability | None = None) -> SourceCapability:
        self._validate_configuration()
        if capability is not None and capability != self._mode:
            raise VideoSourceError(f"unsupported V4L2 mode: {capability}")
        self._sequence = 0
        self._buffer.clear()
        self._health = SourceHealth.READY
        return self._mode

    def start(self) -> None:
        if self._health is not SourceHealth.READY:
            raise VideoSourceError("source must be open before start")
        executable = self._ffmpeg_path or shutil.which("ffmpeg")
        if executable is None:
            self._health = SourceHealth.ERROR
            raise VideoSourceError("ffmpeg is required for V4L2 capture")
        command = (
            executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "v4l2",
            "-input_format",
            "mjpeg",
            "-video_size",
            f"{self._mode.width}x{self._mode.height}",
            "-framerate",
            str(self._mode.fps),
            "-i",
            str(self._path),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-c:v",
            "copy",
            "-f",
            "image2pipe",
            "pipe:1",
        )
        try:
            self._process = self._process_factory(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            self._health = SourceHealth.ERROR
            raise VideoSourceError(f"unable to start V4L2 capture: {exc}") from exc
        self._health = SourceHealth.STREAMING

    def next_frame(self) -> Frame:
        if (
            self._health is not SourceHealth.STREAMING
            or self._process is None
            or self._process.stdout is None
        ):
            raise VideoSourceError("source is not streaming")

        while True:
            start = self._buffer.find(b"\xff\xd8")
            end = self._buffer.find(b"\xff\xd9", max(start + 2, 0))
            if start >= 0 and end >= 0:
                jpeg = bytes(self._buffer[start : end + 2])
                del self._buffer[: end + 2]
                frame = Frame(
                    width=self._mode.width,
                    height=self._mode.height,
                    pixel_format=self._mode.pixel_format,
                    data=jpeg,
                    sequence=self._sequence,
                    timestamp_ns=time.monotonic_ns(),
                )
                frame.validate()
                self._sequence += 1
                return frame

            chunk = self._process.stdout.read(65536)
            if not chunk:
                self._health = SourceHealth.ERROR
                message = self._read_process_error()
                raise VideoSourceError(
                    f"V4L2 capture stopped: {message or 'no complete JPEG frame'}"
                )
            self._buffer.extend(chunk)
            if len(self._buffer) > 16 * 1024 * 1024:
                self._health = SourceHealth.ERROR
                raise VideoSourceError("V4L2 capture produced an oversized frame")

    def stop(self) -> None:
        self._stop_process()
        if self._health is not SourceHealth.CLOSED:
            self._health = SourceHealth.READY

    def close(self) -> None:
        self._stop_process()
        self._health = SourceHealth.CLOSED

    def health(self) -> SourceHealth:
        return self._health

    def _validate_configuration(self) -> None:
        if self._platform_name != "Linux":
            self._health = SourceHealth.ERROR
            raise VideoSourceError("V4L2 capture requires Linux")
        if not self._path.exists():
            self._health = SourceHealth.ERROR
            raise VideoSourceError(f"V4L2 device does not exist: {self._path}")
        if self._mode.width <= 0 or self._mode.height <= 0 or self._mode.fps <= 0:
            self._health = SourceHealth.ERROR
            raise VideoSourceError("V4L2 width, height, and frame rate must be positive")

    def _read_process_error(self) -> str:
        if self._process is None or self._process.stderr is None:
            return ""
        raw = self._process.stderr.read()
        return " ".join(raw.decode("utf-8", errors="replace").split())

    def _stop_process(self) -> None:
        if self._process is None:
            return
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)
        self._process = None

