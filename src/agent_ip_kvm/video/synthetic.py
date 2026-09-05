"""Dependency-free video source for development without capture hardware."""

from __future__ import annotations

import time

from .base import Frame, SourceCapability, SourceHealth, VideoSource, VideoSourceError


class SyntheticVideoSource(VideoSource):
    """Produce deterministic RGB24 color bars at a controlled frame rate."""

    _DEFAULT = SourceCapability(width=1280, height=720, fps=30.0, pixel_format="RGB24")

    def __init__(self, *, realtime: bool = True) -> None:
        self._realtime = realtime
        self._mode: SourceCapability | None = None
        self._health = SourceHealth.CLOSED
        self._sequence = 0
        self._next_deadline_ns: int | None = None
        self._base_frame: bytes | None = None

    @property
    def source_id(self) -> str:
        return "synthetic:color-bars"

    def capabilities(self) -> tuple[SourceCapability, ...]:
        return (self._DEFAULT,)

    def open(self, capability: SourceCapability | None = None) -> SourceCapability:
        selected = capability or self._DEFAULT
        if selected not in self.capabilities():
            raise VideoSourceError(f"unsupported synthetic mode: {selected}")
        self._mode = selected
        self._base_frame = self._make_color_bars(selected.width, selected.height)
        self._sequence = 0
        self._next_deadline_ns = None
        self._health = SourceHealth.READY
        return selected

    def start(self) -> None:
        if self._health is not SourceHealth.READY:
            raise VideoSourceError("source must be open before start")
        self._health = SourceHealth.STREAMING
        self._next_deadline_ns = time.monotonic_ns()

    def next_frame(self) -> Frame:
        if self._health is not SourceHealth.STREAMING or self._mode is None:
            raise VideoSourceError("source is not streaming")

        if self._realtime and self._next_deadline_ns is not None:
            remaining_ns = self._next_deadline_ns - time.monotonic_ns()
            if remaining_ns > 0:
                time.sleep(remaining_ns / 1_000_000_000)

        timestamp_ns = time.monotonic_ns()
        frame = Frame(
            width=self._mode.width,
            height=self._mode.height,
            pixel_format=self._mode.pixel_format,
            data=self._base_frame or b"",
            sequence=self._sequence,
            timestamp_ns=timestamp_ns,
        )
        frame.validate()
        self._sequence += 1
        self._next_deadline_ns = timestamp_ns + int(1_000_000_000 / self._mode.fps)
        return frame

    def stop(self) -> None:
        if self._health is SourceHealth.STREAMING:
            self._health = SourceHealth.READY
            self._next_deadline_ns = None

    def close(self) -> None:
        self._health = SourceHealth.CLOSED
        self._mode = None
        self._base_frame = None
        self._next_deadline_ns = None

    def health(self) -> SourceHealth:
        return self._health

    @staticmethod
    def _make_color_bars(width: int, height: int) -> bytes:
        colors = (
            (255, 255, 255),
            (255, 255, 0),
            (0, 255, 255),
            (0, 255, 0),
            (255, 0, 255),
            (255, 0, 0),
            (0, 0, 255),
            (0, 0, 0),
        )
        row = bytearray()
        for x in range(width):
            row.extend(colors[min(x * len(colors) // width, len(colors) - 1)])
        return bytes(row) * height

