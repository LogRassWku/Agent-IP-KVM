#!/bin/sh
set -eu

CONFIGFS_ROOT="${AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}"
GADGET="$CONFIGFS_ROOT/__GADGET__"
EXPECTED_UDC='__UDC__'
CONFIGURATION='__CONFIG__'

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[ -d "$CONFIGFS_ROOT" ] || fail "USB Gadget ConfigFS root is unavailable"
[ -d "$GADGET" ] || fail "expected gadget __GADGET__ was not found"
[ -r "$GADGET/UDC" ] || fail "gadget UDC binding is unreadable"
[ "$(cat "$GADGET/UDC")" = "$EXPECTED_UDC" ] || fail "UDC binding changed after plan generation"
[ -d "$GADGET/configs/$CONFIGURATION" ] || fail "configuration $CONFIGURATION was not found"

for function_name in '__EXISTING__'; do
  [ -d "$GADGET/functions/$function_name" ] || fail "existing function $function_name is missing"
done

for function_name in 'hid.keyboard' 'hid.mouse' 'hid.pointer' 'hid.power'; do
  [ ! -e "$GADGET/functions/$function_name" ] || fail "planned function $function_name already exists"
  [ ! -L "$GADGET/configs/$CONFIGURATION/$function_name" ] || fail "planned link $function_name already exists"
done

printf 'PASS: gadget state still matches the recovery manifest\n'
printf 'READ ONLY: no USB configuration was changed\n'
