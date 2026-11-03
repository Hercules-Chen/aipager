'use strict';
// Worker main loop: heartbeat (with sleep detection), claim, run, pending-result retry, crash recovery.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, readSecret, writeJson } = require('../common/config');
const { createLogger } = require('../common/log');
const { HubClient, sleep } = require('../common/client');
const { nodeDirs, osName } = require('../common/paths');
const platform = require('../common/platform');
const P = require('../../spec/reference/presence');
const { Profiles } = require('./profiles');
const { TaskRunner } = require('./runner');

const VERSION = require('../../package.json').version;

function loadWorkerConfig(file) {
  const cfg = readJson(file);
  const dirs = nodeDirs();
  cfg.worker = Object.assign({ enabled: true, max_concurrent: 1, heartbeat_sec: 15, claim_wait_sec: 25, lease_renew_sec: 20, progress_throttle_ms: 2000,
    tasks_dir: path.join(dirs.data, 'tasks'), upload_stream_log: true, mcp_tool_timeout_ms: 900000, keep_awake: false }, cfg.worker || {});
  cfg.log = Object.assign({ level: 'info', dir: dirs.logs, keep_days: 30 }, cfg.log || {});
  cfg.profiles_file = cfg.profiles_file || path.join(path.dirname(file), 'profiles.json');
  cfg.claude_auth = cfg.claude_auth || { mode: 'login' };
  return cfg;
}

class Worker {
  constructor(configPath, { log } = {}) {
    this.configPath = path.resolve(configPath);
    this.cfg = loadWorkerConfig(this.configPath);
    this.log = log || createLogger({ comp: 'worker', dir: this.cfg.log.dir, level: this.cfg.log.level, base: { node: this.cfg.node_id, os: osName() }, keepDays: this.cfg.log.keep_days });
    this.hub = new HubClient({ baseUrl: this.cfg.hub_url, token: readSecret(this.cfg.token_file), log: this.log, userAgent: 'aipager-worker/' + VERSION });
    this.profiles = new Profiles(this.cfg.profiles_file, this.log).load();
    this.running = new Map(); // task_id -> runner
    this.locks = new Set(); // concurrency keys in use
    this.metaVersion = 0;
    this.state = 'unknown';
    this.stopped = false;
    this.resumedSec = 0;
  }

