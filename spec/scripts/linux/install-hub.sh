#!/usr/bin/env bash
# Claude Relay Hub installer for Linux (systemd). Run as root.
# Preconditions: /opt/node-v22/bin/node exists (official tarball), release copied to /opt/claude-relay.
# Usage: sudo ./install-hub.sh [--allow-cidr 100.64.0.0/10] [--port 7300]
set -euo pipefail

ALLOW_CIDR="100.64.0.0/10"   # Tailscale CGNAT range; use your LAN subnet if not using Tailscale
PORT=7300
NODE_BIN=/opt/node-v22/bin/node
APP_DIR=/opt/claude-relay
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

if ! id claude-relay >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/claude-relay --shell /usr/sbin/nologin claude-relay
  log "created system user claude-relay"
fi

install -d -o root -g claude-relay -m 0750 /etc/claude-relay
install -d -o claude-relay -g claude-relay -m 0750 /var/lib/claude-relay /var/lib/claude-relay/blobs /var/lib/claude-relay/backup
install -d -o claude-relay -g claude-relay -m 0750 /var/log/claude-relay

if [ ! -f /etc/claude-relay/hub.json ]; then
  install -o root -g claude-relay -m 0640 "$APP_DIR/templates/hub.json" /etc/claude-relay/hub.json
  log "copied hub.json template -> /etc/claude-relay/hub.json (edit listen.host before starting)"
fi

install -o root -g root -m 0644 "$APP_DIR/scripts/linux/claude-relay-hub.service" /etc/systemd/system/claude-relay-hub.service
systemctl daemon-reload
log "installed systemd unit claude-relay-hub.service"

if command -v ufw >/dev/null 2>&1; then
  ufw allow from "$ALLOW_CIDR" to any port "$PORT" proto tcp comment 'claude-relay hub'
  log "ufw: allowed $ALLOW_CIDR -> tcp/$PORT"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$ALLOW_CIDR port port=$PORT protocol=tcp accept"
  firewall-cmd --reload
  log "firewalld: allowed $ALLOW_CIDR -> tcp/$PORT"
else
  log "no ufw/firewalld found; open tcp/$PORT for $ALLOW_CIDR manually"
fi

log "next: sudo -u claude-relay $NODE_BIN $APP_DIR/bin/relayctl.js admin init --config /etc/claude-relay/hub.json"
log "then: systemctl enable --now claude-relay-hub && journalctl -u claude-relay-hub -f"
