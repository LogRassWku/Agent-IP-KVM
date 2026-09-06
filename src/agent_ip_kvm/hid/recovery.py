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
    temporary_apply_script: Path
    keyboard_descriptor: Path
    mouse_descriptor: Path
    pointer_descriptor: Path
    power_descriptor: Path
    instructions: Path

    def as_dict(self) -> dict[str, str]:
        return {
            "directory": str(self.directory),
            "manifest": str(self.manifest),
            "preflight_script": str(self.preflight_script),
            "rollback_script": str(self.rollback_script),
            "temporary_apply_script": str(self.temporary_apply_script),
            "keyboard_descriptor": str(self.keyboard_descriptor),
            "mouse_descriptor": str(self.mouse_descriptor),
            "pointer_descriptor": str(self.pointer_descriptor),
            "power_descriptor": str(self.power_descriptor),
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
OS_DESC_LINK="$GADGET/os_desc/$CONFIGURATION"
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
OS_DESC_WAS_LINKED=false
if [ -L "$OS_DESC_LINK" ]; then
  OS_DESC_WAS_LINKED=true
fi

for function_name in {existing}; do
  [ -d "$GADGET/functions/$function_name" ] || {{ printf 'FAIL: existing function %s is missing\\n' "$function_name" >&2; exit 1; }}
done

restore_os_desc() {{
  if [ "$OS_DESC_WAS_LINKED" = true ] && [ ! -L "$OS_DESC_LINK" ]; then
    (cd "$GADGET" && ln -s "configs/$CONFIGURATION" os_desc) || true
  fi
}}

rebind() {{
  restore_os_desc
  if [ -r "$GADGET/UDC" ] && [ -z "$(cat "$GADGET/UDC")" ]; then
    printf '%s' "$EXPECTED_UDC" > "$GADGET/UDC" || true
  fi
}}

trap rebind EXIT HUP INT TERM
if [ -n "$CURRENT_UDC" ]; then
  printf '\\n' > "$GADGET/UDC"
fi
if [ "$OS_DESC_WAS_LINKED" = true ]; then
  rm -- "$OS_DESC_LINK"
fi

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
5. `temporary-apply.sh` 只用于短时枚举测试，必须显式传入 `--apply`，并会自动调用回滚脚本。

## 需要恢复时

在独立的本地会话中运行：

```bash
sudo ./rollback.sh --apply
```

脚本只尝试删除 `{plan.gadget_name}`／`{configuration_name}` 中的
`hid.keyboard`、`hid.mouse`、`hid.pointer` 和 `hid.power`，然后重新绑定 `{plan.udc}`。它不会删除
现有的 {", ".join(plan.existing_functions)}。

如果 Gadget 名称、UDC 或现有功能已变化，不要使用旧文件包，应重新探测并生成。
"""


def _temporary_apply_script(plan: CompositeGadgetPlan, configuration_name: str) -> str:
    existing = _shell_words(plan.existing_functions)
    return f"""#!/bin/sh
set -eu

CONFIGFS_ROOT="${{AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}}"
GADGET="$CONFIGFS_ROOT/{plan.gadget_name}"
EXPECTED_UDC='{plan.udc}'
CONFIGURATION='{configuration_name}'
OS_DESC_LINK="$GADGET/os_desc/$CONFIGURATION"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STATE_DIR="${{AGENT_IP_KVM_HID_STATE_DIR:-/run/agent-ip-kvm-hid}}"
MODE="${{1:---dry-run}}"
ROLLBACK_AFTER="${{2:-45}}"

case "$MODE" in
  --dry-run)
    printf 'DRY RUN: would add standard keyboard and mouse functions for %s seconds\\n' "$ROLLBACK_AFTER"
    printf 'Automatic rollback would start before USB is unbound\\n'
    printf 'No USB configuration was changed\\n'
    exit 0
    ;;
  --apply) ;;
  *)
    printf 'Usage: %s [--dry-run|--apply] [rollback-seconds]\\n' "$0" >&2
    exit 2
    ;;
esac

case "$ROLLBACK_AFTER" in
  *[!0-9]*|'') printf 'FAIL: rollback-seconds must be an integer\\n' >&2; exit 1 ;;
esac
[ "$ROLLBACK_AFTER" -ge 20 ] && [ "$ROLLBACK_AFTER" -le 300 ] || {{ printf 'FAIL: rollback-seconds must be 20..300\\n' >&2; exit 1; }}
[ "$(id -u)" -eq 0 ] || {{ printf 'FAIL: --apply requires root\\n' >&2; exit 1; }}
[ -d "$GADGET/configs/$CONFIGURATION" ] || {{ printf 'FAIL: expected gadget configuration was not found\\n' >&2; exit 1; }}
[ "$(cat "$GADGET/UDC")" = "$EXPECTED_UDC" ] || {{ printf 'FAIL: UDC binding changed after plan generation\\n' >&2; exit 1; }}
[ -s "$SCRIPT_DIR/keyboard-report-desc.bin" ] || {{ printf 'FAIL: keyboard descriptor is missing\\n' >&2; exit 1; }}
[ -s "$SCRIPT_DIR/mouse-report-desc.bin" ] || {{ printf 'FAIL: mouse descriptor is missing\\n' >&2; exit 1; }}
[ -s "$SCRIPT_DIR/pointer-report-desc.bin" ] || {{ printf 'FAIL: pointer descriptor is missing\\n' >&2; exit 1; }}
[ -s "$SCRIPT_DIR/power-report-desc.bin" ] || {{ printf 'FAIL: power descriptor is missing\\n' >&2; exit 1; }}
if [ -r "$GADGET/os_desc/use" ] && [ "$(cat "$GADGET/os_desc/use")" = 1 ]; then
  [ -L "$OS_DESC_LINK" ] || {{ printf 'FAIL: enabled OS descriptor configuration link is missing\\n' >&2; exit 1; }}