  async start() {
    this.facts = await platform.detectFacts({ workerVersion: VERSION, claudePath: this.cfg.claude_path, authMode: this.cfg.claude_auth.mode, workerEnabled: this.cfg.worker.enabled });
    this.log.info('worker.start', 'worker starting', { config: this.configPath, hub_url: this.cfg.hub_url, facts: this.facts, profiles: this.profiles.names(), tasks_dir: this.cfg.worker.tasks_dir });
    fs.mkdirSync(this.cfg.worker.tasks_dir, { recursive: true });
    this.unwatch = this.profiles.watch();
    await this.recover();
    this.loops = [this.heartbeatLoop(), this.sleepWatch()];
    if (this.cfg.worker.enabled) this.loops.push(this.claimLoop());
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.unwatch) this.unwatch();
    for (const r of this.running.values()) await r.stop('cancel');
    this.log.info('worker.stop', 'worker stopped');
  }

  // ---------- heartbeat ----------
  async heartbeatOnce() {
    const body = { facts: this.facts, profiles: this.profiles.summary(), capacity: { max_concurrent: this.cfg.worker.max_concurrent, running: this.running.size }, meta_version: this.metaVersion };
    if (this.profiles.error) body.profiles_error = this.profiles.error;
    if (this.resumedSec) body.resumed_from_sleep_sec = this.resumedSec;
    const r = await this.hub.post('/nodes/heartbeat', body, { timeoutMs: 15000 });
    this.resumedSec = 0;
    if (r.data.meta) { this.meta = r.data.meta; this.metaVersion = r.data.meta_version; this.log.info('meta.update', 'metadata updated from hub', { meta_version: this.metaVersion, meta: this.meta }); }
    if (r.data.state !== this.state) { this.log.info('node.state', `node state ${r.data.state}`, { from: this.state }); this.state = r.data.state; }
    for (const id of r.data.cancel_requests || []) { const run = this.running.get(id); if (run) run.stop('cancel'); }
    this.retired = false;
    return r.data;
  }

  async heartbeatLoop() {
    let lastFacts = Date.now();
    while (!this.stopped) {
      try {
        if (Date.now() - lastFacts > 3600000) { this.facts = await platform.detectFacts({ workerVersion: VERSION, claudePath: this.cfg.claude_path, authMode: this.cfg.claude_auth.mode, workerEnabled: this.cfg.worker.enabled }); lastFacts = Date.now(); }
        await this.heartbeatOnce();
      } catch (e) {
        if (e.code === 'E_AUTH') {
          if (!this.retired) this.log.error('node.retired', '此節點已退役或 token 已撤銷；停止領任務，每 10 分鐘重試一次', { code: e.code });
          this.retired = true;
          await this.waitOrWake(600000);
          continue;
        }
        this.log.warn('heartbeat.failed', e.message, { code: e.code });
      }
      await this.waitOrWake(this.cfg.worker.heartbeat_sec * 1000);
    }
  }

  waitOrWake(ms) { return new Promise((r) => { this.wake = r; setTimeout(r, ms); }); }

  // Wall clock jumps => the machine slept. Report on the next heartbeat immediately (spec chapter 07).
  async sleepWatch() {
    let last = Date.now();
    while (!this.stopped) {
      await sleep(5000);
      const now = Date.now();
      const gap = P.detectSleepGap(last, now, 5000);
      last = now;
      if (gap) {
        this.resumedSec = Math.round(gap / 1000);
        this.log.info('worker.resumed_from_sleep', 'machine woke up', { slept_sec: this.resumedSec });
        if (this.wake) this.wake();
      }
    }
  }

  // ---------- claim ----------
  freeProfiles() {
    return this.profiles.names().filter((n) => { const p = this.profiles.get(n); return !p.concurrency_key || !this.locks.has(p.concurrency_key); });
  }

  async claimLoop() {
    while (!this.stopped) {
      if (this.retired || this.state === 'pending' || this.state === 'disabled' || this.state === 'draining' || this.running.size >= this.cfg.worker.max_concurrent || !this.freeProfiles().length) {
        await sleep(this.state === 'pending' ? 5000 : 1000);
        continue;
      }
      try {
        const r = await this.hub.post('/tasks/claim', { profiles: this.freeProfiles(), max: 1 }, { query: { wait: this.cfg.worker.claim_wait_sec }, timeoutMs: (this.cfg.worker.claim_wait_sec + 15) * 1000 });
        if (r.status === 204 || !r.data) continue;
        this.startTask(r.data);
      } catch (e) {
        this.log.warn('claim.failed', e.message, { code: e.code });
        await sleep(5000);
      }
    }
  }

  startTask(claim) {
    const runner = new TaskRunner(this, claim);
    const key = runner.profile && runner.profile.concurrency_key;
    if (key) this.locks.add(key);
    this.running.set(runner.id, runner);
    this.log.info('task.claimed', `claimed ${runner.id}`, { title: runner.p.title, profile: runner.p.profile, from: `${runner.env.from.agent}@${runner.env.from.node}` }, { task_id: runner.id });
    runner.run().finally(() => {
      this.running.delete(runner.id);
      if (key) this.locks.delete(key);
    });
    return runner;
  }

  // ---------- pending results & crash recovery ----------
  taskDirs(days = 7) {
    const root = this.cfg.worker.tasks_dir;
    const out = [];
    let dates = [];
    try { dates = fs.readdirSync(root).filter((d) => /^\d{8}$/.test(d)).sort().slice(-days); } catch { return out; }
    for (const d of dates) for (const t of fs.readdirSync(path.join(root, d))) out.push(path.join(root, d, t));
    return out;
  }

  async sendPending() {
    let left = 0;
    for (const dir of this.taskDirs()) {
      const f = path.join(dir, 'result.json');
      if (!fs.existsSync(f)) continue;
      const r = readJson(f);
      if (!r.pending) continue;
      const id = path.basename(dir);
      try {
        await this.hub.post(`/tasks/${id}/result`, r.result, { headers: { 'X-AIPager-Lease': r.lease_id }, timeoutMs: 30000 });
        writeJson(f, Object.assign(r, { pending: false }));
        this.log.info('result.resent', 'pending result delivered', {}, { task_id: id });
      } catch (e) {
        if (e.code === 'E_LEASE_LOST' || e.code === 'E_CONFLICT') { writeJson(f, Object.assign(r, { pending: false, lease_lost: true })); continue; }
        left++;
      }
    }
    return left;
  }

  schedulePendingRetry() {
    if (this.pendingTimer) return;
    let delay = 2000;
    const tick = async () => {
      const left = await this.sendPending();
      if (!left || this.stopped) { this.pendingTimer = null; return; }
      delay = Math.min(delay * 2, 300000);
      this.pendingTimer = setTimeout(tick, delay);
    };
    this.pendingTimer = setTimeout(tick, delay);
  }

  async recover() {
    for (const dir of this.taskDirs()) {
      const st = path.join(dir, 'state.json');
      if (!fs.existsSync(st) || fs.existsSync(path.join(dir, 'result.json'))) continue;
      const s = readJson(st);
      if (s.phase === 'done') continue;
      const res = { status: 'failed', summary: 'Worker 重新啟動時發現這個任務沒有完成（Worker 曾中斷）', error: { code: 'E_WORKER_CRASH', message: 'worker restarted during the task' }, metrics: { result_source: 'worker' } };
      writeJson(path.join(dir, 'result.json'), { pending: true, lease_id: s.lease_id, result: res });
      this.log.warn('task.crash_recovered', 'unfinished task reported as E_WORKER_CRASH', {}, { task_id: s.task_id });
    }
    const left = await this.sendPending().catch(() => 1);
    if (left) this.schedulePendingRetry();
  }
}

module.exports = { Worker, loadWorkerConfig };
