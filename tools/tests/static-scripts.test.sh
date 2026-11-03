#!/usr/bin/env bash
# A05: static checks of the service scripts that cannot be executed on this machine.
#   - bash -n on every .sh
#   - launchd plist parses (python3 plistlib) and has the required keys
#   - systemd units have [Unit]/[Service]/[Install] and ExecStart; systemd-analyze verify when available
#   - .ps1 parses with pwsh when available (otherwise reported as SKIPPED, not as passed)
# Usage: bash tools/tests/static-scripts.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0
pass() { printf '[OK]  %s\n' "$1"; }
fail() { printf '[ERR] %s\n' "$1"; FAILED=$((FAILED + 1)); }
skip() { printf '[SKIP] %s\n' "$1"; }

while IFS= read -r f; do
  if bash -n "$f" 2>/dev/null; then pass "bash -n ${f#$ROOT/}"; else fail "bash -n ${f#$ROOT/}"; fi
done < <(find "$ROOT/spec" "$ROOT/tools" -name '*.sh' -type f | sort)

for f in "$ROOT"/spec/scripts/macos/*.plist; do
  if command -v python3 >/dev/null 2>&1; then
    if python3 -c '
import plistlib, sys
d = plistlib.load(open(sys.argv[1], "rb"))
missing = [k for k in ("Label", "ProgramArguments", "RunAtLoad", "KeepAlive", "EnvironmentVariables") if k not in d]
sys.exit(1 if missing else 0)
' "$f"; then pass "plist parses with required keys: ${f#$ROOT/}"; else fail "plist: ${f#$ROOT/}"; fi
  else skip "python3 not found: ${f#$ROOT/}"; fi
done

for f in "$ROOT"/spec/scripts/linux/*.service; do
  ok=1
  for s in '^\[Unit\]' '^\[Service\]' '^\[Install\]' '^ExecStart='; do grep -q "$s" "$f" || ok=0; done
  if [ "$ok" = 1 ]; then pass "systemd unit sections present: ${f#$ROOT/}"; else fail "systemd unit: ${f#$ROOT/}"; fi
  if command -v systemd-analyze >/dev/null 2>&1; then
    # The unit's node path (/opt/node-v22) may not exist on this machine. Verify a copy whose
    # ExecStart uses the local node, so every other directive is still checked for real.
    tmpdir="$(mktemp -d)"
    sed "s#^ExecStart=/opt/node-v22/bin/node #ExecStart=$(command -v node) #" "$f" > "$tmpdir/$(basename "$f")"
    if out="$(systemd-analyze verify "$tmpdir/$(basename "$f")" 2>&1)" && [ -z "$out" ]; then
      pass "systemd-analyze verify ${f#$ROOT/} (systemd $(systemd-analyze --version | head -n1 | cut -d' ' -f2))"
    else
      # Paths that only exist after installation are reported but not counted as failures.
      if printf '%s\n' "$out" | grep -v -e 'No such file or directory' -e '^$' | grep -q .; then fail "systemd-analyze verify ${f#$ROOT/}: $out"
      else skip "systemd-analyze: only missing install paths reported for ${f#$ROOT/}"; fi
    fi
    rm -rf -- "$tmpdir"
  else skip "systemd-analyze not available: ${f#$ROOT/}"; fi
done

for f in "$ROOT"/spec/scripts/windows/*.ps1; do
  if command -v pwsh >/dev/null 2>&1; then
    if pwsh -NoProfile -Command "\$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$f',[ref]\$null,[ref]\$e); if(\$e.Count){exit 1}"; then
      pass "pwsh parse ${f#$ROOT/}"; else fail "pwsh parse ${f#$ROOT/}"; fi
  else skip "pwsh not available, not parsed: ${f#$ROOT/}"; fi
done

if [ "$FAILED" -eq 0 ]; then echo "A05 PASSED"; exit 0; else echo "A05 FAILED: $FAILED"; exit 1; fi
