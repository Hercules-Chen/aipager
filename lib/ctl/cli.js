'use strict';
// aipagerctl: command-line tool for people and scripts (spec chapter 19 "aipagerctl 指令").
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { HubClient, parseAddress } = require('../common/client');
const { readJson, readSecret, writeJson, writeSecret } = require('../common/config');
const { defaultNodeConfigPath, nodeDirs, osName, archName, APP_ROOT } = require('../common/paths');
const M = require('../common/messages');
const platform = require('../common/platform');
const service = require('./service');

const VERSION = require('../../package.json').version;

// ---------- argument parsing ----------
function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      const val = inline !== undefined ? inline : next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      if (opt[k] === undefined) opt[k] = val; else opt[k] = [].concat(opt[k], val);
    } else pos.push(a);
  }
  return { pos, opt };
}
const list = (v) => (v === undefined ? [] : [].concat(v));
const seconds = (v) => {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(String(v));
  if (!m) throw new Error('bad duration: ' + v);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
};
const kv = (items) => Object.fromEntries(list(items).map((s) => { const i = String(s).indexOf('='); if (i < 1) throw new Error('expected key=value: ' + s); return [s.slice(0, i), s.slice(i + 1)]; }));

class Ctl {
  constructor(opt, out = console.log, err = console.error) {
    this.opt = opt;
    this.out = out;
    this.err = err;
    this.configPath = opt.config && typeof opt.config === 'string' ? path.resolve(opt.config) : defaultNodeConfigPath();
    this.cfg = fs.existsSync(this.configPath) && !opt['hub-config'] ? (() => { try { return readJson(this.configPath); } catch { return {}; } })() : {};
    this.hubUrl = opt.hub || process.env.AIPAGER_HUB_URL || this.cfg.hub_url;
  }

  node() {
    if (!this.hubUrl || !this.cfg.token_file) throw new Error(`找不到節點設定（${this.configPath}）。請先執行 aipagerctl join，或用 --config 指定 node.json`);
    return new HubClient({ baseUrl: this.hubUrl, token: readSecret(this.cfg.token_file), agent: this.opt.agent || (this.cfg.mcp && this.cfg.mcp.default_agent) || 'main', userAgent: 'aipagerctl/' + VERSION });
  }

  adminTokenFile() { return path.join(path.dirname(this.configPath), 'admin.token'); }

  admin() {
    let token = this.opt['admin-token'] || process.env.AIPAGER_ADMIN_TOKEN;
    if (!token && fs.existsSync(this.adminTokenFile())) token = readSecret(this.adminTokenFile());
    if (!token) throw new Error(`需要 admin token：用 --admin-token、環境變數 AIPAGER_ADMIN_TOKEN，或先執行 aipagerctl admin save-token <token>（存到 ${this.adminTokenFile()}）`);
    if (!this.hubUrl) throw new Error('需要 Hub 位址：--hub http://aipager-hub:7300 或 AIPAGER_HUB_URL');
    return new HubClient({ baseUrl: this.hubUrl, token, userAgent: 'aipagerctl/' + VERSION });
  }

  // node token when available, otherwise admin
  any() { try { return this.node(); } catch { return this.admin(); } }

  json(x) { this.out(JSON.stringify(x, null, 2)); }

