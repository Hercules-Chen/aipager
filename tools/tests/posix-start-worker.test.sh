#!/usr/bin/env bash
# A03: spec/scripts/posix/start-worker.sh behaves as specified (macOS / Linux).
# Uses a stub `claude` and a stub worker.js, so no Claude login or Hub is needed.
# Usage: bash tools/tests/posix-start-worker.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/spec/scripts/posix/start-worker.sh"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
FAILED=0
pass() { printf '[OK]  %s\n' "$1"; }
fail() { printf '[ERR] %s\n' "$1"; FAILED=$((FAILED + 1)); }

mkdir -p "$TMP/app/bin" "$TMP/bin" "$TMP/home"
printf '#!/bin/sh\necho "9.9.9 (Claude Code stub)"\n' > "$TMP/bin/claude"
chmod +x "$TMP/bin/claude"
printf 'console.log("[stub worker] argv=" + JSON.stringify(process.argv.slice(2)));\n' > "$TMP/app/bin/worker.js"

case "$(uname -s)" in
  Darwin) DEFAULT_DIR="$TMP/home/Library/Application Support/AIPager/node" ;;
  *)      DEFAULT_DIR="$TMP/home/.config/aipager" ;;
esac
mkdir -p "$DEFAULT_DIR"
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
c.claude_path = process.argv[2];
fs.writeFileSync(process.argv[3], JSON.stringify(c, null, 2));
' "$ROOT/spec/config/node.linux.json" "$TMP/bin/claude" "$DEFAULT_DIR/node.json"

run() { env -u AIPAGER_CONFIG -u XDG_CONFIG_HOME HOME="$TMP/home" AIPAGER_APP_DIR="$TMP/app" "$@" bash "$SCRIPT" > "$TMP/out.txt" 2>&1; echo $?; }

# 1. default config path, prints diagnostics, execs worker with --config
rc=$(run)
if [ "$rc" = "0" ] && grep -q '"--config"' "$TMP/out.txt" && grep -q 'node_id     = linux-box' "$TMP/out.txt" && grep -q 'claude      = 9.9.9' "$TMP/out.txt"; then
  pass "default config path: exit 0, diagnostics printed, worker started with --config"
else fail "default config path (rc=$rc)"; cat "$TMP/out.txt"; fi
if grep -qi 'token' "$TMP/out.txt" && grep -q 'content not shown' "$TMP/out.txt"; then
  pass "token file path printed, content not shown"
else fail "token line missing"; fi

# 2. missing config -> exit 2
rc=$(run AIPAGER_CONFIG="$TMP/nope.json")
if [ "$rc" = "2" ] && grep -q 'config not found' "$TMP/out.txt"; then pass "missing config: exit 2 with message"; else fail "missing config (rc=$rc)"; fi

# 3. claude_path not executable -> exit 3
chmod -x "$TMP/bin/claude"
rc=$(run)
if [ "$rc" = "3" ] && grep -q 'claude_path is not executable' "$TMP/out.txt"; then pass "claude not executable: exit 3 with message"; else fail "claude not executable (rc=$rc)"; fi
chmod +x "$TMP/bin/claude"

# 4. Chrome DevTools inspect port
rc=$(run AIPAGER_INSPECT_PORT=9239)
if [ "$rc" = "0" ] && grep -q 'Debugger listening on ws://127.0.0.1:9239' "$TMP/out.txt"; then pass "AIPAGER_INSPECT_PORT: node started with --inspect on 127.0.0.1:9239"; else fail "inspect port (rc=$rc)"; cat "$TMP/out.txt"; fi

# 5. Linux: XDG_CONFIG_HOME is honoured
if [ "$(uname -s)" = "Linux" ]; then
  mkdir -p "$TMP/xdg/aipager"
  cp "$DEFAULT_DIR/node.json" "$TMP/xdg/aipager/node.json"
  rc=$(run XDG_CONFIG_HOME="$TMP/xdg")
  if [ "$rc" = "0" ] && grep -q "config      = $TMP/xdg/aipager/node.json" "$TMP/out.txt"; then pass "XDG_CONFIG_HOME honoured"; else fail "XDG_CONFIG_HOME (rc=$rc)"; fi
fi

if [ "$FAILED" -eq 0 ]; then echo "A03 PASSED"; exit 0; else echo "A03 FAILED: $FAILED"; exit 1; fi
