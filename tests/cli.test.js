'use strict';
// Operator flow through real processes: bin/hub.js, aipagerctl, start-worker.sh, aipager-hint (Linux / macOS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CTL = path.join(ROOT, 'bin', 'aipagerctl.js');
const STUB = path.join(__dirname, 'fixtures', 'stub-claude.js');

function ctl(args, env = {}, input) {
  const r = spawnSync(process.execPath, ['--no-warnings', CTL, ...args], { env: Object.assign({}, process.env, env), encoding: 'utf8', input, timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const t = setInterval(() => { const v = fn(); if (v) { clearInterval(t); resolve(v); } else if (Date.now() > end) { clearInterval(t); reject(new Error('waitFor timeout')); } }, 100);
  });
}

test('operator flow: admin init, enroll, join, approve, start-worker.sh, send --wait, doctor, hint, service unit', { skip: process.platform === 'win32', timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipager-cli-'));
  const procs = [];
  try {
    fs.chmodSync(STUB, 0o755);
    const port = 17300 + Math.floor(Math.random() * 1000);
    const hubUrl = `http://127.0.0.1:${port}`;
    const hubCfg = path.join(dir, 'hub.json');
    fs.writeFileSync(hubCfg, JSON.stringify({ data_dir: path.join(dir, 'hub'), listen: { host: '127.0.0.1', port }, public_base_url: hubUrl, log: { dir: path.join(dir, 'hub', 'logs') } }));
    const init = ctl(['admin', 'init', '--config', hubCfg]);
    assert.equal(init.code, 0, init.out);
    const adminToken = /(apa_[A-Za-z0-9_-]{43})/.exec(init.out)[1];
    const hub = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'bin', 'hub.js'), '--config', hubCfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(hub);
    let hubErr = '';
    hub.stderr.on('data', (d) => { hubErr += d; });
    await waitFor(() => /listening on/.test(hubErr));

    const admin = { AIPAGER_HOME: path.join(dir, 'admin'), AIPAGER_HUB_URL: hubUrl };
    assert.equal(ctl(['admin', 'save-token', adminToken], admin).code, 0);
    const en = ctl(['enroll', 'create', '--name', 'Build PC', '--power', 'desktop', '--role', 'builder', '--label', 'os=linux'], admin);
    assert.equal(en.code, 0, en.out);
    const code = /(ape_[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/.exec(en.out)[1];
    const build = { AIPAGER_HOME: path.join(dir, 'build') };
    const join = ctl(['join', '--hub', hubUrl, '--code', code, '--node-id', 'build-pc', '--claude-path', STUB], build);
    assert.equal(join.code, 0, join.out);
    assert.match(join.out, /狀態 pending（等待管理者核准）/);
    const cfgPath = path.join(dir, 'build', 'node', 'node.json');
    assert.equal(fs.statSync(path.join(dir, 'build', 'node', 'node.token')).mode & 0o777, 0o600);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.worker.heartbeat_sec = 1; cfg.worker.claim_wait_sec = 2; cfg.worker.lease_renew_sec = 2;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const ls1 = ctl(['nodes', '--json'], admin);
    assert.equal(JSON.parse(ls1.out)[0].state, 'pending');
    assert.equal(ctl(['nodes', 'approve', 'build-pc'], admin).code, 0);

    const worker = spawn('bash', [path.join(ROOT, 'spec/scripts/posix/start-worker.sh')], { env: Object.assign({}, process.env, build, { AIPAGER_CONFIG: cfgPath, AIPAGER_APP_DIR: ROOT, NODE_OPTIONS: '--no-warnings' }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    procs.push(worker);
    let wout = '';
    worker.stdout.on('data', (d) => { wout += d; });
    worker.stderr.on('data', (d) => { wout += d; });
    await waitFor(() => /\[worker\] config=/.test(wout));
    assert.match(wout, /node_id     = build-pc/);
    assert.match(wout, /claude      = 9\.9\.9/);

    const dev = { AIPAGER_HOME: path.join(dir, 'dev') };
    const en2 = ctl(['enroll', 'create', '--name', 'Dev', '--auto-approve'], admin);
    const code2 = /(ape_[A-Z2-7-]{19})/.exec(en2.out)[1];
    const j2 = ctl(['join', '--hub', hubUrl, '--code', code2, '--node-id', 'dev-pc', '--no-worker'], dev);
    assert.equal(j2.code, 0, j2.out);
    assert.match(j2.out, /狀態 active/);

    const send = ctl(['send', '--to', 'worker@build-pc', '--profile', 'echo', '--title', '冒煙', '--text', 'STUB:submit 執行 hostname', '--wait', '60'], dev);
    assert.equal(send.code, 0, send.out + '\n--- worker ---\n' + wout);
    assert.match(send.out, /結果：succeeded — 編譯成功，0 錯誤/);
    assert.match(send.out, /來源：submit_tool/);

    const doc = ctl(['doctor', '--encoding'], build);
    assert.equal(doc.code, 0, doc.out);
    assert.match(doc.out, /token valid; state=active presence=online/);
    assert.match(doc.out, /encoding: \d+ files UTF-8 without BOM, LF/);

    const hint = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'bin', 'aipager-hint.js')], { env: Object.assign({}, process.env, dev), input: JSON.stringify({ cwd: dir, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
    assert.equal(hint.status, 0);
    assert.match(hint.stdout, /^\[AIPager\] 1 則未讀：任務結果（succeeded）：編譯成功/);
    const hintInTask = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'aipager-hint.js')], { env: Object.assign({}, process.env, dev, { AIPAGER_TASK_ID: 'x' }), input: '{}', encoding: 'utf8' });
    assert.equal(hintInTask.stdout, '', 'hint is silent inside task sessions');

    assert.equal(ctl(['nodes', 'set', 'build-pc', '--label', 'gpu=yes', '--suspend-grace', '2h', '--notes', '辦公室'], admin).code, 0);
    const show = JSON.parse(ctl(['nodes', 'show', 'build-pc'], admin).out);
    assert.equal(show.meta.labels.gpu, 'yes');
    assert.equal(show.meta.presence.suspend_grace_sec, 7200);
    assert.equal(show.presence_settings.suspend_grace_sec, 7200);
    const stuck = ctl(['tasks', '--stuck'], admin);
    assert.match(stuck.out, /沒有卡住的任務/);

    if (process.platform === 'linux') {
      const fakeHome = path.join(dir, 'home');
      const svc = ctl(['service', 'install', '--dry-run', '--config', cfgPath], Object.assign({}, build, { HOME: fakeHome }));
      assert.equal(svc.code, 0, svc.out);
      const unit = path.join(fakeHome, '.config', 'systemd', 'user', 'aipager-worker.service');
      const text = fs.readFileSync(unit, 'utf8');
      assert.match(text, new RegExp(`ExecStart=/bin/bash ${ROOT.replace(/[/.]/g, '\\$&')}/spec/scripts/posix/start-worker.sh`));
      assert.match(text, new RegExp(`Environment=AIPAGER_CONFIG=${cfgPath.replace(/[/.]/g, '\\$&')}`));
      try { execFileSync('systemd-analyze', ['verify', unit], { stdio: 'pipe' }); } catch (e) { if (e.code !== 'ENOENT') assert.fail('systemd-analyze: ' + e.stderr); }
    }
  } finally {
    for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