  // ---------- doctor ----------
  async doctor() {
    let failed = 0;
    const ok = (m) => this.out('[OK]   ' + m);
    const bad = (m) => { failed++; this.out('[FAIL] ' + m); };
    const info = (m) => this.out('[INFO] ' + m);
    info(`aipagerctl ${VERSION}  node ${process.version}  os ${osName()}/${archName()}  user ${os.userInfo().username}`);
    info(`config = ${this.configPath}`);
    if (!fs.existsSync(this.configPath)) { bad('node.json 不存在；請先執行 aipagerctl join'); return failed; }
    const c = this.cfg;
    info(`node_id = ${c.node_id}   hub_url = ${c.hub_url}   claude_auth = ${(c.claude_auth || {}).mode || 'login'}`);
    try { require('node:sqlite'); ok('node:sqlite available'); } catch { bad('node:sqlite 無法載入（需要 Node 22.13 以上）'); }
    if (c.claude_path) {
      const r = await platform.run(c.claude_path, ['--version'], { timeoutMs: 20000 });
      if (r.ok) ok(`claude = ${r.stdout.trim().split('\n')[0]}  (${c.claude_path})`); else bad(`claude 無法執行：${c.claude_path} ${r.stderr.trim()}`);
      if (/\.(cmd|bat)$/i.test(c.claude_path)) bad('claude_path 必須是 claude.exe，不能是 .cmd');
    } else if (c.worker && c.worker.enabled) bad('claude_path 未設定');
    try {
      const h = await new HubClient({ baseUrl: c.hub_url }).get('/health', { timeoutMs: 5000 });
      ok(`hub reachable, version ${h.data.version}`);
      const skew = Math.round((Date.now() - Date.parse(h.data.time)) / 1000);
      if (Math.abs(skew) > 30) bad(`時鐘差 ${skew} 秒（超過 30 秒，請校時）`); else ok(`clock skew ${skew}s`);
    } catch (e) { bad(`hub 連不上：${e.message}（檢查 Tailscale 與 Hub 服務）`); }
    try {
      const me = await this.node().get('/nodes/self', { timeoutMs: 5000 });
      ok(`token valid; state=${me.data.state} presence=${me.data.presence} meta_version=${me.data.meta_version}`);
      if (me.data.state === 'pending') info('節點等待核准：請管理者在 Dashboard 或用 aipagerctl nodes approve 核准');
    } catch (e) { bad(`token 無效或節點不存在：${e.code} ${e.message}`); }
    const dirs = [c.worker && c.worker.tasks_dir, c.log && c.log.dir].filter(Boolean);
    for (const d of dirs) {
      try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.doctor'), 'ok'); fs.rmSync(path.join(d, '.doctor')); ok(`writable ${d}`); } catch (e) { bad(`無法寫入 ${d}：${e.message}`); }
    }
    const pf = c.profiles_file || path.join(path.dirname(this.configPath), 'profiles.json');
    if (fs.existsSync(pf)) {
      const { validateProfiles } = require('../worker/profiles');
      try { const e = validateProfiles(readJson(pf)); if (e.length) bad('profiles.json: ' + e.join('; ')); else ok(`profiles.json valid (${Object.keys(readJson(pf).profiles).join(', ')})`); } catch (e) { bad('profiles.json 無法解析：' + e.message); }
    } else if (c.worker && c.worker.enabled) bad(`profiles.json 不存在：${pf}`);
    if (this.opt.encoding) failed += this.encodingAudit(dirs.concat(path.dirname(this.configPath)), ok, bad);
    this.out(failed ? `\n${failed} 項失敗` : '\n全部通過');
    return failed;
  }

