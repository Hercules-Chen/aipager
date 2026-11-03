'use strict';
// Runs one claimed task end to end (spec chapter 13). One instance per task.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { APP_ROOT, osName, archName } = require('../common/paths');
const { readSecret, writeJson } = require('../common/config');
const { compile } = require('../common/schemas');
const platform = require('../common/platform');
const glob = require('./glob');

const PROMPTS = path.join(APP_ROOT, 'spec/prompts');
const SHELL_HINT = { windows: 'Git Bash for the Bash tool; PowerShell available as powershell.exe', macos: 'zsh / bash', linux: 'bash' };
const STATE_FILE = 'state.json';
const AUTO_ALLOWED_MCP = ['submit_result', 'report_progress', 'list_nodes', 'describe_node', 'get_task', 'wait_task'].map((t) => 'mcp__aipager__' + t);

function render(tpl, vars) {
  return tpl.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
    return v === undefined || v === null || v === '' ? '(none)' : String(v);
  });
}

function ymd() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }

function shellRun(cmd, cwd, timeoutMs) {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    const c = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd], { cwd, windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out: out.slice(-4000) }); });
  });
}

class TaskError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}

class TaskRunner {
  constructor(worker, claim) {
    this.w = worker;
    this.claim = claim;
    this.env = claim.task;
    this.p = this.env.payload;
    this.id = this.env.id;
    this.leaseId = claim.lease.lease_id;
    this.profile = worker.profiles.get(this.p.profile);
    this.dir = path.join(worker.cfg.worker.tasks_dir, ymd(), this.id);
    this.log = worker.log.child({ task_id: this.id, thread_id: this.env.thread_id, trace_id: this.env.trace.trace_id });
    this.sleepMs = 0;
    this.child = null;
    this.stopReason = null; // 'cancel' | 'timeout' | 'lease_lost'
    this.sessionId = null;
    this.resultEvent = null;
    this.startedSent = false;
    this.pendingTool = null;
    this.lastProgress = 0;
  }

  file(name) { return path.join(this.dir, name); }
  saveState(extra) { writeJson(this.file(STATE_FILE), Object.assign({ task_id: this.id, lease_id: this.leaseId, pid: this.child ? this.child.pid : null, started_at: this.started, updated_at: new Date().toISOString() }, extra)); }

  async progress(body) {
    try { await this.w.hub.post(`/tasks/${this.id}/progress`, body, { timeoutMs: 10000 }); } catch (e) { this.log.warn('progress.failed', e.message, { phase: body.phase }); }
  }

  // ---------- preparation ----------
  async prepare() {
    fs.mkdirSync(this.dir, { recursive: true });
    writeJson(this.file('task.json'), this.env);
    if (!this.profile) throw new TaskError('E_PROFILE_UNKNOWN', `profile ${this.p.profile} is not defined on this node`);
    writeJson(this.file('profile.json'), this.profile);
    fs.writeFileSync(this.file('task.token'), this.claim.task_token + '\n', { mode: 0o600 });
    const wd = this.profile.workdir;
    const repo = this.p.inputs && this.p.inputs.repo;
    if (!repo) fs.mkdirSync(wd, { recursive: true });
    if (repo) await this.prepareRepo(wd, repo);
    if (this.p.inputs && this.p.inputs.files && this.p.inputs.files.length) await this.downloadInputs(wd);
  }

  async prepareRepo(wd, repo) {
    const allow = (this.profile.repo && this.profile.repo.allow_remote) || [];
    if (!allow.includes(repo.url)) throw new TaskError('E_REPO_NOT_ALLOWED', `repo ${repo.url} is not in allow_remote of profile ${this.p.profile}`);
    const git = (args, t = 300000) => platform.run('git', ['-C', wd, ...args], { timeoutMs: t });
    const origin = await git(['remote', 'get-url', 'origin'], 10000);
    if (!origin.ok) throw new TaskError('E_GIT_FAILED', `workdir ${wd} is not a git clone: ${origin.stderr.trim()}`);
    if (origin.stdout.trim() !== repo.url) throw new TaskError('E_REPO_NOT_ALLOWED', `workdir origin ${origin.stdout.trim()} != ${repo.url}`);
    const st = await git(['status', '--porcelain'], 30000);
    if (st.stdout.trim() && (!this.profile.repo || this.profile.repo.require_clean !== false)) throw new TaskError('E_WORKDIR_DIRTY', 'working tree has uncommitted changes', { status: st.stdout.slice(0, 2000) });
    for (const cmd of this.profile.pre_commands || []) {
      const r = await shellRun(cmd, wd, 600000);
      this.log.info('pre_command', cmd, { exit_code: r.code });
      if (r.code !== 0) throw new TaskError('E_PRE_COMMAND_FAILED', `${cmd} exited ${r.code}`, { output: r.out });
    }
    const f = await git(['fetch', 'origin', repo.ref]);
    if (!f.ok) throw new TaskError('E_GIT_FAILED', `git fetch origin ${repo.ref} failed`, { stderr: f.stderr.slice(-2000) });
    const co = await git(['checkout', '--detach', repo.commit || 'FETCH_HEAD'], 120000);
    if (!co.ok) throw new TaskError('E_GIT_FAILED', `git checkout ${repo.commit || 'FETCH_HEAD'} failed`, { stderr: co.stderr.slice(-2000) });
  }

