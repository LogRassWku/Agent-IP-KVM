#!/bin/sh
set -eu

RULE_PATH=/etc/udev/rules.d/70-agent-ip-kvm-hid.rules

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "Run this script with sudo." >&2
        exit 1
    fi
}

reload_rules() {
    udevadm control --reload-rules
}

reset_existing_nodes() {
    for node in /dev/hidg*; do
        [ -e "$node" ] || continue
        chown root:root "$node"
        chmod 0600 "$node"
    done
}

apply_existing_nodes() {
    service_user=$1
    for node in /dev/hidg*; do
        [ -e "$node" ] || continue
        chown "$service_user" "$node"
        chmod 0600 "$node"
    done
}

require_root

if [ "${1:-}" = "--remove" ]; then
    rm -f "$RULE_PATH"
    reload_rules
    reset_existing_nodes
    echo "Removed Agent IP KVM HID access rule."
    exit 0
fi

if [ "$#" -ne 1 ]; then
    echo "Usage: sudo sh $0 SERVICE_USER | --remove" >&2
    exit 2
fi

SERVICE_USER=$1
case "$SERVICE_USER" in
    ""|[0-9-]*|*[!A-Za-z0-9_-]*)
        echo "Invalid service user name." >&2
        exit 2
        ;;
esac

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Unknown service user: $SERVICE_USER" >&2
    exit 2
fi

RULE_TMP=$(mktemp "${RULE_PATH}.XXXXXX")
trap 'rm -f "$RULE_TMP"' EXIT HUP INT TERM
printf 'KERNEL=="hidg*", OWNER="%s", MODE="0600"\n' "$SERVICE_USER" > "$RULE_TMP"
chmod 0644 "$RULE_TMP"
mv "$RULE_TMP" "$RULE_PATH"
trap - EXIT HUP INT TERM

reload_rules
apply_existing_nodes "$SERVICE_USER"
echo "Installed Agent IP KVM HID access rule for $SERVICE_USER."
