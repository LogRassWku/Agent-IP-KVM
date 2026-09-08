#!/bin/sh
set -eu

CONFIGFS_ROOT="${AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}"
GADGET="$CONFIGFS_ROOT/__GADGET__"
EXPECTED_UDC='__UDC__'
CONFIGURATION='__CONFIG__'
OS_DESC_LINK="$GADGET/os_desc/$CONFIGURATION"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STATE_DIR="${AGENT_IP_KVM_HID_STATE_DIR:-/run/agent-ip-kvm-hid}"
MODE="${1:---dry-run}"
ROLLBACK_AFTER="${2:-45}"

case "$MODE" in
  --dry-run)
    printf 'DRY RUN: would add standard keyboard and mouse functions for %s seconds\n' "$ROLLBACK_AFTER"
    printf 'Automatic rollback would start before USB is unbound\n'
    printf 'No USB configuration was changed\n'
    exit 0
    ;;
  --apply) ;;
  *)
    printf 'Usage: %s [--dry-run|--apply] [rollback-seconds]\n' "$0" >&2
    exit 2
    ;;
esac

case "$ROLLBACK_AFTER" in
  *[!0-9]*|'') printf 'FAIL: rollback-seconds must be an integer\n' >&2; exit 1 ;;
esac
[ "$ROLLBACK_AFTER" -ge 20 ] && [ "$ROLLBACK_AFTER" -le 300 ] || { printf 'FAIL: rollback-seconds must be 20..300\n' >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { printf 'FAIL: --apply requires root\n' >&2; exit 1; }
[ -d "$GADGET/configs/$CONFIGURATION" ] || { printf 'FAIL: expected gadget configuration was not found\n' >&2; exit 1; }
[ "$(cat "$GADGET/UDC")" = "$EXPECTED_UDC" ] || { printf 'FAIL: UDC binding changed after plan generation\n' >&2; exit 1; }
[ -s "$SCRIPT_DIR/keyboard-report-desc.bin" ] || { printf 'FAIL: keyboard descriptor is missing\n' >&2; exit 1; }
[ -s "$SCRIPT_DIR/mouse-report-desc.bin" ] || { printf 'FAIL: mouse descriptor is missing\n' >&2; exit 1; }
[ -s "$SCRIPT_DIR/pointer-report-desc.bin" ] || { printf 'FAIL: pointer descriptor is missing\n' >&2; exit 1; }
[ -s "$SCRIPT_DIR/power-report-desc.bin" ] || { printf 'FAIL: power descriptor is missing\n' >&2; exit 1; }
if [ -r "$GADGET/os_desc/use" ] && [ "$(cat "$GADGET/os_desc/use")" = 1 ]; then
  [ -L "$OS_DESC_LINK" ] || { printf 'FAIL: enabled OS descriptor configuration link is missing\n' >&2; exit 1; }
fi

for function_name in '__EXISTING__'; do
  [ -d "$GADGET/functions/$function_name" ] || { printf 'FAIL: existing function %s is missing\n' "$function_name" >&2; exit 1; }
done

for function_name in 'hid.keyboard' 'hid.mouse' 'hid.pointer' 'hid.power'; do
  [ ! -e "$GADGET/functions/$function_name" ] || { printf 'FAIL: function %s already exists\n' "$function_name" >&2; exit 1; }
done

mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/cancel" "$STATE_DIR/rollback.log"
nohup sh -c 'sleep "$1"; if [ ! -e "$2/cancel" ]; then "$3/rollback.sh" --apply > "$2/rollback.log" 2>&1; fi' sh "$ROLLBACK_AFTER" "$STATE_DIR" "$SCRIPT_DIR" </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > "$STATE_DIR/watchdog.pid"

ROLLBACK_NEEDED=true
rollback_on_exit() {
  if [ "$ROLLBACK_NEEDED" = true ]; then
    "$SCRIPT_DIR/rollback.sh" --apply || true
  fi
}
trap rollback_on_exit EXIT HUP INT TERM

printf '\n' > "$GADGET/UDC"
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
printf 'Temporary HID enumeration active; automatic rollback in %s seconds\n' "$ROLLBACK_AFTER"
printf 'No keyboard or mouse report was sent\n'