  encodingAudit(dirs, ok, bad) {
    let n = 0;
    let checked = 0;
    const dec = new TextDecoder('utf-8', { fatal: true });
    const walk = (d, depth = 0) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (/\.(json|jsonl|txt|log)$/.test(e.name)) {
          checked++;
          const b = fs.readFileSync(p);
          if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { n++; bad(`BOM: ${p}`); continue; }
          try { const t = dec.decode(b); if (t.includes('\r\n')) { n++; bad(`CRLF: ${p}`); } } catch { n++; bad(`invalid UTF-8: ${p}`); }
        }
      }
    };
    for (const d of dirs) walk(d);
    if (!n) ok(`encoding: ${checked} files UTF-8 without BOM, LF`);
    return n;
  }

  // ---------- join ----------
  async join() {
    const hub = this.opt.hub;
    const code = this.opt.code;
    if (!hub || !code) throw new Error('用法：aipagerctl join --hub http://aipager-hub:7300 --code ape_XXXX-XXXX-XXXX-XXXX [--node-id id] [--no-worker] [--power laptop] [--label k=v]');
    const nodeId = this.opt['node-id'] || os.hostname().toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 32);
    const dirs = this.opt['aipager-home'] ? nodeDirs(Object.assign({}, process.env, { AIPAGER_HOME: this.opt['aipager-home'] })) : nodeDirs();
    const cfgPath = this.opt.config && typeof this.opt.config === 'string' ? path.resolve(this.opt.config) : path.join(dirs.config, 'node.json');
    if (fs.existsSync(cfgPath) && !this.opt.force) throw new Error(`${cfgPath} 已存在；重灌請加 --force（舊 token 會在新加入碼使用後失效）`);
    const claudePath = this.opt['claude-path'] || await findClaude();
    const worker = !this.opt['no-worker'];
    const facts = await platform.detectFacts({ workerVersion: VERSION, claudePath, authMode: this.opt['claude-auth'] || 'login', workerEnabled: worker });
    this.out(`偵測到：${facts.os}/${facts.arch} ${facts.os_version}  claude=${facts.claude_version || '找不到'}  node_id=${nodeId}`);
    if (worker && !facts.claude_version) throw new Error('找不到可執行的 claude；請先安裝 Claude Code 並登入，或用 --claude-path 指定');
    const suggested = {};
    if (this.opt.power) suggested.power = this.opt.power;
    if (this.opt.label) suggested.labels = kv(this.opt.label);
    if (this.opt.name) suggested.display_name = this.opt.name;
    const body = { code, node_id: nodeId, facts };
    if (Object.keys(suggested).length) body.suggested = suggested;
    const r = (await new HubClient({ baseUrl: hub, userAgent: 'aipagerctl/' + VERSION }).post('/enroll', body)).data;
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    const tokenFile = path.join(path.dirname(cfgPath), 'node.token');
    writeSecret(tokenFile, r.node_token);
    await restrictWindowsAcl(tokenFile);
    const cfg = {
      node_id: nodeId, hub_url: hub, token_file: tokenFile, claude_path: claudePath || '', claude_auth: { mode: this.opt['claude-auth'] || 'login' },
      worker: { enabled: worker, max_concurrent: 1, heartbeat_sec: 15, claim_wait_sec: 25, lease_renew_sec: 20, progress_throttle_ms: 2000,
        tasks_dir: path.join(dirs.data, 'tasks'), upload_stream_log: true, mcp_tool_timeout_ms: 900000, keep_awake: osName() === 'macos' },
      mcp: { default_agent: 'main' }, log: { level: 'info', dir: dirs.logs, keep_days: 30 },
    };
    if (cfg.claude_auth.mode !== 'login') cfg.claude_auth.token_file = path.join(path.dirname(cfgPath), cfg.claude_auth.mode === 'oauth_token' ? 'claude-oauth.token' : 'anthropic-api.key');
    writeJson(cfgPath, cfg);
    const pf = path.join(path.dirname(cfgPath), 'profiles.json');
    if (!fs.existsSync(pf)) writeJson(pf, { profiles: { echo: echoProfile(dirs) } });
    this.out(`已加入：${nodeId}，狀態 ${r.state}${r.state === 'pending' ? '（等待管理者核准）' : ''}`);
    this.out(`設定：${cfgPath}\ntoken：${tokenFile}\nprofiles：${pf}`);
    if (cfg.claude_auth.token_file) this.out(`請把 ${cfg.claude_auth.mode === 'oauth_token' ? 'claude setup-token 產生的 token' : 'API key'} 存到 ${cfg.claude_auth.token_file}（權限 600）`);
    this.out(worker ? '下一步：aipagerctl service install' : '下一步：依文件註冊 MCP 與 hooks（claude mcp add ...）');
    return r;
  }

  // ---------- nodes ----------
  async nodes(sub, id) {
    if (!sub || sub === 'list') {
      const q = {};
      for (const k of ['presence', 'role', 'state', 'label', 'os']) if (this.opt[k]) q[k] = this.opt[k];
      if (this.opt.all) q.include_retired = 1;
      const r = (await this.any().get('/nodes', { query: q })).data.items;
      if (this.opt.json) return this.json(r);
      for (const n of r) {
        const f = n.facts || {};
        this.out(`${n.node_id.padEnd(16)} ${n.state.padEnd(9)} ${n.presence.padEnd(8)} ${n.presence === 'online' ? ''.padEnd(14) : ('沉默 ' + M.duration(n.silent_sec)).padEnd(14)} ${(f.os || '?') + '/' + (f.arch || '?')}  ${n.meta.display_name}  roles=${n.meta.roles.join(',') || '-'}  labels=${Object.entries(n.meta.labels).map(([k, v]) => k + '=' + v).join(',') || '-'}  profiles=${n.profiles.map((p) => p.name).join(',') || '-'}`);
      }
      if (!r.length) this.out('(沒有節點)');
      return r;
    }
    if (!id) throw new Error(`用法：aipagerctl nodes ${sub} <node_id>`);
    const a = sub === 'show' ? this.any() : this.admin();
    if (sub === 'show') return this.json((await a.get('/nodes/' + id)).data);
    if (sub === 'history') return this.json((await a.get(`/nodes/${id}/history`)).data);
    if (sub === 'rollback') return this.json((await a.post(`/nodes/${id}/meta/rollback`, { to_version: Number(this.opt.to) })).data);
    const states = { approve: 'active', enable: 'active', drain: 'draining', disable: 'disabled', retire: 'retired' };
    if (states[sub]) {
      const body = { state: states[sub] };
      if (this.opt.reason) body.reason = String(this.opt.reason);
      const v = (await a.post(`/nodes/${id}/state`, body)).data;
      this.out(`${id}: ${v.state}`);
      return v;
    }
    if (sub === 'set') {
      const cur = (await a.get('/nodes/' + id)).data;
      const patch = {};
      if (this.opt.name) patch.display_name = String(this.opt.name);
      if (this.opt.description !== undefined) patch.description = this.opt.description === true ? null : String(this.opt.description);
      if (this.opt.notes !== undefined) patch.notes = this.opt.notes === true ? null : String(this.opt.notes);
      if (this.opt.owner !== undefined) patch.owner = this.opt.owner === true ? null : String(this.opt.owner);
      if (this.opt.power) patch.power = this.opt.power;
      if (this.opt.label || this.opt.unlabel) {
        patch.labels = kv(this.opt.label);
        for (const k of list(this.opt.unlabel)) patch.labels[k] = null;
      }
      if (this.opt['add-role'] || this.opt['remove-role']) {
        const roles = new Set(cur.meta.roles);
        for (const r of list(this.opt['add-role'])) roles.add(r);
        for (const r of list(this.opt['remove-role'])) roles.delete(r);
        patch.roles = [...roles];
      }
      const pres = {};
      if (this.opt['asleep-after']) pres.asleep_after_sec = seconds(this.opt['asleep-after']);
      if (this.opt['offline-after']) pres.offline_after_sec = seconds(this.opt['offline-after']);
      if (this.opt['suspend-grace']) pres.suspend_grace_sec = seconds(this.opt['suspend-grace']);
      if (this.opt['alert-on-offline'] !== undefined) pres.alert_on_offline = this.opt['alert-on-offline'] !== 'false';
      if (Object.keys(pres).length) patch.presence = Object.assign({}, cur.meta.presence || {}, pres);
      if (!Object.keys(patch).length) throw new Error('沒有要修改的欄位');
      const v = (await a.patch(`/nodes/${id}/meta`, patch, { headers: { 'If-Match': String(cur.meta_version) } })).data;
      this.out(`${id}: meta_version ${cur.meta_version} → ${v.meta_version}`);
      return v;
    }
    throw new Error('未知的 nodes 子指令：' + sub);
  }

  // ---------- enroll ----------
  async enroll(sub, id) {
    const a = this.admin();
    if (sub === 'create') {
      const preset = {};
      if (this.opt.name) preset.display_name = String(this.opt.name);
      if (this.opt.power) preset.power = this.opt.power;
      if (this.opt.role) preset.roles = list(this.opt.role);
      if (this.opt.label) preset.labels = kv(this.opt.label);
      const body = { preset, ttl_sec: this.opt.ttl ? seconds(this.opt.ttl) : 86400, auto_approve: !!this.opt['auto-approve'] };
      if (this.opt['node-id']) body.node_id = this.opt['node-id'];
      const r = (await a.post('/admin/enrollments', body)).data;
      this.out(`加入碼（只顯示這一次）：${r.code}\n有效到：${r.expires_at}\n在新機器執行：\n  ${r.join_commands.linux}`);
      return r;
    }
    if (sub === 'list') { const r = (await a.get('/admin/enrollments')).data.items; for (const e of r) this.out(`${e.enrollment_id}  ${e.status.padEnd(8)} ${e.bound_node_id || '-'}  ${e.preset.display_name || ''}  expires ${e.expires_at}${e.used_by_node ? '  used by ' + e.used_by_node : ''}`); return r; }
    if (sub === 'revoke') { await a.del('/admin/enrollments/' + id); this.out('已撤銷 ' + id); return true; }
    throw new Error('用法：aipagerctl enroll create|list|revoke');
  }

  // ---------- tasks ----------
  async send() {
    if (!this.opt.to || !this.opt.profile || !(this.opt.text || this.opt['text-file'])) throw new Error('用法：aipagerctl send --to worker@build-pc --profile echo --title "..." --text "..." [--wait 120]');
    const c = this.node();
    const payload = { title: String(this.opt.title || String(this.opt.text).slice(0, 60)), profile: this.opt.profile, instructions: this.opt['text-file'] ? fs.readFileSync(this.opt['text-file'], 'utf8') : String(this.opt.text) };
    if (this.opt['repo-url']) payload.inputs = { repo: { url: this.opt['repo-url'], ref: this.opt.ref || 'main', ...(this.opt.commit ? { commit: this.opt.commit } : {}) } };
    const req = {};
    if (this.opt['requires-os']) req.os = list(this.opt['requires-os']);
    if (this.opt['requires-arch']) req.arch = list(this.opt['requires-arch']);
    if (this.opt['requires-label']) req.labels = kv(this.opt['requires-label']);
    if (Object.keys(req).length) payload.requires = req;
    if (this.opt.timeout) payload.limits = { timeout_sec: seconds(this.opt.timeout) };
    payload.dispatch = { on_unavailable: this.opt['on-unavailable'] || 'confirm' };
    if (this.opt['max-wait']) payload.dispatch.max_wait_sec = seconds(this.opt['max-wait']);
    const body = { to: parseAddress(this.opt.to), payload };
    if (this.opt['idempotency-key']) body.idempotency_key = String(this.opt['idempotency-key']);
    let created;
    try {
      created = (await c.post('/tasks', body)).data;
    } catch (e) {
      if (e.code !== 'E_TARGET_UNAVAILABLE') throw e;
      this.out('⚠ ' + e.body.warnings.map((w) => w.message).join(' '));
      for (const [i, alt] of (e.body.alternatives || []).entries()) this.out(`  可改派 ${i + 1}: ${alt.node_id}（${alt.display_name}，${alt.presence}）`);
      const choice = this.opt.yes ? 'q' : await ask('要怎麼做？ [q]排隊等它 / [數字]改派 / [c]取消：');
      if (/^\d+$/.test(choice) && e.body.alternatives[Number(choice) - 1]) body.to = { node: e.body.alternatives[Number(choice) - 1].node_id, agent: 'worker' };
      else if (choice !== 'q') { this.out('已取消，沒有建立任務'); return null; }
      body.payload.dispatch.on_unavailable = 'queue';
      created = (await c.post('/tasks', body)).data;
    }
    this.out(`已建立任務 ${created.task_id}（thread ${created.thread_id}）`);
    for (const w of created.warnings || []) this.out('⚠ ' + w.message);
    if (this.opt.wait) return this.wait(created.task_id, seconds(this.opt.wait));
    return created;
  }

  async wait(id, totalSec = 120) {
    const c = this.any();
    const end = Date.now() + totalSec * 1000;
    let t;
    do {
      t = (await c.get(`/tasks/${id}/wait`, { query: { timeout: Math.min(45, Math.max(1, Math.round((end - Date.now()) / 1000))) }, timeoutMs: 60000 })).data;
    } while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(t.state) && Date.now() < end);
    this.out(`狀態：${t.state}`);
    if (t.result) {
      this.out(`結果：${t.result.status} — ${t.result.summary}`);
      if (t.result.error) this.out(`錯誤：${t.result.error.code} ${t.result.error.message}`);
      if (t.result.metrics) this.out(`來源：${t.result.metrics.result_source}  耗時 ${t.result.metrics.duration_ms} ms  花費 ${t.result.metrics.cost_usd ?? '-'} USD`);
    }
    return t;
  }

  async tasks() {
    const q = {};
    if (this.opt.state) q.state = this.opt.state;
    if (this.opt.stuck) q.stuck = 1;
    if (this.opt.node) q.to_node = this.opt.node;
    const r = (await this.any().get('/tasks', { query: q })).data.items;
    if (this.opt.json) return this.json(r);
    for (const t of r) this.out(`${t.task_id}  ${t.state.padEnd(16)} ${t.from} → ${t.to}  ${t.title}${t.stuck_reason ? `\n    卡住：${t.stuck_reason} — ${t.stuck_detail}` : ''}`);
    if (!r.length) this.out(this.opt.stuck ? '(沒有卡住的任務)' : '(沒有任務)');
    return r;
  }

  async msg() {
    if (!this.opt.to || !this.opt.text) throw new Error('用法：aipagerctl msg --to main@dev-pc --text "..."');
    const r = (await this.node().post('/messages', { to: parseAddress(this.opt.to, 'main'), payload: { text: String(this.opt.text), ...(this.opt['requires-reply'] ? { requires_reply: true } : {}) } })).data;
    this.out(`已送出 ${r.message_id}`);
    for (const w of r.warnings || []) this.out('⚠ ' + w.message);
    return r;
  }

  async inbox() {
    const c = this.node();
    const agent = this.opt.agent || 'main';
    const r = (await c.get(`/mailboxes/${agent}/inbox`, { query: { unread_only: this.opt.all ? 0 : 1, limit: 50 } })).data.items;
    for (const i of r) { const e = i.envelope; this.out(`${i.message_id} ${i.kind} ${e.from.agent}@${e.from.node}: ${e.payload.text || e.payload.summary || ''}`); }
    if (!r.length) this.out('(沒有未讀)');
    if (this.opt.ack && r.length) await c.post(`/mailboxes/${agent}/ack`, { ids: r.map((i) => i.message_id) });
    return r;
  }

  async approvals(sub, id) {
    const a = this.admin();
    if (!sub || sub === 'list') {
      const r = (await a.get('/approvals', { query: { state: this.opt.state || 'pending' } })).data.items;
      for (const x of r) this.out(`${x.approval_id}  ${x.risk.padEnd(6)} ${x.tool_name}  ${JSON.stringify(x.tool_input).slice(0, 120)}  task=${x.task_id} (${x.task && x.task.assigned_node})  expires ${x.expires_at}`);
      if (!r.length) this.out('(沒有待審核)');
      return r;
    }
    const decision = sub === 'approve' ? 'allow' : 'deny';
    const r = (await a.post(`/approvals/${id}/decision`, { decision, note: this.opt.note ? String(this.opt.note) : undefined })).data;
    this.out(`${id}: ${r.state}`);
    return r;
  }

  async tail() {
    const a = this.admin();
    const res = await fetch(`${a.baseUrl}/api/v1/events/stream`, { headers: { Authorization: 'Bearer ' + a.token } });
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      for (const block of dec.decode(chunk, { stream: true }).split('\n\n')) {
        const d = /^data: (.*)$/m.exec(block);
        if (d) { const e = JSON.parse(d[1]); this.out(`${e.created_at} ${e.kind.padEnd(20)} ${e.node_id || ''} ${e.task_id || ''} ${JSON.stringify(e.data).slice(0, 160)}`); }
      }
    }
  }

  // ---------- admin ----------
  async adminCmd(sub, arg) {
    if (sub === 'init' || sub === 'restore') {
      const hubCfg = this.opt.config && typeof this.opt.config === 'string' ? this.opt.config : '/etc/aipager/hub.json';
      const A = require('../hub/admin');
      if (sub === 'restore') { const r = A.restore(readJson(hubCfg), arg); this.out(`已還原到 ${r.restored}（先停止 Hub 再執行；原檔已改名保留）`); return r; }
      const r = A.initAdmin(readJson(hubCfg));
      this.out(`admin token（只顯示這一次，請妥善保存）：\n${r.token}\n資料庫：${r.db}\n在你的機器執行：aipagerctl admin save-token <token> --hub <hub_url>`);
      return r;
    }
    if (sub === 'save-token') {
      if (!arg) throw new Error('用法：aipagerctl admin save-token <apa_...>');
      fs.mkdirSync(path.dirname(this.adminTokenFile()), { recursive: true });
      writeSecret(this.adminTokenFile(), arg);
      await restrictWindowsAcl(this.adminTokenFile());
      if (this.hubUrl && !this.cfg.hub_url) this.out('提示：沒有 node.json，之後的管理指令請加 --hub ' + this.hubUrl);
      this.out('已存到 ' + this.adminTokenFile());
      return true;
    }
    if (sub === 'backup') { const r = (await this.admin().post('/admin/backup', {})).data; this.out(`備份：${r.dir}/${r.file}`); return r; }
    if (sub === 'token') { const r = (await this.admin().post('/admin/tokens', { label: this.opt.label })).data; this.out(`${r.token_id}\n${r.token}`); return r; }
    throw new Error('用法：aipagerctl admin init|restore|save-token|backup|token');
  }
}

