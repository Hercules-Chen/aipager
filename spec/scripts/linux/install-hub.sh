#!/usr/bin/env bash
# AIPager Hub installer for Linux (systemd). Run as root.
# Preconditions: /opt/node-v22/bin/node exists (official tarball), release copied to /opt/aipager.
# Usage: sudo ./install-hub.sh [--allow-cidr 100.64.0.0/10] [--port 7300]
set -euo pipefail

ALLOW_CIDR="100.64.0.0/10"   # Tailscale CGNAT range; use your LAN subnet if not using Tailscale
PORT=7300
NODE_BIN=/opt/node-v22/bin/node
APP_DIR=/opt/aipager
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-cidr) ALLOW_CIDR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[install-hub %s] %s\n' "$(date '+%F %T')" "$*"; }

[ "$(id -u)" -eq 0 ] || { log "must run as root"; exit 2; }
[ -x "$NODE_BIN" ] || { log "node not found at $NODE_BIN"; exit 3; }
[ -f "$APP_DIR/bin/hub.js" ] || { log "hub.js not found under $APP_DIR"; exit 3; }
log "node      = $("$NODE_BIN" --version)"
"$NODE_BIN" -e "require('node:sqlite'); console.log('[install-hub] node:sqlite ok')" 2>/dev/null

if ! id aipager >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/aipager --shell /usr/sbin/nologin aipager
  log "created system user aipager"
fi

install -d -o root -g aipager -m 0750 /etc/aipager
install -d -o aipager -g aipager -m 0750 /var/lib/aipager /var/lib/aipager/blobs /var/lib/aipager/backup
install -d -o aipager -g aipager -m 0750 /var/log/aipager

if [ ! -f /etc/aipager/hub.json ]; then
  install -o root -g aipager -m 0640 "$APP_DIR/spec/config/hub.json" /etc/aipager/hub.json
  log "copied hub.json template -> /etc/aipager/hub.json (edit listen.host before starting)"
fi

install -o root -g root -m 0644 "$APP_DIR/spec/scripts/linux/aipager-hub.service" /etc/systemd/system/aipager-hub.service
systemctl daemon-reload
log "installed systemd unit aipager-hub.service"

if command -v ufw >/dev/null 2>&1; then
  ufw allow from "$ALLOW_CIDR" to any port "$PORT" proto tcp comment 'aipager hub'
  log "ufw: allowed $ALLOW_CIDR -> tcp/$PORT"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$ALLOW_CIDR port port=$PORT protocol=tcp accept"
  firewall-cmd --reload
  log "firewalld: allowed $ALLOW_CIDR -> tcp/$PORT"
else
  log "no ufw/firewalld found; open tcp/$PORT for $ALLOW_CIDR manually"
fi

log "next: sudo -u aipager $NODE_BIN $APP_DIR/bin/aipagerctl.js admin init --config /etc/aipager/hub.json"
log "then: systemctl enable --now aipager-hub && journalctl -u aipager-hub -f"
