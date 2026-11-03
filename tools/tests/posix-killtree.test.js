// A04: POSIX cancel strategy used by the worker (macOS / Linux).
// Spawn the task in its own process group (detached:true), send SIGTERM to the whole group,
// fall back to SIGKILL after a grace period, then confirm no live (non-zombie) process remains.
// Zombies (state Z) are excluded on purpose: they are already dead and are reaped by the
// service manager (systemd / launchd); a container whose PID 1 does not reap will show them.
// Usage: node tools/tests/posix-killtree.test.js
'use strict';
const { spawn, execSync } = require('node:child_process');

if (process.platform === 'win32') { console.log('A04 SKIPPED (POSIX only)'); process.exit(0); }
let failed = 0;
const ok = (m) => console.log('[OK]  ' + m);
const bad = (m) => { failed++; console.log('[ERR] ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveInGroup(pgid) {
  const out = execSync('ps -A -o pid=,pgid=,stat=').toString();
  return out.split('\n').map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 3 && Number(c[1]) === pgid && !c[2].startsWith('Z')).length;
}

async function killTree(pgid, graceMs) {
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  const until = Date.now() + graceMs;
  while (Date.now() < until && liveInGroup(pgid) > 0) await sleep(100);
  if (liveInGroup(pgid) > 0) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } await sleep(300); return 'SIGKILL'; }
  return 'SIGTERM';
}

async function scenario(name, script, expectSignal) {
  const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(500);
  const before = liveInGroup(child.pid);
  const used = await killTree(child.pid, 2000);
  const after = liveInGroup(child.pid);
  if (before >= 3 && after === 0 && used === expectSignal) ok(`${name}: ${before} processes -> 0 live after ${used}`);
  else bad(`${name}: before=${before} after=${after} signal=${used} (expected ${expectSignal})`);
}

(async () => {
  await scenario('nested children exit on SIGTERM', 'sleep 300 & sleep 300 & bash -c "sleep 300" & wait', 'SIGTERM');
  await scenario('child ignoring SIGTERM is killed by SIGKILL fallback', 'trap "" TERM; sleep 300 & bash -c "trap \\"\\" TERM; sleep 300" & wait', 'SIGKILL');
  console.log(failed ? `A04 FAILED: ${failed}` : 'A04 PASSED');
  process.exit(failed ? 1 : 0);
})();
