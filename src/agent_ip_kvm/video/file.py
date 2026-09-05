"""Video-file adapter backed by the FFmpeg command-line tools."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Protocol, Sequence

from .base import (
    EndOfStream,
    Frame,
    SourceCapability,
    SourceHealth,
    VideoSource,
    VideoSourceError,
)


class ProbeResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


ProbeRunner = Callable[[Sequence[str]], ProbeResult]
ProcessFactory = Callable[..., subprocess.Popen[bytes]]


def _default_probe_runner(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )


def _parse_frame_rate(value: str) -> float:
    try:
        numerator_text, denominator_text = value.split("/", 1)
        numerator = float(numerator_text)
        denominator = float(denominator_text)
    except (AttributeError, ValueError):
        return 0.0
    if denominator == 0:
        return 0.0
    return numerator / denominator


def parse_ffprobe_output(text: str) -> SourceCapability:
    """Convert ffprobe JSON for the first video stream into the frame contract."""

    try:
        payload = json.loads(text)
        stream = payload["streams"][0]
        width = int(stream["width"])
        height = int(stream["height"])
    except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError) as exc:
        raise VideoSourceError("ffprobe did not return a usable video stream") from exc

    fps = _parse_frame_rate(stream.get("avg_frame_rate", ""))
    if fps <= 0:
        fps = _parse_frame_rate(stream.get("r_frame_rate", ""))
    if width <= 0 or height <= 0 or fps <= 0:
        raise VideoSourceError("video stream has invalid width, height, or frame rate")

    return SourceCapability(width=width, height=height, fps=fps, pixel_format="RGB24")


class FFmpegFileVideoSource(VideoSource):
    """Decode the first video stream in a local file to RGB24 frames."""

    def __init__(
        self,
        path: str | Path,
        *,
        realtime: bool = True,
        ffprobe_path: str | None = None,
        ffmpeg_path: str | None = None,
        probe_runner: ProbeRunner | None = None,
        process_factory: ProcessFactory | None = None,
    ) -> None:
        self._path = Path(path).expanduser()
        self._realtime = realtime
        self._ffprobe_path = ffprobe_path
        self._ffmpeg_path = ffmpeg_path
        self._probe_runner = probe_runner or _default_probe_runner
        self._process_factory = process_factory or subprocess.Popen
        self._mode: SourceCapability | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._health = SourceHealth.CLOSED
        self._sequence = 0

    @property
    def source_id(self) -> str:
        return f"file:{self._path.resolve()}"

    def capabilities(self) -> tuple[SourceCapability, ...]:
        if self._mode is None:
            self._mode = self._probe()
        return (self._mode,)

    def open(self, capability: SourceCapability | None = None) -> SourceCapability:
        mode = self.capabilities()[0]
        if capability is not None and capability != mode:
            raise VideoSourceError(f"unsupported file mode: {capability}")
        self._sequence = 0
        self._health = SourceHealth.READY
        return mode

    def start(self) -> None:
        if self._health is not SourceHealth.READY or self._mode is None:
            raise VideoSourceError("source must be open before start")

        executable = self._ffmpeg_path or shutil.which("ffmpeg")
        if executable is None:
            self._health = SourceHealth.ERROR
            raise VideoSourceError("ffmpeg is required to decode video files")

        command = [executable, "-hide_banner", "-loglevel", "error"]
        if self._realtime:
            command.append("-re")
        command.extend(
            [
                "-i",
                str(self._path),
                "-map",
                "0:v:0",
                "-an",
                "-sn",
                "-dn",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ]
        )
        try:
            self._process = self._process_factory(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            self._health = SourceHealth.ERROR
            raise VideoSourceError(f"unable to start ffmpeg: {exc}") from exc
        self._health = SourceHealth.STREAMING

    def next_frame(self) -> Frame:
        if (
            self._health is not SourceHealth.STREAMING
            or self._mode is None
            or self._process is None
            or self._process.stdout is None
        ):
            raise VideoSourceError("source is not streaming")

        expected_size = self._mode.width * self._mode.height * 3
        data = self._read_exactly(self._process.stdout, expected_size)
        if len(data) != expected_size:
            message = self._read_process_error()
            self._health = SourceHealth.ENDED if not message else SourceHealth.ERROR
            if message:
                raise VideoSourceError(f"ffmpeg stopped before a complete frame: {message}")
            raise EndOfStream("video file reached end of stream")

        frame = Frame(
            width=self._mode.width,
            height=self._mode.height,
            pixel_format=self._mode.pixel_format,
            data=data,
            sequence=self._sequence,
            timestamp_ns=time.monotonic_ns(),
        )
        frame.validate()
        self._sequence += 1
        return frame

    def stop(self) -> None:
        self._stop_process()
        if self._health is not SourceHealth.CLOSED:
            self._health = SourceHealth.READY

    def close(self) -> None:
        self._stop_process()
        self._health = SourceHealth.CLOSED

    def health(self) -> SourceHealth:
        return self._health

    def _probe(self) -> SourceCapability:
        if not self._path.is_file():
            self._health = SourceHealth.ERROR
            raise VideoSourceError(f"video file does not exist: {self._path}")

        executable = self._ffprobe_path or shutil.which("ffprobe")
        if executable is None:
            self._health = SourceHealth.ERROR
            raise VideoSourceError("ffprobe is required to inspect video files")

        command = (
            executable,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            str(self._path),
        )
        try:
            result = self._probe_runner(command)
        except (OSError, subprocess.SubprocessError) as exc:
            self._health = SourceHealth.ERROR
            raise VideoSourceError(f"unable to run ffprobe: {exc}") from exc
        if result.returncode != 0:
            self._health = SourceHealth.ERROR
            message = " ".join((result.stderr or result.stdout).split())
            raise VideoSourceError(f"ffprobe failed: {message or 'unknown error'}")
        return parse_ffprobe_output(result.stdout)

    @staticmethod
    def _read_exactly(stream: object, size: int) -> bytes:
        chunks: list[bytes] = []
        remaining = size
        while remaining:
            chunk = stream.read(remaining)  # type: ignore[attr-defined]
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

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

