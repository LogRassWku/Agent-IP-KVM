#!/bin/sh
set -eu

CONFIGFS_ROOT=${AGENT_IP_KVM_CONFIGFS_ROOT:-/sys/kernel/config/usb_gadget}
GADGET_NAME=${AGENT_IP_KVM_GADGET_NAME:-g_comp}
CONFIGURATION=${AGENT_IP_KVM_CONFIGURATION:-c.1}
GADGET="$CONFIGFS_ROOT/$GADGET_NAME"
CONFIG="$GADGET/configs/$CONFIGURATION"
OS_DESC_LINK="$GADGET/os_desc/$CONFIGURATION"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
KEYBOARD_FUNCTION=hid.keyboard
MOUSE_FUNCTION=hid.mouse

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

require_root() {
    [ "$(id -u)" -eq 0 ] || fail "this operation requires root"
}

wait_for_gadget() {
    attempts=0
    while [ ! -d "$CONFIG" ] && [ "$attempts" -lt 30 ]; do
        attempts=$((attempts + 1))
        sleep 1
    done
    [ -d "$CONFIG" ] || fail "USB Gadget configuration did not appear: $CONFIG"
}

select_udc() {
    selected=$(cat "$GADGET/UDC" 2>/dev/null || true)
    if [ -z "$selected" ]; then
        selected=${AGENT_IP_KVM_UDC:-}
    fi
    if [ -z "$selected" ]; then
        for candidate in /sys/class/udc/*; do
            [ -e "$candidate" ] || continue
            selected=${candidate##*/}
            break
        done
    fi
    [ -n "$selected" ] || fail "no USB Device Controller is available"
    printf '%s' "$selected"
}

restore_os_descriptor() {
    if [ "${OS_DESC_LINKED:-0}" = 1 ] && [ ! -L "$OS_DESC_LINK" ]; then
        (cd "$GADGET" && ln -s "configs/$CONFIGURATION" os_desc)
    fi
}

remove_project_functions() {
    rm -f "$CONFIG/$KEYBOARD_FUNCTION" "$CONFIG/$MOUSE_FUNCTION"
    rmdir "$GADGET/functions/$KEYBOARD_FUNCTION" 2>/dev/null || true
    rmdir "$GADGET/functions/$MOUSE_FUNCTION" 2>/dev/null || true
}

apply_hid() {
    require_root
    wait_for_gadget
    [ -r "$SCRIPT_DIR/keyboard-report-desc.bin" ] || fail "keyboard descriptor is missing"
    [ -r "$SCRIPT_DIR/mouse-report-desc.bin" ] || fail "mouse descriptor is missing"

    if [ -d "$GADGET/functions/$KEYBOARD_FUNCTION" ] && \
       [ -d "$GADGET/functions/$MOUSE_FUNCTION" ] && \
       [ -L "$CONFIG/$KEYBOARD_FUNCTION" ] && \
       [ -L "$CONFIG/$MOUSE_FUNCTION" ]; then
        echo "Agent IP KVM HID functions are already active."
        return
    fi

    [ ! -e "$GADGET/functions/$KEYBOARD_FUNCTION" ] || fail "$KEYBOARD_FUNCTION already exists in a partial or foreign configuration"
    [ ! -e "$GADGET/functions/$MOUSE_FUNCTION" ] || fail "$MOUSE_FUNCTION already exists in a partial or foreign configuration"
    [ ! -e "$CONFIG/$KEYBOARD_FUNCTION" ] || fail "$KEYBOARD_FUNCTION link already exists"
    [ ! -e "$CONFIG/$MOUSE_FUNCTION" ] || fail "$MOUSE_FUNCTION link already exists"

    ACTIVE_UDC=$(select_udc)
    OS_DESC_LINKED=0
    if [ -L "$OS_DESC_LINK" ]; then
        OS_DESC_LINKED=1
    fi
    APPLY_COMPLETE=0

    rollback_partial() {
        trap - EXIT HUP INT TERM
        printf '' > "$GADGET/UDC" 2>/dev/null || true
        remove_project_functions
        restore_os_descriptor
        printf '%s' "$ACTIVE_UDC" > "$GADGET/UDC" 2>/dev/null || true
        [ "$APPLY_COMPLETE" -eq 1 ] || echo "Rolled back incomplete HID Gadget update." >&2
    }
    trap rollback_partial EXIT HUP INT TERM

    printf '' > "$GADGET/UDC"
    if [ "$OS_DESC_LINKED" -eq 1 ]; then
        rm "$OS_DESC_LINK"
    fi

    mkdir "$GADGET/functions/$KEYBOARD_FUNCTION"
    printf '1' > "$GADGET/functions/$KEYBOARD_FUNCTION/protocol"
    printf '1' > "$GADGET/functions/$KEYBOARD_FUNCTION/subclass"
    printf '8' > "$GADGET/functions/$KEYBOARD_FUNCTION/report_length"
    cat "$SCRIPT_DIR/keyboard-report-desc.bin" > "$GADGET/functions/$KEYBOARD_FUNCTION/report_desc"

    mkdir "$GADGET/functions/$MOUSE_FUNCTION"
    printf '2' > "$GADGET/functions/$MOUSE_FUNCTION/protocol"
    printf '1' > "$GADGET/functions/$MOUSE_FUNCTION/subclass"
    printf '4' > "$GADGET/functions/$MOUSE_FUNCTION/report_length"
    cat "$SCRIPT_DIR/mouse-report-desc.bin" > "$GADGET/functions/$MOUSE_FUNCTION/report_desc"

    (cd "$GADGET" && ln -s "functions/$KEYBOARD_FUNCTION" "configs/$CONFIGURATION")
    (cd "$GADGET" && ln -s "functions/$MOUSE_FUNCTION" "configs/$CONFIGURATION")
    restore_os_descriptor
    printf '%s' "$ACTIVE_UDC" > "$GADGET/UDC"

    APPLY_COMPLETE=1
    trap - EXIT HUP INT TERM
    echo "Agent IP KVM keyboard and mouse Gadget functions are active."
}

remove_hid() {
    require_root
    wait_for_gadget
    ACTIVE_UDC=$(select_udc)
    OS_DESC_LINKED=0
    if [ -L "$OS_DESC_LINK" ]; then
        OS_DESC_LINKED=1
    fi
    printf '' > "$GADGET/UDC"
    if [ "$OS_DESC_LINKED" -eq 1 ]; then
        rm "$OS_DESC_LINK"
    fi
    remove_project_functions
    restore_os_descriptor
    printf '%s' "$ACTIVE_UDC" > "$GADGET/UDC"
    echo "Removed Agent IP KVM HID Gadget functions."
}

status_hid() {
    wait_for_gadget
    if [ -L "$CONFIG/$KEYBOARD_FUNCTION" ] && [ -L "$CONFIG/$MOUSE_FUNCTION" ]; then
        echo "active"
    else
        echo "inactive"
    fi
}

case "${1:---status}" in
    --apply) apply_hid ;;
    --remove) remove_hid ;;
    --status) status_hid ;;
    *) echo "Usage: $0 [--status|--apply|--remove]" >&2; exit 2 ;;
esac
