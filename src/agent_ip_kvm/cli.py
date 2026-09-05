"""Small command-line verifier for video source adapters."""

from __future__ import annotations

import argparse
import json
import sys
import time

from .video import (
    FFmpegFileVideoSource,
    SyntheticVideoSource,
    VideoSource,
    VideoSourceError,
    discover_v4l2_devices,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-video")
    parser.add_argument("--source", choices=("synthetic", "file"), default="synthetic")
    parser.add_argument("--file", help="local video path when --source=file")
    parser.add_argument("--frames", type=int, default=30)
    parser.add_argument(
        "--discover-v4l2",
        action="store_true",
        help="list Linux V4L2 devices and formats without capturing frames",
    )
    return parser


def discover() -> dict[str, object]:
    report = discover_v4l2_devices()
    return {
        "status": report.status.value,
        "backend": "v4l2",
        "message": report.message,
        "devices": [
            {
                "source_id": device.source_id,
                "device_path": device.device_path,
                "display_name": device.display_name,
                "driver": device.driver,
                "bus_info": device.bus_info,
                "node_kind": device.node_kind.value,
                "supports_video_capture": device.supports_video_capture,
                "capabilities": [
                    {
                        "width": capability.width,
                        "height": capability.height,
                        "fps": capability.fps,
                        "pixel_format": capability.pixel_format,
                    }
                    for capability in device.capabilities
                ],
                "error": device.error,
            }
            for device in report.devices
        ],
    }


def run(source: VideoSource, frames: int) -> dict[str, object]:
    if frames < 1:
        raise ValueError("frames must be at least 1")

    mode = source.open()
    source.start()
    started_ns = time.monotonic_ns()
    first_sequence: int | None = None
    bytes_received = 0

    try:
        for _ in range(frames):
            frame = source.next_frame()
            if first_sequence is None:
                first_sequence = frame.sequence
            bytes_received += len(frame.data)
    finally:
        source.stop()
        source.close()

    elapsed_s = max((time.monotonic_ns() - started_ns) / 1_000_000_000, 1e-9)
    return {
        "source": source.source_id,
        "mode": {
            "width": mode.width,
            "height": mode.height,
            "fps": mode.fps,
            "pixel_format": mode.pixel_format,
        },
        "frames": frames,
        "first_sequence": first_sequence,
        "last_sequence": first_sequence + frames - 1 if first_sequence is not None else None,
        "bytes_received": bytes_received,
        "measured_fps": round(frames / elapsed_s, 2),
        "final_health": source.health().value,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.discover_v4l2:
        print(json.dumps(discover(), ensure_ascii=False, indent=2))
        return 0
    try:
        if args.source == "file":
            if not args.file:
                raise ValueError("--file is required when --source=file")
            source: VideoSource = FFmpegFileVideoSource(args.file, realtime=True)
        else:
            source = SyntheticVideoSource(realtime=True)
        result = run(source, args.frames)
    except (ValueError, VideoSourceError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"status": "ok", **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
