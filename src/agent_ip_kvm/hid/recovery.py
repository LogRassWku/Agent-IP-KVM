"""Create guarded recovery files for a future USB Gadget rebind."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .config_plan import CompositeGadgetPlan


_SAFE_CONFIGFS_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


class RecoveryBundleError(RuntimeError):
    """A recovery bundle could not be generated safely."""


@dataclass(frozen=True, slots=True)
class RecoveryBundle:
    directory: Path
    manifest: Path
    preflight_script: Path
    rollback_script: Path
    instructions: Path

    def as_dict(self) -> dict[str, str]:
        return {
            "directory": str(self.directory),
            "manifest": str(self.manifest),
            "preflight_script": str(self.preflight_script),
            "rollback_script": str(self.rollback_script),
            "instructions": str(self.instructions),
        }


def _validate_name(value: str, label: str) -> str:
    if not _SAFE_CONFIGFS_NAME.fullmatch(value):
        raise RecoveryBundleError(f"{label} contains unsupported characters: {value!r}")
    return value


def _shell_words(values: tuple[str, ...]) -> str:
    for value in values:
        _validate_name(value, "function name")
    return " ".join(f"'{value}'" for value in values)


def _preflight_script(plan: CompositeGadgetPlan, configuration_name: str) -> str:
    existing = _shell_words(plan.existing_functions)
    hid = _shell_words(tuple(function.name for function in plan.hid_functions))
    return f"""#!/bin/sh
set -eu

CONFIGFS_ROOT="${{AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}}"
GADGET="$CONFIGFS_ROOT/{plan.gadget_name}"
EXPECTED_UDC='{plan.udc}'
CONFIGURATION='{configuration_name}'

fail() {{
  printf 'FAIL: %s\\n' "$1" >&2
  exit 1
}}

[ -d "$CONFIGFS_ROOT" ] || fail "USB Gadget ConfigFS root is unavailable"
[ -d "$GADGET" ] || fail "expected gadget {plan.gadget_name} was not found"
[ -r "$GADGET/UDC" ] || fail "gadget UDC binding is unreadable"
[ "$(cat "$GADGET/UDC")" = "$EXPECTED_UDC" ] || fail "UDC binding changed after plan generation"
[ -d "$GADGET/configs/$CONFIGURATION" ] || fail "configuration $CONFIGURATION was not found"

for function_name in {existing}; do
  [ -d "$GADGET/functions/$function_name" ] || fail "existing function $function_name is missing"
done

for function_name in {hid}; do
  [ ! -e "$GADGET/functions/$function_name" ] || fail "planned function $function_name already exists"
  [ ! -L "$GADGET/configs/$CONFIGURATION/$function_name" ] || fail "planned link $function_name already exists"
done

printf 'PASS: gadget state still matches the recovery manifest\\n'
printf 'READ ONLY: no USB configuration was changed\\n'
"""


def _rollback_script(plan: CompositeGadgetPlan, configuration_name: str) -> str:
    hid = _shell_words(tuple(function.name for function in plan.hid_functions))
    existing = _shell_words(plan.existing_functions)
    return f"""#!/bin/sh
set -eu

CONFIGFS_ROOT="${{AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}}"
GADGET="$CONFIGFS_ROOT/{plan.gadget_name}"
EXPECTED_UDC='{plan.udc}'
CONFIGURATION='{configuration_name}'
MODE="${{1:---dry-run}}"

case "$MODE" in
  --dry-run)
    printf 'DRY RUN: would unbind %s, remove only Agent IP KVM HID functions, then rebind\\n' "$EXPECTED_UDC"
    printf 'Functions: {" ".join(function.name for function in plan.hid_functions)}\\n'
    printf 'No USB configuration was changed\\n'
    exit 0
    ;;
  --apply) ;;
  *)
    printf 'Usage: %s [--dry-run|--apply]\\n' "$0" >&2
    exit 2
    ;;
esac

