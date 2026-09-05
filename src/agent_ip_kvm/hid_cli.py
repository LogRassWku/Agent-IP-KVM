"""Read-only USB Gadget HID capability probe and offline plan generator."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .hid import (
    HidConfigPlanError,
    RecoveryBundleError,
    build_composite_gadget_plan,
    probe_usb_hid,
    write_recovery_bundle,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-ip-kvm-hid-probe")
    parser.add_argument(
        "--plan-composite",
        action="store_true",
        help="include a declarative keyboard/mouse composite gadget plan without applying it",
    )
    parser.add_argument("--gadget", help="existing ConfigFS gadget name to preserve")
    parser.add_argument(
        "--write-recovery-bundle",
        metavar="DIRECTORY",
        help="write guarded preflight and rollback files for the generated plan",
    )
    parser.add_argument(
        "--configuration",
        default="c.1",
        help="ConfigFS configuration name used by the future HID links (default: c.1)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = probe_usb_hid()
    output: dict[str, object] = {"probe": report.as_dict()}
    if args.plan_composite:
        try:
            plan = build_composite_gadget_plan(
                report,
                gadget_name=args.gadget,
            )
            output["plan"] = plan.as_dict()
            if args.write_recovery_bundle:
                output["recovery_bundle"] = write_recovery_bundle(
                    plan,
                    Path(args.write_recovery_bundle),
                    configuration_name=args.configuration,
                ).as_dict()
        except (HidConfigPlanError, RecoveryBundleError, OSError) as exc:
            output["plan_error"] = str(exc)
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1
    elif args.gadget or args.write_recovery_bundle or args.configuration != "c.1":
        _parser().error("--gadget, --configuration and --write-recovery-bundle require --plan-composite")
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
