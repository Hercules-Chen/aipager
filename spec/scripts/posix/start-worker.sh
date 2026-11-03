#!/usr/bin/env bash
# Claude Relay worker launcher for macOS and Linux (bash 3.2 compatible, LF line endings).
# Prints what it is about to run, then execs node so the service manager (launchd / systemd) supervises it directly.
# Env: RELAY_CONFIG (node.json path), RELAY_APP_DIR (default /opt/claude-relay), RELAY_INSPECT_PORT (Chrome DevTools)
set -euo pipefail

log() { printf '[start-worker %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

case "$(uname -s)" in
  Darwin) OS=macos; DEFAULT_CONFIG="$HOME/Library/Application Support/ClaudeRelay/node/node.json" ;;
  Linux)  OS=linux; DEFAULT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/claude-relay/node.json" ;;
  *) log "unsupported OS: $(uname -s)"; exit 2 ;;
esac

CONFIG="${RELAY_CONFIG:-$DEFAULT_CONFIG}"
APP_DIR="${RELAY_APP_DIR:-/opt/claude-relay}"
INSPECT_PORT="${RELAY_INSPECT_PORT:-0}"

command -v node >/dev/null 2>&1 || { log "node not found in PATH=$PATH"; exit 3; }
[ -f "$CONFIG" ] || { log "config not found: $CONFIG"; exit 2; }

cfg() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],c);console.log(Array.isArray(v)?v.join(","):(v==null?"":v))' "$CONFIG" "$1"; }

CLAUDE_PATH="$(cfg claude_path)"
log "os          = $OS ($(uname -m))"
log "config      = $CONFIG"
log "node_id     = $(cfg node_id)"
log "hub_url     = $(cfg hub_url)"
log "roles/labels = managed at the Hub (relayctl nodes show $(cfg node_id))"
log "claude_auth = $(cfg claude_auth.mode)"
log "claude_path = $CLAUDE_PATH"
log "token_file  = $(cfg token_file)  (content not shown)"
log "node        = $(node --version) at $(command -v node)"
log "user        = $(id -un)"

[ -x "$CLAUDE_PATH" ] || { log "claude_path is not executable; install Claude Code and log in first"; exit 3; }
log "claude      = $("$CLAUDE_PATH" --version 2>&1 | head -n 1)"

NODE_ARGS=""
if [ "$INSPECT_PORT" != "0" ]; then
  NODE_ARGS="--inspect=127.0.0.1:$INSPECT_PORT"
  log "Chrome DevTools: chrome://inspect -> 127.0.0.1:$INSPECT_PORT"
fi

log "exec: node $NODE_ARGS $APP_DIR/bin/worker.js --config $CONFIG"
# shellcheck disable=SC2086
exec node $NODE_ARGS "$APP_DIR/bin/worker.js" --config "$CONFIG"
