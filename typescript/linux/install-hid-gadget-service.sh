#!/bin/sh
# TypeScript installer; RDK X5 execution is UNVERIFIED.
set -eu

UNIT_NAME=agent-ip-kvm-hid-gadget-ts.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
INSTALL_DIR=/usr/local/lib/agent-ip-kvm-ts
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script with sudo." >&2
    exit 1
fi

if [ "${1:-}" = "--remove" ]; then
    systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
    if [ -x "$INSTALL_DIR/apply-hid-gadget.sh" ]; then
        "$INSTALL_DIR/apply-hid-gadget.sh" --remove || true
    fi
    rm -f "$UNIT_PATH"
    rm -rf "$INSTALL_DIR"
    systemctl daemon-reload
    echo "Removed persistent Agent IP KVM HID Gadget service."
    exit 0
fi

if [ "$#" -ne 0 ]; then
    echo "Usage: sudo sh $0 [--remove]" >&2
    exit 2
fi

if systemctl is-active --quiet agent-ip-kvm-hid-gadget.service; then
    echo 'Existing Python-era HID service is active; reuse its endpoints or stop it explicitly before installing this alternative.' >&2
    exit 2
fi
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/apply-hid-gadget.sh" "$INSTALL_DIR/apply-hid-gadget.sh"
chmod 0755 "$INSTALL_DIR/apply-hid-gadget.sh"

node - "$INSTALL_DIR" "$SCRIPT_DIR/../templates/hid-functions.json" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
for (const fn of JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))) {
  const role = fn.name === 'hid.power' ? 'system-control' : fn.name.slice(4);
  fs.writeFileSync(path.join(process.argv[2], role + '-report-desc.bin'), Buffer.from(fn.report_descriptor_hex, 'hex'));
}
JS
chmod 0644 "$INSTALL_DIR"/*-report-desc.bin

cat > "$UNIT_PATH" <<'UNIT'
[Unit]
Description=Add Agent IP KVM keyboard and absolute pointer devices to the existing USB Gadget
After=hobot-usb-gadget.service
Wants=hobot-usb-gadget.service

[Service]
Type=oneshot
Environment=AGENT_IP_KVM_INCLUDE_RELATIVE_MOUSE=0
Environment=AGENT_IP_KVM_INCLUDE_ABSOLUTE_POINTER=1
ExecStart=/usr/local/lib/agent-ip-kvm-ts/apply-hid-gadget.sh --apply
RemainAfterExit=yes

[Install]
WantedBy=graphical.target
UNIT

systemctl daemon-reload
systemctl disable "$UNIT_NAME" 2>/dev/null || true
systemctl enable "$UNIT_NAME"
systemctl restart "$UNIT_NAME"
echo "Installed persistent Agent IP KVM HID Gadget service."