async function findClaude() {
  const home = os.homedir();
  const cands = osName() === 'windows' ? [path.join(home, '.local', 'bin', 'claude.exe')] : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  const r = await platform.run(osName() === 'windows' ? 'where' : 'which', ['claude'], { timeoutMs: 5000 });
  const found = r.ok ? r.stdout.trim().split(/\r?\n/).find((l) => osName() !== 'windows' || /\.exe$/i.test(l)) : '';
  return found || '';
}

async function restrictWindowsAcl(file) {
  if (process.platform !== 'win32') return;
  await platform.run('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`, '/grant', '*S-1-5-32-544:F'], { timeoutMs: 10000 });
}

function echoProfile(dirs) {
  const o = osName();
  const info = o === 'windows' ? ['Bash(hostname)', 'Bash(whoami)'] : o === 'macos' ? ['Bash(hostname)', 'Bash(whoami)', 'Bash(sw_vers)', 'Bash(uname -a)'] : ['Bash(hostname)', 'Bash(whoami)', 'Bash(uname -a)', 'Bash(cat /etc/os-release)'];
  return { description: 'Smoke test: read-only commands, reports machine info. 驗證用。', workdir: path.join(dirs.data, 'sandbox'), model: 'haiku', permission_mode: 'default',
    allowed_tools: info.concat('Read'), disallowed_tools: ['Edit', 'Write', 'WebFetch', 'WebSearch'], approval: { auto_allow: [], auto_deny: ['*'], timeout_sec: 120 }, max_turns: 5, timeout_sec: 120, concurrency_key: 'echo' };
}

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve('c');
  return new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }); });
}

