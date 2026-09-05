#!/bin/sh
set -eu

UNIT_NAME=agent-ip-kvm-usb-dhcp.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script with sudo." >&2
    exit 1
fi

if [ "${1:-}" = "--remove" ]; then
    systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl daemon-reload
    echo "Removed Agent IP KVM USB network service."
    exit 0
fi

DNSMASQ=$(command -v dnsmasq) || {
    echo "dnsmasq is required for controlled-host USB networking." >&2
    exit 2
}

install -d -m 0755 /var/lib/agent-ip-kvm
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Agent IP KVM controlled-host USB DHCP
After=network.target agent-ip-kvm-hid-gadget.service
Wants=agent-ip-kvm-hid-gadget.service

[Service]
Type=simple
ExecStart=$DNSMASQ --keep-in-foreground --port=0 --interface=usb0 --bind-interfaces --dhcp-range=192.168.128.20,192.168.128.50,255.255.255.0,12h --dhcp-option=3 --dhcp-option=6 --dhcp-leasefile=/var/lib/agent-ip-kvm/usb-dhcp.leases --pid-file=
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
echo "Installed Agent IP KVM USB network service."
