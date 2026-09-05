"""Read-only USB Gadget HID capability probe."""

from __future__ import annotations

import json
import sys

from .hid import probe_usb_hid


def main() -> int:
    report = probe_usb_hid()
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