const HELP = `aipagerctl ${VERSION} — AIPager 命令列工具

節點本機：
  join --hub URL --code CODE [--node-id ID] [--no-worker] [--power laptop] [--label k=v] [--claude-auth login|oauth_token]
  service install|uninstall|status [--mode agent|daemon] [--user NAME] [--dry-run]
  doctor [--encoding]
派工與訊息：
  send --to worker@build-pc --profile echo --title T --text "..." [--wait 120] [--on-unavailable confirm|queue|reject] [--requires-os linux] [--requires-label k=v] [--yes]
  tasks [--state running] [--stuck] [--node ID]    show <task_id> [--events]    wait <task_id> [--timeout 120]    cancel <task_id>
  msg --to main@dev-pc --text "..."    inbox [--agent main] [--ack]
節點管理（admin）：
  nodes [list] [--presence asleep] [--role r] [--label k=v] [--all]    nodes show|history <id>
  nodes set <id> [--name N] [--label k=v] [--unlabel k] [--add-role r] [--remove-role r] [--power laptop] [--suspend-grace 2h] [--asleep-after 120s] [--notes "..."]
  nodes approve|drain|disable|enable|retire <id> [--reason "..."]    nodes rollback <id> --to N
  enroll create [--name N] [--power laptop] [--role r] [--label k=v] [--ttl 24h] [--node-id ID] [--auto-approve]    enroll list    enroll revoke <id>
審核與追蹤（admin）：
  approvals [--state pending]    approvals approve|deny <id> [--note "..."]    tail    trace <trace_id>
管理（admin）：
  admin init --config /etc/aipager/hub.json    admin save-token <token> [--hub URL]    admin backup    admin restore <file> --config hub.json    admin token
共通選項：--config <node.json>  --hub <url>  --admin-token <token>  --json`;

