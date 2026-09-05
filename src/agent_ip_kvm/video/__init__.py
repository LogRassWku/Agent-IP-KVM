"""Video source abstractions and built-in adapters."""

from .base import Frame, SourceCapability, SourceHealth, VideoSource, VideoSourceError
from .synthetic import SyntheticVideoSource
from .v4l2 import (
    DiscoveryStatus,
    V4L2DeviceInfo,
    V4L2DiscoveryReport,
    V4L2NodeKind,
    discover_v4l2_devices,
)

__all__ = [
    "Frame",
    "DiscoveryStatus",
    "SourceCapability",
    "SourceHealth",
    "SyntheticVideoSource",
    "VideoSource",
    "VideoSourceError",
    "V4L2DeviceInfo",
    "V4L2DiscoveryReport",
    "V4L2NodeKind",
    "discover_v4l2_devices",
]
