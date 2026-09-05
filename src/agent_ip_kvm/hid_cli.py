"""Read-only USB Gadget HID capability probe and offline plan generator."""

from __future__ import annotations

import argparse
import json
import sys

from .hid import HidConfigPlanError, build_composite_gadget_plan, probe_usb_hid


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-hid-probe")
    parser.add_argument(
        "--plan-composite",
        action="store_true",
        help="include a declarative keyboard/mouse composite gadget plan without applying it",
    )
    parser.add_argument("--gadget", help="existing ConfigFS gadget name to preserve")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = probe_usb_hid()
    output: dict[str, object] = {"probe": report.as_dict()}
    if args.plan_composite:
        try:
            output["plan"] = build_composite_gadget_plan(
                report,
                gadget_name=args.gadget,
            ).as_dict()
        except HidConfigPlanError as exc:
            output["plan_error"] = str(exc)
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1
    elif args.gadget:
        _parser().error("--gadget requires --plan-composite")
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
