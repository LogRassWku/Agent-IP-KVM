#!/bin/sh
set -eu

rule_path=/etc/udev/rules.d/99-agent-ip-kvm-uvc-power.rules

if [ "${1:-}" = "--remove" ]; then
    if [ "$(id -u)" -ne 0 ]; then
        echo "run as root to remove the UVC power rule" >&2
        exit 1
    fi
    rm -f "$rule_path"
    udevadm control --reload-rules
    echo "removed $rule_path"
    exit 0
fi

vendor_id=${1:-2b89}
product_id=${2:-5854}

case "$vendor_id$product_id" in
    *[!0-9A-Fa-f]*)
        echo "vendor and product IDs must contain only hexadecimal characters" >&2
        exit 1
        ;;
esac

if [ "${#vendor_id}" -ne 4 ] || [ "${#product_id}" -ne 4 ]; then
    echo "vendor and product IDs must each contain four hexadecimal characters" >&2
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "run as root to install the UVC power rule" >&2
    exit 1
fi

cat > "$rule_path" <<EOF
# Keep the selected Agent IP KVM capture device awake to preserve HDMI EDID/HPD.
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="$vendor_id", ATTR{idProduct}=="$product_id", TEST=="power/control", ATTR{power/control}="on"
EOF

udevadm control --reload-rules

for device in /sys/bus/usb/devices/*; do
    [ -f "$device/idVendor" ] || continue
    [ -f "$device/idProduct" ] || continue
    [ "$(cat "$device/idVendor")" = "$vendor_id" ] || continue
    [ "$(cat "$device/idProduct")" = "$product_id" ] || continue
    [ -f "$device/power/control" ] || continue
    echo on > "$device/power/control"
done

echo "installed $rule_path for $vendor_id:$product_id"