  async downloadInputs(wd) {
    const target = path.join(wd, '.aipager', 'inputs', this.id);
    fs.mkdirSync(target, { recursive: true });
    this.localInputs = [];
    for (const f of this.p.inputs.files) {
      const res = await fetch(`${this.w.hub.baseUrl}/api/v1/blobs/${f.sha256}`, { headers: { Authorization: 'Bearer ' + this.w.hub.token } });
      if (!res.ok) throw new TaskError('E_GIT_FAILED', `cannot download attachment ${f.name} (${res.status})`);
      const p = path.join(target, path.basename(f.name));
      fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
      this.localInputs.push(p);
    }
  }

  // ---------- claude ----------
  buildArgs() {
    const pr = this.profile;
    const limits = this.p.limits || {};
    const maxTurns = Math.min(limits.max_turns || pr.max_turns || 40, pr.max_turns || 200);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns)];
    if (pr.model) args.push('--model', pr.model);
    args.push('--permission-mode', pr.permission_mode || 'default');
    // Claude Code asks permission for MCP tools too (verified with 2.1.317). Our own reporting and read-only tools are
    // always allowed; tools that affect other machines (send_task, send_message, cancel_task, attachments) still go
    // through permission_prompt unless the profile lists them in allowed_tools.
    const allowed = AUTO_ALLOWED_MCP.concat(pr.allowed_tools || []);
    args.push('--allowedTools', ...allowed);
    if ((pr.disallowed_tools || []).length) args.push('--disallowedTools', ...pr.disallowed_tools);
    args.push('--mcp-config', this.file('mcp.json'), '--strict-mcp-config');
    args.push('--permission-prompt-tool', 'mcp__aipager__permission_prompt');
    args.push('--setting-sources', pr.setting_sources !== undefined ? String(pr.setting_sources) : '');
    args.push('--append-system-prompt', this.systemAppend);
    if (this.claim.resume_session_id) args.push('--resume', this.claim.resume_session_id);
    return args;
  }

  writeClaudeFiles() {
    const cfg = this.w.cfg;
    const vars = {
      node_id: cfg.node_id, os: osName(), arch: archName(), shell_hint: SHELL_HINT[osName()], task_id: this.id, thread_id: this.env.thread_id,
      profile: this.p.profile, from: `${this.env.from.agent}@${this.env.from.node}`, workdir: this.profile.workdir, hop: this.env.trace.hop,
      attempt: this.claim.attempt || 1, title: this.p.title, instructions: this.p.instructions,
      inputs: Object.assign({}, this.p.inputs || {}, {
        files_local_paths: (this.localInputs || []).join(', '), vars_json: this.p.inputs && this.p.inputs.vars ? JSON.stringify(this.p.inputs.vars) : '',
      }),
      expected_output: Object.assign({ format: 'text' }, this.p.expected_output || {}, {
        schema_json: this.p.expected_output && this.p.expected_output.schema ? JSON.stringify(this.p.expected_output.schema) : '',
        artifacts: ((this.p.expected_output && this.p.expected_output.artifacts) || []).join(', '),
      }),
      limits: Object.assign({ timeout_sec: this.timeoutSec(), max_turns: (this.p.limits && this.p.limits.max_turns) || this.profile.max_turns || 40 }),
    };
    this.systemAppend = render(fs.readFileSync(path.join(PROMPTS, 'worker-system-append.txt'), 'utf8'), vars);
    this.prompt = render(fs.readFileSync(path.join(PROMPTS, 'worker-task-prompt.txt'), 'utf8'), vars);
    fs.writeFileSync(this.file('system-append.txt'), this.systemAppend);
    fs.writeFileSync(this.file('prompt.txt'), this.prompt);
    const mcp = { mcpServers: { aipager: { type: 'stdio', command: process.execPath, args: [path.join(APP_ROOT, 'bin/aipager-mcp.js'), '--mode', 'task'],
      env: { AIPAGER_CONFIG: this.w.configPath, AIPAGER_TASK_ID: this.id, AIPAGER_TASK_TOKEN_FILE: this.file('task.token'),
        AIPAGER_TASK_DIR: this.dir, AIPAGER_PROFILE_FILE: this.file('profile.json'), AIPAGER_HUB_URL: this.w.hub.baseUrl } } } };
    writeJson(this.file('mcp.json'), mcp);
  }

  timeoutSec() {
    const want = (this.p.limits && this.p.limits.timeout_sec) || this.profile.timeout_sec || 1800;
    return Math.min(want, this.profile.timeout_sec || want);
  }

  childEnv() {
    const env = Object.assign({}, process.env, this.profile.env || {}, {
      AIPAGER_TASK_ID: this.id, MCP_TOOL_TIMEOUT: String(this.w.cfg.worker.mcp_tool_timeout_ms || 900000),
    });
    const auth = this.w.cfg.claude_auth || { mode: 'login' };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    if (auth.mode === 'oauth_token') env.CLAUDE_CODE_OAUTH_TOKEN = readSecret(auth.token_file);
    if (auth.mode === 'api_key') env.ANTHROPIC_API_KEY = readSecret(auth.token_file);
    return env;
  }

  async runClaude() {
    const claudePath = this.w.cfg.claude_path;
    if (/\.(cmd|bat)$/i.test(claudePath)) throw new TaskError('E_CLAUDE_NOT_FOUND', 'claude_path must point to claude.exe, not a .cmd/.bat shim');
    if (!fs.existsSync(claudePath)) throw new TaskError('E_CLAUDE_NOT_FOUND', `claude_path not found: ${claudePath}`);
    const args = this.buildArgs();
    fs.writeFileSync(this.file('cmdline.txt'), [claudePath, ...args.map((a) => (a === this.systemAppend ? '<system-append.txt>' : a))]
      .map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ') + '\n  cwd=' + this.profile.workdir + '\n  stdin=prompt.txt\n');
    const stream = fs.createWriteStream(this.file('stream.jsonl'));
    const stderr = fs.createWriteStream(this.file('stderr.log'));
    this.started = new Date().toISOString();
    this.startMs = Date.now();
    const child = spawn(claudePath, args, { cwd: this.profile.workdir, env: this.childEnv(), detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.saveState({ phase: 'running' });
    this.log.info('claude.spawn', 'started claude -p', { pid: child.pid, profile: this.p.profile, cwd: this.profile.workdir });
    const awake = this.w.cfg.worker.keep_awake ? platform.keepAwake(child.pid) : null;
    child.stdin.end(this.prompt);
    let buf = '';
    child.stdout.on('data', (d) => {
      stream.write(d);
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) this.onLine(line); }
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderr.write(d); stderrTail = (stderrTail + d.toString('utf8')).slice(-8000); });
    const timers = this.startTimers();
    const exit = await new Promise((resolve) => {
      child.on('error', (e) => resolve({ code: -1, error: e }));
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    if (buf.trim()) this.onLine(buf);
    timers();
    if (awake) { try { awake.kill(); } catch { /* gone */ } }
    await new Promise((r) => stream.end(r));
    await new Promise((r) => stderr.end(r));
    this.exit = exit;
    this.stderrTail = stderrTail;
    this.log.info('claude.exit', 'claude exited', { code: exit.code, signal: exit.signal || null, stop_reason: this.stopReason });
    if (exit.error && exit.error.code === 'ENOENT') throw new TaskError('E_CLAUDE_NOT_FOUND', exit.error.message);
  }

  onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { this.log.warn('stream.unparsed', 'unparsed line kept in stream.jsonl', { line: line.slice(0, 200) }); return; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.sessionId = ev.session_id;
      if (ev.mcp_servers && !ev.mcp_servers.some((s) => s.name === 'aipager' && s.status === 'connected')) this.log.warn('mcp.not_connected', 'aipager MCP not connected in task session', { mcp_servers: ev.mcp_servers });
      if (!this.startedSent) { this.startedSent = true; this.progress({ phase: 'started', message: `claude 已啟動（${ev.model || ''}）`, claude_session_id: ev.session_id }); }
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type !== 'tool_use') continue;
        const inp = c.input || {};
        const summary = String(inp.command || inp.file_path || inp.pattern || inp.description || JSON.stringify(inp)).slice(0, 300);
        this.pendingTool = { phase: 'tool', message: `${c.name}: ${summary}`.slice(0, 500), tool: { name: String(c.name).slice(0, 100), summary } };
        this.flushTool(false);
      }
    } else if (ev.type === 'result') {
      this.resultEvent = ev;
    }
    // other types (active_goal, autocompact_state, rate_limit_event, system/post_turn_summary, ...) are ignored on purpose (D24)
  }

  flushTool(force) {
    if (!this.pendingTool) return;
    const throttle = this.w.cfg.worker.progress_throttle_ms || 2000;
    if (!force && Date.now() - this.lastProgress < throttle) return;
    const body = this.pendingTool;
    this.pendingTool = null;
    this.lastProgress = Date.now();
    this.progress(body);
  }

  startTimers() {
    const renewMs = (this.w.cfg.worker.lease_renew_sec || 20) * 1000;
    const timeoutMs = this.timeoutSec() * 1000;
    let lastTick = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick - 1000;
      if (gap > 30000) { this.sleepMs += gap; this.log.info('task.sleep_gap', 'machine slept during task', { slept_ms: gap }); }
      lastTick = now;
      this.flushTool(false);
      if (!this.stopReason && now - this.startMs - this.sleepMs > timeoutMs) this.stop('timeout');
    }, 1000);
    const renew = setInterval(async () => {
      try {
        const r = await this.w.hub.post(`/tasks/${this.id}/lease`, { lease_id: this.leaseId }, { timeoutMs: 15000 });
        if (r.data.cancel_requested) this.stop('cancel');
      } catch (e) {
        if (e.code === 'E_LEASE_LOST' || e.code === 'E_CONFLICT') this.stop('lease_lost');
        else this.log.warn('lease.renew_failed', e.message);
      }
    }, renewMs);
    return () => { clearInterval(tick); clearInterval(renew); this.flushTool(true); };
  }

  async stop(reason) {
    if (this.stopReason || !this.child) return;
    this.stopReason = reason;
    this.log.warn('task.stop', `stopping claude: ${reason}`, { pid: this.child.pid });
    const sig = await platform.killTree(this.child, { graceMs: 10000 });
    this.log.info('task.killed', 'process tree stopped', { method: sig });
  }

  // ---------- result ----------
  async buildResult() {
    const awakeMs = Math.max(0, Date.now() - this.startMs - this.sleepMs);
    const r = this.resultEvent || {};
    const metrics = { duration_ms: awakeMs, exit_code: this.exit ? (this.exit.code ?? -1) : -1 };
    if (r.num_turns !== undefined) metrics.num_turns = r.num_turns;
    if (typeof r.total_cost_usd === 'number') metrics.cost_usd = r.total_cost_usd;
    if (this.sessionId || r.session_id) metrics.claude_session_id = this.sessionId || r.session_id;
    let res;
    const subFile = this.file('submitted.json');
    if (this.stopReason === 'cancel') {
      res = { status: 'cancelled', summary: '已依要求取消並終止程序', error: { code: 'E_CANCELLED', message: 'cancelled by request' } };
      metrics.result_source = 'worker';
    } else if (this.stopReason === 'timeout') {
      res = { status: 'failed', summary: `超過逾時 ${this.timeoutSec()} 秒（只計醒著的時間），已終止程序`, error: { code: 'E_TIMEOUT', message: 'timeout' } };
      metrics.result_source = 'worker';
    } else if (fs.existsSync(subFile)) {
      const s = JSON.parse(fs.readFileSync(subFile, 'utf8'));
      res = { status: s.status === 'failed' ? 'failed' : 'succeeded', summary: String(s.summary || '').slice(0, 4000) || '(no summary)' };
      if (s.output !== undefined) res.output = s.output;
      if (s.status === 'failed') res.error = { code: s.error_code || 'E_TASK_FAILED', message: String(s.summary || '').slice(0, 2000) };
      metrics.result_source = 'submit_tool';
    } else if (r.subtype === 'success' && !r.is_error) {
      res = { status: 'succeeded', summary: String(r.result || '').slice(0, 4000) || '(empty)' };
      metrics.result_source = 'final_text';
    } else {
      const auth = /log ?in|authenticat|credential|unauthori[sz]ed|\b401\b|oauth/i.test(this.stderrTail || '') || /authenticat|log ?in/i.test(String(r.result || ''));
      const code = r.subtype === 'error_max_turns' ? 'E_MAX_TURNS' : auth ? 'E_CLAUDE_AUTH' : 'E_CLAUDE_EXIT';
      res = { status: 'failed', summary: `claude 未正常完成（${r.subtype || 'exit ' + metrics.exit_code}）`, error: { code, message: String(r.result || 'claude exited without result').slice(0, 2000), detail: { stderr_tail: (this.stderrTail || '').split('\n').slice(-50).join('\n') } } };
      metrics.result_source = 'worker';
    }
    const eo = this.p.expected_output;
    if (res.status === 'succeeded' && eo && eo.format === 'json') {
      const ok = res.output !== undefined && (!eo.schema || compile(eo.schema)(res.output));
      if (!ok) res = Object.assign(res, { status: 'failed', error: { code: 'E_OUTPUT_SCHEMA', message: 'output does not match expected_output.schema' } });
    }
    res.metrics = metrics;
    res.artifacts = await this.collectArtifacts();
    return res;
  }

  async upload(name, buf, mime) {
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    await this.w.hub.request('PUT', '/blobs/' + sha, { raw: buf, headers: mime ? { 'X-AIPager-Mime': mime } : {}, timeoutMs: 120000 });
    return { name, sha256: sha, size: buf.length, mime: mime || 'application/octet-stream', blob_url: '/api/v1/blobs/' + sha };
  }

  async collectArtifacts() {
    const out = [];
    const maxBytes = (this.profile && this.profile.artifacts_max_mb ? this.profile.artifacts_max_mb : 50) * 1024 * 1024;
    let total = 0;
    try {
      const pats = (this.p.expected_output && this.p.expected_output.artifacts) || [];
      if (pats.length && this.profile) {
        for (const rel of glob.match(this.profile.workdir, pats)) {
          const buf = fs.readFileSync(path.join(this.profile.workdir, rel));
          if (total + buf.length > maxBytes) { this.log.warn('artifacts.limit', 'artifact size limit reached', { skipped: rel }); break; }
          total += buf.length;
          out.push(await this.upload(rel.slice(0, 255), buf));
        }
      }
      if (this.w.cfg.worker.upload_stream_log !== false && fs.existsSync(this.file('stream.jsonl'))) {
        const gz = zlib.gzipSync(fs.readFileSync(this.file('stream.jsonl')));
        if (gz.length < 50 * 1024 * 1024) out.push(await this.upload('_stream.jsonl.gz', gz, 'application/gzip'));
      }
    } catch (e) { this.log.warn('artifacts.failed', e.message); }
    return out.slice(0, 50);
  }

  async postResult(res) {
    writeJson(this.file('result.json'), { pending: true, lease_id: this.leaseId, result: res });
    if (this.stopReason === 'lease_lost') { this.log.warn('result.kept_local', 'lease lost: result kept locally, not sent'); writeJson(this.file('result.json'), { pending: false, lease_lost: true, result: res }); return; }
    try {
      await this.w.hub.post(`/tasks/${this.id}/result`, res, { headers: { 'X-AIPager-Lease': this.leaseId }, timeoutMs: 30000 });
      writeJson(this.file('result.json'), { pending: false, lease_id: this.leaseId, result: res });
      this.log.info('result.sent', `result ${res.status}`, { result_source: res.metrics.result_source, error: res.error ? res.error.code : null });
    } catch (e) {
      if (e.code === 'E_LEASE_LOST' || e.code === 'E_CONFLICT') {
        writeJson(this.file('result.json'), { pending: false, lease_lost: true, result: res });
        this.log.warn('result.rejected', 'hub rejected result (lease lost); kept locally', { code: e.code });
      } else {
        this.log.warn('result.pending', 'hub unreachable; result kept as pending and will be retried', { error: e.message });
        this.w.schedulePendingRetry();
      }
    }
  }

  async run() {
    let res;
    try {
      await this.prepare();
      this.writeClaudeFiles();
      await this.runClaude();
      res = await this.buildResult();
    } catch (e) {
      const code = e instanceof TaskError ? e.code : 'E_WORKER_CRASH';
      this.log.error('task.error', e.message, { code, stack: e instanceof TaskError ? undefined : e.stack });
      res = { status: 'failed', summary: `Worker 無法執行：${e.message}`.slice(0, 4000), error: { code, message: String(e.message).slice(0, 2000) }, metrics: { result_source: 'worker' } };
      if (e.detail) res.error.detail = e.detail;
      if (this.stopReason === 'cancel') res = { status: 'cancelled', summary: '已取消', error: { code: 'E_CANCELLED', message: 'cancelled' }, metrics: { result_source: 'worker' } };
    }
    await this.postResult(res);
    try { fs.rmSync(this.file('task.token'), { force: true }); } catch { /* ignore */ }
    this.saveState({ phase: 'done', status: res.status });
    return res;
  }
}

module.exports = { TaskRunner, render, AUTO_ALLOWED_MCP };
