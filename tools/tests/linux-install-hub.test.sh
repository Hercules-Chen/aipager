#!/usr/bin/env bash
# A06: run spec/scripts/linux/install-hub.sh for real on a disposable Ubuntu machine / container.
# It CHANGES THE SYSTEM (creates user aipager, /etc/aipager, /var/lib/aipager,
# /var/log/aipager, /opt/aipager, a systemd unit), so it only runs when
# AIPAGER_TEST_ALLOW_SYSTEM_CHANGES=1 and as root. systemctl is replaced by a stub that records calls,
# so it also works in containers without a running systemd. Everything it created is removed at the end
# unless AIPAGER_TEST_KEEP=1.
# Usage: sudo AIPAGER_TEST_ALLOW_SYSTEM_CHANGES=1 bash tools/tests/linux-install-hub.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0
pass() { printf '[OK]  %s\n' "$1"; }
fail() { printf '[ERR] %s\n' "$1"; FAILED=$((FAILED + 1)); }

if [ "$(uname -s)" != "Linux" ] || [ "$(id -u)" -ne 0 ] || [ "${AIPAGER_TEST_ALLOW_SYSTEM_CHANGES:-0}" != "1" ]; then
  echo "A06 SKIPPED (needs Linux, root and AIPAGER_TEST_ALLOW_SYSTEM_CHANGES=1)"; exit 0
fi
for p in /opt/aipager /etc/aipager /var/lib/aipager /var/log/aipager /etc/systemd/system/aipager-hub.service; do
  if [ -e "$p" ]; then echo "A06 ABORTED: $p already exists; refusing to touch an existing installation"; exit 1; fi
done
if id aipager >/dev/null 2>&1; then echo "A06 ABORTED: user aipager already exists"; exit 1; fi

. /etc/os-release
echo "environment: $PRETTY_NAME, $(install --version | head -n1), $(useradd --help 2>&1 | head -n1 | cut -c1-40)"

CREATED_NODE=0
if [ ! -e /opt/node-v22/bin/node ]; then
  mkdir -p /opt/node-v22/bin && ln -s "$(command -v node)" /opt/node-v22/bin/node && CREATED_NODE=1
fi
mkdir -p /opt/aipager/bin /opt/aipager/spec/config /opt/aipager/spec/scripts/linux
printf '// stub hub for install test\n' > /opt/aipager/bin/hub.js
cp "$ROOT/spec/config/hub.json" /opt/aipager/spec/config/hub.json
cp "$ROOT/spec/scripts/linux/aipager-hub.service" /opt/aipager/spec/scripts/linux/
STUB="$(mktemp -d)"
printf '#!/bin/sh\necho "systemctl $*" >> "%s/calls.log"\n' "$STUB" > "$STUB/systemctl"
chmod +x "$STUB/systemctl"

cleanup() {
  if [ "${AIPAGER_TEST_KEEP:-0}" = "1" ]; then echo "AIPAGER_TEST_KEEP=1: leaving installation in place"; return; fi
  rm -rf -- /opt/aipager /etc/aipager /var/lib/aipager /var/log/aipager /etc/systemd/system/aipager-hub.service "$STUB"
  [ "$CREATED_NODE" = 1 ] && rm -rf -- /opt/node-v22
  id aipager >/dev/null 2>&1 && userdel aipager
}
trap cleanup EXIT

run_install() { PATH="$STUB:$PATH" bash "$ROOT/spec/scripts/linux/install-hub.sh" --allow-cidr 100.64.0.0/10 > "$STUB/out.txt" 2>&1; echo $?; }

rc=$(run_install)
if [ "$rc" = "0" ]; then pass "install-hub.sh exit 0"; else fail "install-hub.sh exit $rc"; cat "$STUB/out.txt"; fi
grep -q 'node:sqlite ok' "$STUB/out.txt" && pass "node:sqlite check printed" || fail "node:sqlite check missing"

shell="$(getent passwd aipager | cut -d: -f7)"
uid="$(id -u aipager 2>/dev/null || echo none)"
if [ "$shell" = "/usr/sbin/nologin" ] && [ "$uid" != "none" ] && [ "$uid" -lt 1000 ]; then pass "system user aipager (uid $uid, nologin)"; else fail "user aipager shell=$shell uid=$uid"; fi

check_path() { # path owner group mode
  local got; got="$(stat -c '%U %G %a' "$1" 2>/dev/null)"
  if [ "$got" = "$2 $3 $4" ]; then pass "$1 = $got"; else fail "$1 expected '$2 $3 $4' got '$got'"; fi
}
check_path /etc/aipager root aipager 750
check_path /etc/aipager/hub.json root aipager 640
check_path /var/lib/aipager aipager aipager 750
check_path /var/lib/aipager/blobs aipager aipager 750
check_path /var/lib/aipager/backup aipager aipager 750
check_path /var/log/aipager aipager aipager 750
check_path /etc/systemd/system/aipager-hub.service root root 644
grep -q 'systemctl daemon-reload' "$STUB/calls.log" && pass "systemctl daemon-reload called" || fail "daemon-reload not called"
if command -v ufw >/dev/null 2>&1 || command -v firewall-cmd >/dev/null 2>&1; then
  grep -q 'allowed 100.64.0.0/10' "$STUB/out.txt" && pass "firewall rule added" || fail "firewall rule not reported"
else
  grep -q 'no ufw/firewalld found' "$STUB/out.txt" && pass "no firewall tool: manual instruction printed" || fail "missing firewall message"
fi

# second run must be idempotent and must not overwrite an edited hub.json
echo '{"edited":true}' > /etc/aipager/hub.json
rc=$(run_install)
if [ "$rc" = "0" ] && grep -q '"edited":true' /etc/aipager/hub.json; then pass "second run: exit 0, existing hub.json kept"; else fail "second run rc=$rc or hub.json overwritten"; fi

if [ "$FAILED" -eq 0 ]; then echo "A06 PASSED"; exit 0; else echo "A06 FAILED: $FAILED"; exit 1; fi
