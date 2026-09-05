#!/bin/sh
set -eu

UNIT_NAME=agent-ip-kvm-hid-gadget.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
INSTALL_DIR=/usr/local/lib/agent-ip-kvm
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

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/apply-hid-gadget.sh" "$INSTALL_DIR/apply-hid-gadget.sh"
chmod 0755 "$INSTALL_DIR/apply-hid-gadget.sh"

python3 - "$INSTALL_DIR" <<'PY'
from pathlib import Path
import sys

destination = Path(sys.argv[1])
(destination / "keyboard-report-desc.bin").write_bytes(bytes.fromhex(
    "05010906a101050719e029e71500250175019508810295017508810195057501050819012905910295017503910195067508150025650507190029658100c0"
))
(destination / "mouse-report-desc.bin").write_bytes(bytes.fromhex(
    "05010902a1010901a1000509190129051500250195057501810295017503810105010930093109381581257f750895038106c0c0"
))
(destination / "pointer-report-desc.bin").write_bytes(bytes.fromhex(
    "05010902a1010901a1000509190129081500250195087501810205010930093116000026ff7f75109502810209381581257f750895018106c0c0"
))
PY
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
ExecStart=/usr/local/lib/agent-ip-kvm/apply-hid-gadget.sh --apply
RemainAfterExit=yes

[Install]
WantedBy=graphical.target
UNIT

systemctl daemon-reload
systemctl disable "$UNIT_NAME" 2>/dev/null || true
systemctl enable "$UNIT_NAME"
systemctl restart "$UNIT_NAME"
echo "Installed persistent Agent IP KVM HID Gadget service."
