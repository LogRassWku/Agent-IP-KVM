#!/bin/sh
# TypeScript RDK X5 deployment: NOT hardware-validated.
set -eu
UNIT_NAME=agent-ip-kvm-web-ts.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
if [ "${1:-}" = --remove ]; then
  systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  exit 0
fi
SERVICE_USER=${1:-sunrise}
PROJECT_DIR=${2:-/home/$SERVICE_USER/agent-ip-kvm-ts}
case "$SERVICE_USER" in ''|[0-9-]*|*[!A-Za-z0-9_-]*) echo 'Invalid service user.' >&2; exit 2 ;; esac
case "$PROJECT_DIR" in /*) ;; *) echo 'Use an absolute project path.' >&2; exit 2 ;; esac
case "$PROJECT_DIR" in *[!A-Za-z0-9_./-]*) echo 'Unsupported project path.' >&2; exit 2 ;; esac
id "$SERVICE_USER" >/dev/null
[ -f "$PROJECT_DIR/dist/cli.js" ] || { echo 'Run npm ci and npm run build first.' >&2; exit 2; }
NODE=$(command -v node)
"$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
DATA_DIR="$PROJECT_DIR/data/typescript"
install -d -m 0700 -o "$SERVICE_USER" -g "$(id -gn "$SERVICE_USER")" "$DATA_DIR"
TOKEN_FILE="$DATA_DIR/pc-agent-token"
if [ ! -s "$TOKEN_FILE" ]; then
  umask 077
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE"
fi
chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Agent IP KVM TypeScript (hardware unverified)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE $PROJECT_DIR/dist/cli.js --host 0.0.0.0 --port 8766 --source v4l2 --device /dev/video0 --width 1920 --height 1080 --fps 30 --hid-backend auto --data-dir $DATA_DIR --pc-agent-callback-url http://192.168.128.10:8766
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
echo 'Installed TypeScript service on port 8766; Python service was not modified.'
