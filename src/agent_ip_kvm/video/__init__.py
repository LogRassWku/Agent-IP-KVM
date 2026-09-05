"""Video source abstractions and built-in adapters."""

from .base import Frame, SourceCapability, SourceHealth, VideoSource, VideoSourceError
from .synthetic import SyntheticVideoSource

__all__ = [
    "Frame",
    "SourceCapability",
    "SourceHealth",
    "SyntheticVideoSource",
    "VideoSource",
    "VideoSourceError",
]

