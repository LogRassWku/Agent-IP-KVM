#!/bin/sh
set -eu

CONFIGFS_ROOT="${AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}"
GADGET="$CONFIGFS_ROOT/__GADGET__"
EXPECTED_UDC='__UDC__'
CONFIGURATION='__CONFIG__'
OS_DESC_LINK="$GADGET/os_desc/$CONFIGURATION"
MODE="${1:---dry-run}"

case "$MODE" in
  --dry-run)
    printf 'DRY RUN: would unbind %s, remove only Agent IP KVM HID functions, then rebind\n' "$EXPECTED_UDC"
    printf 'Functions: hid.keyboard hid.mouse hid.pointer hid.power\n'
    printf 'No USB configuration was changed\n'
    exit 0
    ;;
  --apply) ;;
  *)
    printf 'Usage: %s [--dry-run|--apply]\n' "$0" >&2
    exit 2
    ;;
esac

[ "$(id -u)" -eq 0 ] || { printf 'FAIL: --apply requires root\n' >&2; exit 1; }
[ -d "$GADGET" ] || { printf 'FAIL: expected gadget was not found\n' >&2; exit 1; }
[ -r "$GADGET/UDC" ] || { printf 'FAIL: UDC binding is unreadable\n' >&2; exit 1; }
CURRENT_UDC="$(cat "$GADGET/UDC")"
[ -z "$CURRENT_UDC" ] || [ "$CURRENT_UDC" = "$EXPECTED_UDC" ] || { printf 'FAIL: refusing to replace a different UDC binding\n' >&2; exit 1; }
OS_DESC_WAS_LINKED=false
if [ -L "$OS_DESC_LINK" ]; then
  OS_DESC_WAS_LINKED=true
fi

for function_name in '__EXISTING__'; do
  [ -d "$GADGET/functions/$function_name" ] || { printf 'FAIL: existing function %s is missing\n' "$function_name" >&2; exit 1; }
done

restore_os_desc() {
  if [ "$OS_DESC_WAS_LINKED" = true ] && [ ! -L "$OS_DESC_LINK" ]; then
    (cd "$GADGET" && ln -s "configs/$CONFIGURATION" os_desc) || true
  fi
}

rebind() {
  restore_os_desc
  if [ -r "$GADGET/UDC" ] && [ -z "$(cat "$GADGET/UDC")" ]; then
    printf '%s' "$EXPECTED_UDC" > "$GADGET/UDC" || true
  fi
}

trap rebind EXIT HUP INT TERM
if [ -n "$CURRENT_UDC" ]; then
  printf '\n' > "$GADGET/UDC"
fi
if [ "$OS_DESC_WAS_LINKED" = true ]; then
  rm -- "$OS_DESC_LINK"
fi

for function_name in 'hid.keyboard' 'hid.mouse' 'hid.pointer' 'hid.power'; do
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
printf 'Rollback complete: original UDC rebound; existing non-HID functions were preserved\n'
