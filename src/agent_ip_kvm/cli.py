"""Small command-line verifier for video source adapters."""

from __future__ import annotations

import argparse
import json
import sys
import time

from .video import SyntheticVideoSource, VideoSourceError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-video")
    parser.add_argument("--source", choices=("synthetic",), default="synthetic")
    parser.add_argument("--frames", type=int, default=30)
    return parser


def run(frames: int) -> dict[str, object]:
    if frames < 1:
        raise ValueError("frames must be at least 1")

    source = SyntheticVideoSource(realtime=True)
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
    try:
        result = run(args.frames)
    except (ValueError, VideoSourceError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"status": "ok", **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

