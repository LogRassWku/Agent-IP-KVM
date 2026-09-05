#!/bin/sh
set -eu

UNIT_NAME=agent-ip-kvm-web.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script with sudo." >&2
    exit 1
fi

if [ "${1:-}" = "--remove" ]; then
    systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl daemon-reload
    echo "Removed Agent IP KVM Web service."
    exit 0
fi

SERVICE_USER=${1:-sunrise}
PROJECT_DIR=${2:-/home/$SERVICE_USER/agent-ip-kvm-app}

case "$SERVICE_USER" in
    ""|[0-9-]*|*[!A-Za-z0-9_-]*)
        echo "Invalid service user name." >&2
        exit 2
        ;;
esac
case "$PROJECT_DIR" in
    /*) ;;
    *) echo "Project directory must be an absolute path." >&2; exit 2 ;;
esac
case "$PROJECT_DIR" in
    *[!A-Za-z0-9_./-]*) echo "Project directory contains unsupported characters." >&2; exit 2 ;;
esac

id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Unknown service user: $SERVICE_USER" >&2; exit 2; }
[ -f "$PROJECT_DIR/src/agent_ip_kvm/web.py" ] || { echo "Agent IP KVM project was not found: $PROJECT_DIR" >&2; exit 2; }
PYTHON3=$(command -v python3)
DATA_DIR="$PROJECT_DIR/data"
TOKEN_FILE="$DATA_DIR/pc-agent-token"
install -d -m 0700 -o "$SERVICE_USER" -g "$(id -gn "$SERVICE_USER")" "$DATA_DIR"
if [ ! -s "$TOKEN_FILE" ]; then
    umask 077
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE"
fi
chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
pkill -f '[p]ython3 -m agent_ip_kvm.web' 2>/dev/null || true

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Agent IP KVM Web interface
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
Environment=PYTHONPATH=$PROJECT_DIR/src
ExecStart=$PYTHON3 -m agent_ip_kvm.web --host 0.0.0.0 --port 8765 --source v4l2 --device /dev/video0 --width 1920 --height 1080 --fps 30 --enable-hid --hid-backend auto --host-info-file $DATA_DIR/controlled-host.json --audit-file $DATA_DIR/audit.jsonl --pc-agent-token-file $TOKEN_FILE --pc-agent-suggestion-file $DATA_DIR/pc-agent-suggestion.json --model-setup-file $DATA_DIR/model-setup-tasks.json --pc-agent-callback-url http://192.168.128.10:8765
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
echo "Installed Agent IP KVM Web service for $SERVICE_USER."