async function main(argv, out = console.log, err = console.error) {
  const { pos, opt } = parse(argv);
  const [cmd, sub, arg] = pos;
  const c = new Ctl(opt, out, err);
  switch (cmd) {
    case undefined: case 'help': out(HELP); return 0;
    case 'version': out(VERSION); return 0;
    case 'doctor': return (await c.doctor()) ? 1 : 0;
    case 'join': await c.join(); return 0;
    case 'service': {
      if (sub === 'install') await service.install(c.configPath, { mode: opt.mode, user: opt.user, dryRun: !!opt['dry-run'] }, out);
      else if (sub === 'uninstall') await service.uninstall(out);
      else return (await service.status(out)) ? 0 : 1;
      return 0;
    }
    case 'nodes': await c.nodes(sub, arg); return 0;
    case 'enroll': await c.enroll(sub, arg); return 0;
    case 'send': { const r = await c.send(); return r === null ? 3 : r && r.state && r.state !== 'succeeded' ? 1 : 0; }
    case 'tasks': await c.tasks(); return 0;
    case 'show': c.json((await c.any().get('/tasks/' + sub, { query: { events: opt.events ? 1 : 0 } })).data); return 0;
    case 'wait': { const t = await c.wait(sub, opt.timeout ? seconds(opt.timeout) : 120); return t.state === 'succeeded' ? 0 : 1; }
    case 'cancel': c.json((await c.any().post(`/tasks/${sub}/cancel`, { reason: opt.reason ? String(opt.reason) : 'cancelled by aipagerctl' })).data); return 0;
    case 'msg': await c.msg(); return 0;
    case 'inbox': await c.inbox(); return 0;
    case 'approvals': await c.approvals(sub, arg); return 0;
    case 'tail': await c.tail(); return 0;
    case 'trace': c.json((await c.admin().get('/trace/' + sub)).data); return 0;
    case 'admin': await c.adminCmd(sub, arg); return 0;
    default: err(`未知的指令：${cmd}\n\n${HELP}`); return 2;
  }
}

module.exports = { main, parse, seconds, kv, echoProfile, APP_ROOT };
