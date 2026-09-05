"""Platform-independent contract implemented by every video input adapter."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class SourceHealth(str, Enum):
    CLOSED = "closed"
    READY = "ready"
    STREAMING = "streaming"
    ERROR = "error"


class VideoSourceError(RuntimeError):
    """A video source could not complete the requested operation."""


@dataclass(frozen=True, slots=True)
class SourceCapability:
    width: int
    height: int
    fps: float
    pixel_format: str


@dataclass(frozen=True, slots=True)
class Frame:
    width: int
    height: int
    pixel_format: str
    data: bytes
    sequence: int
    timestamp_ns: int

    @property
    def expected_size(self) -> int:
        if self.pixel_format != "RGB24":
            raise VideoSourceError(f"unknown frame size for {self.pixel_format}")
        return self.width * self.height * 3

    def validate(self) -> None:
        if len(self.data) != self.expected_size:
            raise VideoSourceError(
                f"invalid frame payload: expected {self.expected_size} bytes, "
                f"received {len(self.data)}"
            )


class VideoSource(ABC):
    """Common lifecycle for hardware, network, file, and synthetic sources."""

    @property
    @abstractmethod
    def source_id(self) -> str:
        """Return a stable identifier for this source instance."""

    @abstractmethod
    def capabilities(self) -> tuple[SourceCapability, ...]:
        """Return modes supported by the source."""

    @abstractmethod
    def open(self, capability: SourceCapability | None = None) -> SourceCapability:
        """Prepare the source and return the selected mode."""

    @abstractmethod
    def start(self) -> None:
        """Start producing frames."""

    @abstractmethod
    def next_frame(self) -> Frame:
        """Return the next complete frame or raise VideoSourceError."""

    @abstractmethod
    def stop(self) -> None:
        """Stop producing frames while keeping the source open."""

    @abstractmethod
    def close(self) -> None:
        """Release all source resources. Calling close repeatedly is safe."""

    @abstractmethod
    def health(self) -> SourceHealth:
        """Return the current lifecycle or error state."""

    def __enter__(self) -> VideoSource:
        self.open()
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

