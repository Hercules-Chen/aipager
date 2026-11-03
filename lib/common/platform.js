'use strict';
// OS-specific behaviour, kept in one place (spec chapter "跨平台差異").
const { spawn, execFile } = require('node:child_process');
const os = require('node:os');
const { osName, archName } = require('./paths');

// Stop a whole process tree. Windows: taskkill /T /F. POSIX: the child was spawned detached (own
// process group): SIGTERM the group, then SIGKILL after graceMs. Resolves with the signal used.
function killTree(child, { graceMs = 10000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve('none');
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('exit', () => resolve('taskkill'));
      k.on('error', () => { try { child.kill(); } catch { /* gone */ } resolve('kill'); });
      return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve('SIGKILL'); }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve('SIGTERM'); });
  });
}

// macOS: keep the machine from idle-sleeping while a task runs (lid close still sleeps).
function keepAwake(pid) {
  if (process.platform !== 'darwin') return null;
  try {
    const c = spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore', detached: false });
    c.on('error', () => {});
    return c;
  } catch { return null; }
}

function run(cmd, args, { timeoutMs = 3000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

async function osVersion() {
  const o = osName();
  if (o === 'macos') { const r = await run('sw_vers', ['-productVersion']); if (r.ok) return 'macOS ' + r.stdout.trim(); }
  if (o === 'linux') {
    try { const t = require('node:fs').readFileSync('/etc/os-release', 'utf8'); const m = t.match(/^PRETTY_NAME="?([^"\n]+)"?/m); if (m) return m[1]; } catch { /* ignore */ }
  }
  return `${os.type()} ${os.release()}`;
}

async function tailscaleIp() {
  const r = await run('tailscale', ['ip', '-4'], { timeoutMs: 2000 });
  return r.ok ? r.stdout.trim().split('\n')[0] : undefined;
}

async function detectFacts({ workerVersion, claudePath, authMode, workerEnabled }) {
  const facts = {
    os: osName(), arch: archName(), os_version: (await osVersion()).slice(0, 100), hostname: os.hostname().slice(0, 255),
    worker_version: workerVersion, claude_auth_mode: authMode, worker_enabled: !!workerEnabled,
  };
  const ip = await tailscaleIp();
  if (ip) facts.tailscale_ip = ip;
  try { facts.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* ignore */ }
  if (claudePath) {
    const r = await run(claudePath, ['--version'], { timeoutMs: 15000 });
    if (r.ok) facts.claude_version = r.stdout.trim().split('\n')[0].slice(0, 64);
  }
  return facts;
}

module.exports = { killTree, keepAwake, run, detectFacts, osVersion };