[ "$(id -u)" -eq 0 ] || {{ printf 'FAIL: --apply requires root\\n' >&2; exit 1; }}
[ -d "$GADGET" ] || {{ printf 'FAIL: expected gadget was not found\\n' >&2; exit 1; }}
[ -r "$GADGET/UDC" ] || {{ printf 'FAIL: UDC binding is unreadable\\n' >&2; exit 1; }}
CURRENT_UDC="$(cat "$GADGET/UDC")"
[ -z "$CURRENT_UDC" ] || [ "$CURRENT_UDC" = "$EXPECTED_UDC" ] || {{ printf 'FAIL: refusing to replace a different UDC binding\\n' >&2; exit 1; }}

for function_name in {existing}; do
  [ -d "$GADGET/functions/$function_name" ] || {{ printf 'FAIL: existing function %s is missing\\n' "$function_name" >&2; exit 1; }}
done

rebind() {{
  printf '%s' "$EXPECTED_UDC" > "$GADGET/UDC" || true
}}

trap rebind EXIT HUP INT TERM
printf '' > "$GADGET/UDC"

for function_name in {hid}; do
  link="$GADGET/configs/$CONFIGURATION/$function_name"
  function_dir="$GADGET/functions/$function_name"
  if [ -L "$link" ]; then
    rm -- "$link"
  fi
  if [ -d "$function_dir" ]; then
    rmdir -- "$function_dir"
  fi
done

rebind
trap - EXIT HUP INT TERM
printf 'Rollback complete: original UDC rebound; existing non-HID functions were preserved\\n'
"""


def _instructions(plan: CompositeGadgetPlan, configuration_name: str) -> str:
    return f"""# Agent IP KVM 本地恢复说明

此文件包只用于未来的 USB HID 重绑实验。生成文件时没有修改 USB。

## 实验前必须满足

1. 通过串口、本地终端或其他不依赖 USB QuickLink 的方式登录开发板。
2. 保持该本地会话处于打开状态，并确认能够执行管理员命令。
3. 在当前状态下运行 `./preflight.sh`，只有显示 `PASS` 才能继续。
4. 先运行 `./rollback.sh` 查看默认预览；它不会修改 USB。
5. 未来真正应用 HID 前，应另设自动超时回滚。本文件包当前不包含应用脚本。

## 需要恢复时

在独立的本地会话中运行：

```bash
sudo ./rollback.sh --apply
```

脚本只尝试删除 `{plan.gadget_name}`／`{configuration_name}` 中的
`hid.keyboard` 和 `hid.mouse`，然后重新绑定 `{plan.udc}`。它不会删除
现有的 {", ".join(plan.existing_functions)}。

如果 Gadget 名称、UDC 或现有功能已变化，不要使用旧文件包，应重新探测并生成。
"""


def write_recovery_bundle(
    plan: CompositeGadgetPlan,
    output_directory: Path,
    *,
    configuration_name: str = "c.1",
) -> RecoveryBundle:
    """Write guarded scripts and a manifest; never access ConfigFS itself."""

    _validate_name(plan.gadget_name, "gadget name")
    _validate_name(plan.udc, "UDC name")
    _validate_name(configuration_name, "configuration name")
    output_directory = output_directory.resolve()
    if output_directory.exists() and any(output_directory.iterdir()):
        raise RecoveryBundleError("output directory must be empty")
    output_directory.mkdir(parents=True, exist_ok=True)

    manifest = output_directory / "manifest.json"
    preflight = output_directory / "preflight.sh"
    rollback = output_directory / "rollback.sh"
    instructions = output_directory / "LOCAL_RECOVERY.md"

    manifest.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "generated_only": True,
                "configuration_name": configuration_name,
                "plan": plan.as_dict(),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    preflight.write_text(_preflight_script(plan, configuration_name), encoding="utf-8", newline="\n")
    rollback.write_text(_rollback_script(plan, configuration_name), encoding="utf-8", newline="\n")
    instructions.write_text(_instructions(plan, configuration_name), encoding="utf-8", newline="\n")
    preflight.chmod(0o755)
    rollback.chmod(0o755)

    return RecoveryBundle(output_directory, manifest, preflight, rollback, instructions)
