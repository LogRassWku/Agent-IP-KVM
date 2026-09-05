"""Send a deliberately inert release-only report to Linux USB Gadget HID."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .hid import HidError, LinuxGadgetHidAdapter, wait_for_hidg_path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-hid-output")
    parser.add_argument(
        "--gadget-root",
        type=Path,
        default=Path("/sys/kernel/config/usb_gadget/g_comp"),
    )
    parser.add_argument("--keyboard-function", default="hid.keyboard")
    parser.add_argument("--mouse-function", default="hid.mouse")
    parser.add_argument("--dev-root", type=Path, default=Path("/dev"))
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument(
        "--settle-seconds",
        type=float,
        default=2.5,
        help="wait for the USB host to configure both HID endpoints after a rebind",
    )
    parser.add_argument(
        "--release-only",
        action="store_true",
        help="required safety acknowledgement; only all-zero release reports are sent",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not args.release_only:
        parser.error("--release-only is required; active keyboard and mouse commands are not exposed")
    if not 0 <= args.settle_seconds <= 10:
        parser.error("--settle-seconds must be between 0 and 10")

    functions = args.gadget_root / "functions"
    try:
        time.sleep(args.settle_seconds)
        keyboard_path = wait_for_hidg_path(
            functions / args.keyboard_function,
            args.dev_root,
            args.timeout,
        )
        mouse_path = wait_for_hidg_path(
            functions / args.mouse_function,
            args.dev_root,
            args.timeout,
        )
        adapter = LinuxGadgetHidAdapter(keyboard_path, mouse_path)
        operation_error: Exception | None = None
        try:
            adapter.arm()
            adapter.release_all()
        except (HidError, OSError) as exc:
            operation_error = exc
        finally:
            try:
                adapter.close()
            except (HidError, OSError) as exc:
                if operation_error is None:
                    operation_error = exc
        if operation_error is not None:
            raise operation_error
    except (HidError, OSError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1

    print(
        json.dumps(
            {
                "status": "ok",
                "mode": "release_only",
                "keyboard_device": str(keyboard_path),
                "mouse_device": str(mouse_path),
                "keyboard_report": bytes(8).hex(),
                "mouse_report": bytes(4).hex(),
                "active_input_sent": False,
                "settle_seconds": args.settle_seconds,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