fi

for function_name in {existing}; do
  [ -d "$GADGET/functions/$function_name" ] || {{ printf 'FAIL: existing function %s is missing\\n' "$function_name" >&2; exit 1; }}
done

for function_name in 'hid.keyboard' 'hid.mouse' 'hid.pointer' 'hid.power'; do
  [ ! -e "$GADGET/functions/$function_name" ] || {{ printf 'FAIL: function %s already exists\\n' "$function_name" >&2; exit 1; }}
done

mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/cancel" "$STATE_DIR/rollback.log"
nohup sh -c 'sleep "$1"; if [ ! -e "$2/cancel" ]; then "$3/rollback.sh" --apply > "$2/rollback.log" 2>&1; fi' sh "$ROLLBACK_AFTER" "$STATE_DIR" "$SCRIPT_DIR" </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > "$STATE_DIR/watchdog.pid"

ROLLBACK_NEEDED=true
rollback_on_exit() {{
  if [ "$ROLLBACK_NEEDED" = true ]; then
    "$SCRIPT_DIR/rollback.sh" --apply || true
  fi
}}
trap rollback_on_exit EXIT HUP INT TERM

printf '\\n' > "$GADGET/UDC"
OS_DESC_WAS_LINKED=false
if [ -L "$OS_DESC_LINK" ]; then
  OS_DESC_WAS_LINKED=true
  rm -- "$OS_DESC_LINK"
fi
mkdir "$GADGET/functions/hid.keyboard"
printf '1' > "$GADGET/functions/hid.keyboard/protocol"
printf '1' > "$GADGET/functions/hid.keyboard/subclass"
printf '8' > "$GADGET/functions/hid.keyboard/report_length"
cat "$SCRIPT_DIR/keyboard-report-desc.bin" > "$GADGET/functions/hid.keyboard/report_desc"

mkdir "$GADGET/functions/hid.mouse"
printf '2' > "$GADGET/functions/hid.mouse/protocol"
printf '1' > "$GADGET/functions/hid.mouse/subclass"
printf '4' > "$GADGET/functions/hid.mouse/report_length"
cat "$SCRIPT_DIR/mouse-report-desc.bin" > "$GADGET/functions/hid.mouse/report_desc"

mkdir "$GADGET/functions/hid.pointer"
printf '0' > "$GADGET/functions/hid.pointer/protocol"
printf '0' > "$GADGET/functions/hid.pointer/subclass"
printf '6' > "$GADGET/functions/hid.pointer/report_length"
cat "$SCRIPT_DIR/pointer-report-desc.bin" > "$GADGET/functions/hid.pointer/report_desc"

mkdir "$GADGET/functions/hid.power"
printf '0' > "$GADGET/functions/hid.power/protocol"
printf '0' > "$GADGET/functions/hid.power/subclass"
printf '1' > "$GADGET/functions/hid.power/report_length"
cat "$SCRIPT_DIR/power-report-desc.bin" > "$GADGET/functions/hid.power/report_desc"

cd "$GADGET"
ln -s functions/hid.keyboard "configs/$CONFIGURATION"
ln -s functions/hid.mouse "configs/$CONFIGURATION"
ln -s functions/hid.pointer "configs/$CONFIGURATION"
ln -s functions/hid.power "configs/$CONFIGURATION"
if [ "$OS_DESC_WAS_LINKED" = true ]; then
  ln -s "configs/$CONFIGURATION" os_desc
fi
printf '%s' "$EXPECTED_UDC" > "$GADGET/UDC"

ROLLBACK_NEEDED=false
trap - EXIT HUP INT TERM
printf 'Temporary HID enumeration active; automatic rollback in %s seconds\\n' "$ROLLBACK_AFTER"
printf 'No keyboard or mouse report was sent\\n'
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
    temporary_apply = output_directory / "temporary-apply.sh"
    keyboard_descriptor = output_directory / "keyboard-report-desc.bin"
    mouse_descriptor = output_directory / "mouse-report-desc.bin"
    pointer_descriptor = output_directory / "pointer-report-desc.bin"
    power_descriptor = output_directory / "power-report-desc.bin"
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
    temporary_apply.write_text(
        _temporary_apply_script(plan, configuration_name), encoding="utf-8", newline="\n"
    )
    keyboard_descriptor.write_bytes(plan.hid_functions[0].report_descriptor)
    mouse_descriptor.write_bytes(plan.hid_functions[1].report_descriptor)
    pointer_descriptor.write_bytes(plan.hid_functions[2].report_descriptor)
    power_descriptor.write_bytes(plan.hid_functions[3].report_descriptor)
    instructions.write_text(_instructions(plan, configuration_name), encoding="utf-8", newline="\n")
    preflight.chmod(0o755)
    rollback.chmod(0o755)
    temporary_apply.chmod(0o755)

    return RecoveryBundle(
        output_directory,
        manifest,
        preflight,
        rollback,
        temporary_apply,
        keyboard_descriptor,
        mouse_descriptor,
        pointer_descriptor,
        power_descriptor,
        instructions,
    )
