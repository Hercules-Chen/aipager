'use strict';
// Tasks, mailboxes, approvals, stuck list. Business rules follow spec chapters 08-12 and 07 (presence).
const { AipError } = require('../common/errors');
const { check } = require('../common/schemas');
const { ulid, traceId } = require('../common/ulid');
const M = require('../common/messages');
const C = require('./core');
const P = require('../../spec/reference/presence');

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
const utc = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '');
const ACTIVE = ['claimed', 'running', 'waiting_approval'];
const addr = (a) => (a.role ? `${a.agent}@role:${a.role}` : `${a.agent}@${a.node}`);

function lim(ctx) { return ctx.cfg.limits || {}; }

// ---------- sender identity ----------
function senderOf(ctx, auth) {
  if (auth.kind === 'admin') return { from: { node: 'hub', agent: 'human' }, hop: 0, parent: null };
  if (auth.kind === 'chain') return auth.sender;
  if (auth.node_state !== 'active' && auth.node_state !== 'draining') throw new AipError('E_NODE_NOT_ACTIVE');
  if (auth.kind === 'task') {
    const t = ctx.one('SELECT task_id, thread_id, hop, trace_id, assigned_node FROM tasks WHERE task_id=?', auth.task_id);
    if (!t) throw new AipError('E_AUTH', 'task token without task');
    return { from: { node: t.assigned_node, agent: 'worker' }, hop: t.hop + 1, parent: t };
  }
  return { from: { node: auth.node_id, agent: auth.agent || 'main' }, hop: 0, parent: null };
}

function threadFor(ctx, threadId, parent) {
  const id = threadId || (parent && parent.thread_id);
  if (id) {
    const th = ctx.one('SELECT * FROM threads WHERE thread_id=?', id);
    if (!th) throw new AipError('E_NOT_FOUND', 'thread ' + id);
    return th;
  }
  return null;
}

function notice(ctx, to, code, text, refs = {}) {
  if (!to || !to.node || to.node === 'hub') return;
  const id = ulid(ctx.now());
  const env = { v: '1.0', id, kind: 'system.notice', from: { node: 'hub', agent: 'hub' }, to, thread_id: refs.thread_id || id,
    trace: { trace_id: refs.trace_id || traceId(), hop: 0 }, created_at: ctx.iso(), payload: { code, text: text.slice(0, 2000) } };
  if (refs.ref_id) env.payload.ref_id = refs.ref_id;
  ctx.run('INSERT INTO messages(message_id,thread_id,kind,from_node,from_agent,to_node,to_agent,envelope,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, env.thread_id, 'system.notice', 'hub', 'hub', to.node, to.agent, JSON.stringify(env), env.created_at);
  ctx.bus.emit(`mailbox:${to.node}:${to.agent}`);
  ctx.event('mailbox.notice', { code, to: addr(to) }, { node_id: to.node, task_id: refs.task_id });
}

// ---------- dispatch helpers ----------
function eligible(ctx, n, profile, requires) {
  return n.state === 'active' && n.profiles.some((p) => p.name === profile) && C.meetsRequires(n, requires) === true;
}

function targetStatus(ctx, n) {
  const p = C.presenceOf(ctx, n);
  return { node_id: n.node_id, display_name: n.meta.display_name, power: n.meta.power, state: n.state, presence: p.presence, last_seen: n.last_seen, silent_sec: p.silent_sec };
}

function altView(ctx, n) {
  return { node_id: n.node_id, display_name: n.meta.display_name, presence: C.presenceOf(ctx, n).presence, running: n.running, reason: '有相同 profile 且符合條件' };
}

function warningObjs(ctx, list, lang) {
  return list.map((w) => {
    const n = w.params.node_id ? C.getNode(ctx, w.params.node_id) : null;
    const params = Object.assign({}, w.params, n ? { node: { node_id: n.node_id, display_name: n.meta.display_name, power: n.meta.power } } : {});
    return { code: w.code, message: M.warningText(w.code, params, lang).slice(0, 500), params: w.params };
  });
}

// ---------- create ----------
function createTask(ctx, auth, body, lang = 'zh-TW') {
  const s = senderOf(ctx, auth);
  if (!body || typeof body !== 'object' || !body.to || !body.payload) throw new AipError('E_VALIDATION', 'to and payload are required');
  const idem = body.idempotency_key;
  if (idem) {
    const ex = ctx.one('SELECT task_id FROM tasks WHERE from_node=? AND idempotency_key=?', s.from.node, idem);
    if (ex) return { status: 200, body: createdView(ctx, ex.task_id, [], [], lang) };
  }
  if (s.hop > (lim(ctx).max_hops ?? 4)) throw new AipError('E_HOP_LIMIT', null, { hop: s.hop });
  const to = body.to;
  if (to.node && to.node === s.from.node && to.agent === s.from.agent) throw new AipError('E_SELF_TARGET');
  const thread = threadFor(ctx, body.thread_id, s.parent);
  if (thread) {
    if (thread.task_count >= (lim(ctx).max_tasks_per_thread ?? 20)) throw new AipError('E_THREAD_LIMIT', null, { task_count: thread.task_count });
    if (thread.cost_usd >= (lim(ctx).thread_budget_usd ?? 20)) throw new AipError('E_BUDGET', null, { cost_usd: thread.cost_usd });
  }
  const recent = ctx.one('SELECT COUNT(*) AS c FROM tasks WHERE from_node=? AND created_at>?', s.from.node, ctx.iso(ctx.now() - 60000)).c;
  if (auth.kind !== 'chain' && recent >= (lim(ctx).rate_per_sender_per_min ?? 10)) throw new AipError('E_RATE_LIMIT', null, { retry_after_sec: 60 });

  const id = ulid(ctx.now());
  const threadId = thread ? thread.thread_id : ulid(ctx.now());
  const trace = { trace_id: thread ? thread.trace_id : traceId(), hop: s.hop, path: [addr(s.from)] };
  if (s.parent) trace.path = [addr(s.from)];
  const env = { v: '1.0', id, kind: 'task.create', from: s.from, to, thread_id: threadId, trace, created_at: ctx.iso(), payload: body.payload };
  if (body.parent_id || (s.parent && s.parent.task_id)) env.parent_id = body.parent_id || s.parent.task_id;
  if (body.expires_at) env.expires_at = body.expires_at;
  if (idem) env.idempotency_key = idem;
  if (body.priority) env.priority = body.priority;
  if (body.meta) env.meta = body.meta;
  const errs = check('envelope', null, env);
  if (errs) throw new AipError('E_VALIDATION', 'invalid task', { errors: errs });

  const pl = body.payload;
  const req = pl.requires || null;
  const all = C.allNodes(ctx);
  let target;
  let alternatives = [];
  if (to.node) {
    const n = all.find((x) => x.node_id === to.node);
    if (!n) throw new AipError('E_NOT_FOUND', 'node ' + to.node);
    if (n.profiles.length && !n.profiles.some((p) => p.name === pl.profile)) throw new AipError('E_PROFILE_UNKNOWN', null, { node_id: n.node_id, profiles: n.profiles.map((p) => p.name) });
    if (C.meetsRequires(n, req) === false) throw new AipError('E_REQUIREMENT_UNMET', null, { node_id: n.node_id, os: n.os, arch: n.arch, labels: n.meta.labels });
    target = { kind: 'node', node: { node_id: n.node_id, state: n.state, last_seen: n.last_seen, meta: n.meta } };
    alternatives = all.filter((x) => x.node_id !== n.node_id && eligible(ctx, x, pl.profile, req));
  } else {
    const cands = all.filter((x) => x.meta.roles.includes(to.role) && eligible(ctx, x, pl.profile, req));
    target = { kind: 'role', role: to.role, candidates: cands.map((x) => ({ node_id: x.node_id, state: x.state, last_seen: x.last_seen, meta: x.meta })) };
  }
  const onUnavailable = (pl.dispatch && pl.dispatch.on_unavailable) || 'queue';
  const altInput = alternatives.map((x) => ({ node_id: x.node_id, state: x.state, last_seen: x.last_seen, meta: x.meta }));
  const decision = P.decideDispatch({ target, alternatives: altInput, onUnavailable }, ctx.now(), ctx.presenceDefaults);
  const warnings = warningObjs(ctx, decision.warnings, lang);
  const alts = decision.alternatives.map((id2) => altView(ctx, all.find((x) => x.node_id === id2)));
  const tStatus = to.node ? targetStatus(ctx, all.find((x) => x.node_id === to.node))
    : { role: to.role, candidates_online: target.candidates.filter((c) => P.canClaim(c, ctx.now(), ctx.presenceDefaults)).length, candidates_total: target.candidates.length };
  if (decision.action === 'refuse') {
    const msg = warnings.map((w) => w.message).join(' ') + (lang === 'en' ? ' The task was not created.' : '任務尚未建立。');
    throw new AipError('E_TARGET_UNAVAILABLE', msg, null, { target_status: tStatus, warnings, alternatives: alts, choices: ['queue', 'send_to_alternative', 'cancel'] });
  }

  const ttl = (pl.dispatch && pl.dispatch.max_wait_sec) || lim(ctx).default_queue_ttl_sec || 86400;
  const expiresAt = body.expires_at || ctx.iso(ctx.now() + ttl * 1000);
  const limits = pl.limits || {};
  ctx.tx(() => {
    if (!thread) ctx.run('INSERT INTO threads(thread_id,trace_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', threadId, trace.trace_id, pl.title, ctx.iso(), ctx.iso());
    ctx.run('UPDATE threads SET task_count=task_count+1, updated_at=? WHERE thread_id=?', ctx.iso(), threadId);
    ctx.run(`INSERT INTO tasks(task_id,thread_id,parent_id,from_node,from_agent,to_node,to_role,profile,require_os,require_arch,require_labels,on_unavailable,
             title,priority,state,envelope,max_attempts,hop,trace_id,idempotency_key,timeout_sec,expires_at,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`,
    id, threadId, env.parent_id || null, s.from.node, s.from.agent, to.node || null, to.role || null, pl.profile,
    req && req.os ? JSON.stringify(req.os) : null, req && req.arch ? JSON.stringify(req.arch) : null, req && req.labels ? JSON.stringify(req.labels) : null,
    onUnavailable, pl.title, body.priority || 5, JSON.stringify(env), limits.max_attempts || 1, s.hop, trace.trace_id, idem || null,
    limits.timeout_sec || 1800, expiresAt, ctx.iso(), ctx.iso());
  });
  ctx.event('task.created', { title: pl.title, from: addr(s.from), to: addr(to), profile: pl.profile, warnings: warnings.map((w) => w.code) }, { task_id: id, thread_id: threadId, trace_id: trace.trace_id });
  ctx.bus.emit('task-available');
  return { status: 201, body: createdView(ctx, id, warnings, alts, lang, tStatus) };
}

function createdView(ctx, id, warnings, alts, lang, tStatus) {
  const t = ctx.one('SELECT * FROM tasks WHERE task_id=?', id);
  let ts = tStatus;
  if (!ts) {
    const n = t.to_node ? C.getNode(ctx, t.to_node) : null;
    ts = n ? targetStatus(ctx, n) : { role: t.to_role };
  }
  return { task_id: t.task_id, thread_id: t.thread_id, trace_id: t.trace_id, state: 'queued', expires_at: t.expires_at, target_status: ts, warnings, alternatives: alts };
}

// ---------- claim ----------
const CLAIM_SQL = `UPDATE tasks SET state='claimed', assigned_node=n.node_id, lease_id=:lease, lease_expires_at=:exp,
       attempt=attempt+1, claimed_at=:now, updated_at=:now
  FROM (SELECT node_id, roles, labels, os, arch FROM nodes WHERE node_id=:node AND state='active') AS n
 WHERE tasks.task_id = (
   SELECT t.task_id FROM tasks t
    WHERE t.state='queued'
      AND (t.to_node=n.node_id OR t.to_role IN (SELECT value FROM json_each(n.roles)))
      AND t.profile IN (SELECT value FROM json_each(:free_profiles))
      AND (t.require_os   IS NULL OR n.os   IN (SELECT value FROM json_each(t.require_os)))
      AND (t.require_arch IS NULL OR n.arch IN (SELECT value FROM json_each(t.require_arch)))
      AND (t.require_labels IS NULL OR NOT EXISTS (
            SELECT 1 FROM json_each(t.require_labels) r
             WHERE NOT (CASE WHEN r.value = '*'
                             THEN json_extract(n.labels, '$."' || r.key || '"') IS NOT NULL
                             ELSE json_extract(n.labels, '$."' || r.key || '"') IS r.value END)))
    ORDER BY t.priority ASC, t.created_at ASC, t.task_id ASC
    LIMIT 1)
RETURNING tasks.task_id`;

function tryClaim(ctx, nodeId, profiles) {
  return ctx.tx(() => {
    const lease = 'lease_' + ulid(ctx.now());
    const exp = ctx.iso(ctx.now() + (ctx.cfg.lease?.duration_sec || 60) * 1000);
    const r = ctx.db.prepare(CLAIM_SQL).get({ ':node': nodeId, ':lease': lease, ':exp': exp, ':now': ctx.iso(), ':free_profiles': JSON.stringify(profiles || []) });
    if (!r) return null;
    const t = ctx.one('SELECT * FROM tasks WHERE task_id=?', r.task_id);
    const { token } = C.issueToken(ctx, { kind: 'task', node_id: nodeId, task_id: t.task_id, label: 'task ' + t.task_id });
    const env = JSON.parse(t.envelope);
    let resume;
    if (env.payload.session && env.payload.session.mode === 'resume_thread') {
      const s = ctx.one('SELECT claude_session_id FROM claude_sessions WHERE thread_id=? AND node_id=? AND profile=?', t.thread_id, nodeId, t.profile);
      if (s) resume = s.claude_session_id;
    }
    return { t, env, lease, exp, token, resume };
  });
}

async function claim(ctx, auth, body, waitSec) {
  const n = C.getNode(ctx, auth.node_id);
  if (n.state !== 'active') return null;
  const deadline = ctx.now() + Math.min(Math.max(Number(waitSec) || 0, 0), 50) * 1000;
  for (;;) {
    const c = tryClaim(ctx, auth.node_id, body && body.profiles);
    if (c) {
      const waitedSec = Math.round((Date.parse(c.t.claimed_at) - Date.parse(c.t.created_at)) / 1000);
      ctx.event('task.claimed', { node_id: auth.node_id, attempt: c.t.attempt, waited_sec: waitedSec }, { task_id: c.t.task_id, thread_id: c.t.thread_id, trace_id: c.t.trace_id, node_id: auth.node_id });
      if (waitedSec >= 60) {
        notice(ctx, c.env.from, 'TASK_STARTED_AFTER_WAIT', `${auth.node_id} 已開始執行「${c.t.title}」（排隊 ${M.duration(waitedSec)}）`, { task_id: c.t.task_id, thread_id: c.t.thread_id, ref_id: c.t.task_id });
      }
      const res = { task: c.env, lease: { lease_id: c.lease, expires_at: c.exp }, task_token: c.token, attempt: c.t.attempt };
      if (c.resume) res.resume_session_id = c.resume;
      return res;
    }
    const left = deadline - ctx.now();
    if (left <= 0) return null;
    await waitEvent(ctx.bus, 'task-available', Math.min(left, 5000));
  }
}

function waitEvent(bus, name, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { bus.off(name, h); resolve(false); }, ms);
    const h = () => { clearTimeout(t); resolve(true); };
    bus.once(name, h);
  });
}

// ---------- lease / progress / result ----------
function taskRow(ctx, id) {
  const t = ctx.one('SELECT * FROM tasks WHERE task_id=?', id);
  if (!t) throw new AipError('E_NOT_FOUND', 'task ' + id);
  return t;
}

function assertAssigned(auth, t) {
  if (auth.kind === 'admin') return;
  if (auth.kind === 'task' && auth.task_id === t.task_id) return;
  if (auth.kind === 'node' && auth.node_id === t.assigned_node) return;
  throw new AipError('E_FORBIDDEN', 'not the assigned node');
}

function wakeTask(ctx, t) {
  if (!t.node_asleep_since) return;
  const ms = Math.max(0, ctx.now() - Date.parse(t.node_asleep_since));
  ctx.run('UPDATE tasks SET node_asleep_since=NULL, asleep_ms_total=asleep_ms_total+? WHERE task_id=?', ms, t.task_id);
}

function renewLease(ctx, auth, id, body) {
  return ctx.tx(() => {
    const t = taskRow(ctx, id);
    assertAssigned(auth, t);
    if (!ACTIVE.includes(t.state) || !body || body.lease_id !== t.lease_id) throw new AipError('E_LEASE_LOST', null, { state: t.state });
    const exp = ctx.iso(ctx.now() + (ctx.cfg.lease?.duration_sec || 60) * 1000);
    ctx.run('UPDATE tasks SET lease_expires_at=?, updated_at=? WHERE task_id=?', exp, ctx.iso(), id);
    wakeTask(ctx, t);
    return { expires_at: exp, cancel_requested: !!t.cancel_requested };
  });
}

function progress(ctx, auth, id, body) {
  const t = taskRow(ctx, id);
  assertAssigned(auth, t);
  if (TERMINAL.includes(t.state)) throw new AipError('E_CONFLICT', 'task finished');
  if (body && body.seq != null && body.seq <= t.last_seq) return { accepted: false, duplicate: true };
  const seq = body && body.seq != null ? body.seq : t.last_seq + 1;
  const payload = Object.assign({ task_id: id, seq }, body || {});
  delete payload.lease_id;
  const errs = check('envelope', 'taskProgress', payload);
  if (errs) throw new AipError('E_VALIDATION', 'invalid progress', { errors: errs });
  ctx.tx(() => {
    ctx.run('INSERT OR IGNORE INTO task_events(task_id,seq,phase,message,data,created_at) VALUES(?,?,?,?,?,?)',
      id, seq, payload.phase, payload.message || null, JSON.stringify(payload), ctx.iso());
    ctx.run('UPDATE tasks SET last_seq=MAX(last_seq,?), updated_at=? WHERE task_id=?', seq, ctx.iso(), id);
    if (payload.phase === 'started' && t.state === 'claimed') {
      ctx.run("UPDATE tasks SET state='running', started_at=?, claude_session_id=COALESCE(?, claude_session_id) WHERE task_id=?", ctx.iso(), payload.claude_session_id || null, id);
    } else if (payload.claude_session_id) ctx.run('UPDATE tasks SET claude_session_id=? WHERE task_id=?', payload.claude_session_id, id);
  });
  ctx.event('task.progress', { seq, phase: payload.phase, message: payload.message, tool: payload.tool }, { task_id: id, thread_id: t.thread_id, trace_id: t.trace_id });
  ctx.bus.emit('task:' + id);
  return { accepted: true, seq };
}

function finish(ctx, t, payload, actor) {
  const env = JSON.parse(t.envelope);
  ctx.run(`UPDATE tasks SET state=?, result=?, error_code=?, finished_at=?, updated_at=?, lease_id=NULL, lease_expires_at=NULL, node_asleep_since=NULL,
           claude_session_id=COALESCE(?, claude_session_id) WHERE task_id=?`,
  payload.status, JSON.stringify(payload), payload.error ? payload.error.code : null, ctx.iso(), ctx.iso(), payload.metrics && payload.metrics.claude_session_id || null, t.task_id);
  ctx.run("UPDATE tokens SET expires_at=? WHERE task_id=? AND kind='task' AND revoked_at IS NULL", ctx.iso(ctx.now() + 300000), t.task_id);
  const cost = (payload.metrics && payload.metrics.cost_usd) || 0;
  if (cost) ctx.run('UPDATE threads SET cost_usd=cost_usd+?, updated_at=? WHERE thread_id=?', cost, ctx.iso(), t.thread_id);
  const sid = payload.metrics && payload.metrics.claude_session_id;
  if (sid && t.assigned_node) {
    ctx.run(`INSERT INTO claude_sessions(thread_id,node_id,profile,claude_session_id,updated_at) VALUES(?,?,?,?,?)
             ON CONFLICT(thread_id,node_id,profile) DO UPDATE SET claude_session_id=excluded.claude_session_id, updated_at=excluded.updated_at`,
    t.thread_id, t.assigned_node, t.profile, sid, ctx.iso());
  }
  // Result notice into the sender's (or notify) mailbox as a task.result envelope.
  const notify = (env.payload.notify && env.payload.notify.mailbox) || env.from;
  const on = (env.payload.notify && env.payload.notify.on) || ['approval', 'result'];
  if (on.includes('result') && notify.node !== 'hub') {
    const mid = ulid(ctx.now());
    const renv = { v: '1.0', id: mid, kind: 'task.result', from: { node: t.assigned_node || 'hub', agent: t.assigned_node ? 'worker' : 'hub' }, to: notify,
      thread_id: t.thread_id, parent_id: t.task_id, trace: { trace_id: t.trace_id, hop: t.hop }, created_at: ctx.iso(), payload };
    ctx.run('INSERT INTO messages(message_id,thread_id,kind,from_node,from_agent,to_node,to_agent,envelope,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      mid, t.thread_id, 'task.result', renv.from.node, renv.from.agent, notify.node, notify.agent, JSON.stringify(renv), ctx.iso());
    ctx.bus.emit(`mailbox:${notify.node}:${notify.agent}`);
  }
  ctx.event('task.' + payload.status, { status: payload.status, error: payload.error || null, summary: (payload.summary || '').slice(0, 300), actor },
    { task_id: t.task_id, thread_id: t.thread_id, trace_id: t.trace_id, node_id: t.assigned_node });
  ctx.bus.emit('task:' + t.task_id);
}

function submitResult(ctx, auth, id, leaseId, payload) {
  const done = ctx.tx(() => {
    const t = taskRow(ctx, id);
    assertAssigned(auth, t);
    if (TERMINAL.includes(t.state)) throw new AipError('E_CONFLICT', 'task already ' + t.state);
    if (!leaseId || leaseId !== t.lease_id) throw new AipError('E_LEASE_LOST', null, { state: t.state });
    const p = Object.assign({ task_id: id }, payload);
    const errs = check('envelope', 'taskResult', p);
    if (errs) throw new AipError('E_VALIDATION', 'invalid result', { errors: errs });
    finish(ctx, t, p, auth.token_id);
    return { t, p };
  });
  runThen(ctx, done.t, done.p);
  return { state: done.p.status };
}

function cancel(ctx, auth, id, body) {
  return ctx.tx(() => {
    const t = taskRow(ctx, id);
    if (auth.kind !== 'admin' && !(auth.node_id === t.from_node)) throw new AipError('E_FORBIDDEN', 'only the sender or an admin can cancel');
    if (TERMINAL.includes(t.state)) throw new AipError('E_CONFLICT', 'task already ' + t.state);
    const reason = (body && body.reason) || 'cancelled';
    if (t.state === 'queued') {
      finish(ctx, t, { task_id: id, status: 'cancelled', summary: `已取消：${reason}`, error: { code: 'E_CANCELLED', message: reason } }, auth.token_id);
      return { state: 'cancelled' };
    }
    ctx.run('UPDATE tasks SET cancel_requested=1, updated_at=? WHERE task_id=?', ctx.iso(), id);
    ctx.event('task.cancel_requested', { reason }, { task_id: id, thread_id: t.thread_id, trace_id: t.trace_id, node_id: t.assigned_node });
    return { state: t.state, cancel_requested: true };
  });
}

// ---------- then chains ----------
function render(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (m, key) => {
      const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
      if (v === undefined || v === null) return '';
      return String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\{\{|\}\}/g, '').replace(/</g, '＜').replace(/>/g, '＞');
    });
  }
  if (Array.isArray(value)) return value.map((x) => render(x, vars));
  if (value && typeof value === 'object') { const o = {}; for (const [k, v] of Object.entries(value)) o[k] = render(v, vars); return o; }
  return value;
}

function runThen(ctx, t, result) {
  const env = JSON.parse(t.envelope);
  const items = env.payload.then || [];
  for (const item of items) {
    const when = item.when || 'succeeded';
    if (!(when === 'always' || when === result.status)) continue;
    const vars = { result: { summary: result.summary, output: result.output }, inputs: env.payload.inputs || {}, task: { id: t.task_id } };
    const spec = render(Object.assign({}, item), vars);
    const to = spec.to;
    delete spec.to; delete spec.when;
    spec.dispatch = Object.assign({ on_unavailable: 'queue' }, spec.dispatch || {});
    try {
      createTask(ctx, { kind: 'chain', sender: { from: env.from, hop: t.hop + 1, parent: { task_id: t.task_id, thread_id: t.thread_id } } },
        { to, thread_id: t.thread_id, parent_id: t.task_id, payload: spec });
    } catch (e) {
      ctx.log.warn('then.failed', 'follow-up task not created', { code: e.code, message: e.message }, { task_id: t.task_id });
      notice(ctx, env.from, 'THEN_FAILED', `後續任務「${item.title}」沒有建立：${e.code} ${e.message}`, { task_id: t.task_id, thread_id: t.thread_id, ref_id: t.task_id });
    }
  }
}

// ---------- queries ----------
function taskView(ctx, t, { events = false } = {}) {
  const env = JSON.parse(t.envelope);
  const v = {
    task_id: t.task_id, thread_id: t.thread_id, trace_id: t.trace_id, title: t.title, profile: t.profile, state: t.state,
    from: `${t.from_agent}@${t.from_node}`, to: t.to_node ? `worker@${t.to_node}` : `worker@role:${t.to_role}`, assigned_node: t.assigned_node,
    priority: t.priority, attempt: t.attempt, max_attempts: t.max_attempts, hop: t.hop, cancel_requested: !!t.cancel_requested,
    node_asleep_since: t.node_asleep_since, asleep_ms_total: t.asleep_ms_total, error_code: t.error_code, timeout_sec: t.timeout_sec,
    created_at: t.created_at, claimed_at: t.claimed_at, started_at: t.started_at, finished_at: t.finished_at, expires_at: t.expires_at,
    result: t.result ? JSON.parse(t.result) : null, envelope: env,
  };
  const nodeId = t.assigned_node || t.to_node;
  if (nodeId && !TERMINAL.includes(t.state)) { const n = C.getNode(ctx, nodeId); if (n) v.node_status = targetStatus(ctx, n); }
  if (events) v.events = ctx.all('SELECT seq,phase,message,data,created_at FROM task_events WHERE task_id=? ORDER BY seq', t.task_id).map((e) => Object.assign(e, { data: e.data ? JSON.parse(e.data) : null }));
  return v;
}

function getTask(ctx, auth, id, opts) {
  const t = taskRow(ctx, id);
  if (auth.kind === 'task' && auth.task_id !== id) {
    const own = ctx.one('SELECT 1 FROM tasks WHERE task_id=? AND parent_id=?', id, auth.task_id);
    if (!own) throw new AipError('E_FORBIDDEN');
  }
  return taskView(ctx, t, opts);
}

async function waitTask(ctx, auth, id, timeoutSec) {
  const deadline = ctx.now() + Math.min(Math.max(Number(timeoutSec) || 0, 0), 50) * 1000;
  for (;;) {
    const v = getTask(ctx, auth, id, { events: true });
    if (TERMINAL.includes(v.state) || ctx.now() >= deadline) {
      v.events = (v.events || []).slice(-5);
      return v;
    }
    await waitEvent(ctx.bus, 'task:' + id, Math.min(deadline - ctx.now(), 5000));
  }
}

function listTasks(ctx, auth, q = {}) {
  if (q.stuck) return stuck(ctx);
  const where = [];
  const args = [];
  if (q.state) { where.push('state=?'); args.push(q.state); }
  if (q.to_node) { where.push('(to_node=? OR assigned_node=?)'); args.push(q.to_node, q.to_node); }
  if (q.thread_id) { where.push('thread_id=?'); args.push(q.thread_id); }
  if (q.waiting_for_node) { where.push("state='queued' AND to_node=?"); args.push(q.waiting_for_node); }
  if (auth.kind === 'node') { where.push('(from_node=? OR to_node=? OR assigned_node=?)'); args.push(auth.node_id, auth.node_id, auth.node_id); }
  if (q.cursor) { where.push('task_id<?'); args.push(q.cursor); }
  const limit = Math.min(Number(q.limit) || 50, 200);
  const rows = ctx.all(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY task_id DESC LIMIT ${limit}`, ...args);
  return { items: rows.map((t) => taskView(ctx, t)), next_cursor: rows.length === limit ? rows[rows.length - 1].task_id : null };
}

// Stuck tasks (spec chapter 07): waiting_node, no_candidate, node_asleep, waiting_approval.
function stuck(ctx) {
  const out = [];
  const nodes = Object.fromEntries(C.allNodes(ctx).map((n) => [n.node_id, n]));
  for (const t of ctx.all("SELECT * FROM tasks WHERE state='queued' ORDER BY created_at")) {
    const env = JSON.parse(t.envelope);
    if (t.to_node) {
      const n = nodes[t.to_node];
      const p = n ? C.presenceOf(ctx, n) : { presence: 'offline', silent_sec: null };
      if (!n || p.presence !== 'online' || n.state !== 'active') {
        out.push(Object.assign(taskView(ctx, t), { stuck_reason: 'waiting_node',
          stuck_detail: n ? `等待 ${n.node_id}（${n.meta.display_name}）：${n.state !== 'active' ? '狀態 ' + n.state : '已 ' + M.duration(p.silent_sec) + '沒有回應'}；已排隊 ${M.duration(Math.round((ctx.now() - Date.parse(t.created_at)) / 1000))}，最晚等到 ${utc(t.expires_at)}`
            : `節點 ${t.to_node} 已不存在` }));
      }
    } else {
      const req = env.payload.requires || null;
      const cands = Object.values(nodes).filter((n) => n.meta.roles.includes(t.to_role) && n.profiles.some((x) => x.name === t.profile) && C.meetsRequires(n, req) === true);
      const online = cands.filter((n) => n.state === 'active' && C.presenceOf(ctx, n).presence === 'online');
      if (!online.length) {
        out.push(Object.assign(taskView(ctx, t), { stuck_reason: 'no_candidate',
          stuck_detail: `角色 ${t.to_role} 沒有在線且符合條件的機器（符合條件 ${cands.length} 台：${cands.map((n) => `${n.node_id} ${C.presenceOf(ctx, n).presence}`).join('、') || '無'}）` }));
      }
    }
  }
  for (const t of ctx.all("SELECT * FROM tasks WHERE state IN ('claimed','running','waiting_approval') ORDER BY created_at")) {
    const n = nodes[t.assigned_node];
    const p = n ? C.presenceOf(ctx, n) : null;
    if (n && p.presence !== 'online') {
      const left = p.settings.suspend_grace_sec - (p.silent_sec || 0);
      out.push(Object.assign(taskView(ctx, t), { stuck_reason: 'node_asleep',
        stuck_detail: `執行機器 ${n.node_id}（${n.meta.display_name}）已 ${M.duration(p.silent_sec)}沒有回應；保留時間${left > 0 ? '還剩 ' + M.duration(left) : '已用完，等待租約處理'}` }));
    } else if (t.state === 'waiting_approval') {
      const a = ctx.one("SELECT * FROM approvals WHERE task_id=? AND state='pending' ORDER BY created_at LIMIT 1", t.task_id);
      if (a && ctx.now() - Date.parse(a.created_at) > 300000) {
        out.push(Object.assign(taskView(ctx, t), { stuck_reason: 'waiting_approval',
          stuck_detail: `等待審核 ${a.tool_name} 已 ${M.duration(Math.round((ctx.now() - Date.parse(a.created_at)) / 1000))}，${utc(a.expires_at)} 逾時自動拒絕` }));
      }
    }
  }
  return { items: out, next_cursor: null };
}

// ---------- messages ----------
function sendMessage(ctx, auth, body, lang) {
  const s = senderOf(ctx, auth);
  if (!body || !body.to || !body.payload) throw new AipError('E_VALIDATION', 'to and payload are required');
  const to = body.to;
  if (!to.node) throw new AipError('E_VALIDATION', 'messages must target a node mailbox');
  if (to.node === s.from.node && to.agent === s.from.agent) throw new AipError('E_SELF_TARGET');
  const n = C.getNode(ctx, to.node);
  if (!n || n.state === 'retired') throw new AipError('E_NOT_FOUND', 'node ' + to.node);
  const thread = threadFor(ctx, body.thread_id, s.parent);
  if (thread && thread.message_count >= (lim(ctx).max_messages_per_thread ?? 200)) throw new AipError('E_THREAD_LIMIT');
  if (body.idempotency_key) {
    const ex = ctx.one('SELECT message_id, thread_id FROM messages WHERE from_node=? AND idempotency_key=?', s.from.node, body.idempotency_key);
    if (ex) return { status: 200, body: { message_id: ex.message_id, thread_id: ex.thread_id, warnings: [] } };
  }
  const id = ulid(ctx.now());
  const threadId = thread ? thread.thread_id : ulid(ctx.now());
  const env = { v: '1.0', id, kind: 'message', from: s.from, to, thread_id: threadId, trace: { trace_id: thread ? thread.trace_id : traceId(), hop: s.hop, path: [addr(s.from)] },
    created_at: ctx.iso(), payload: body.payload };
  if (body.parent_id) env.parent_id = body.parent_id;
  if (body.idempotency_key) env.idempotency_key = body.idempotency_key;
  const errs = check('envelope', null, env);
  if (errs) throw new AipError('E_VALIDATION', 'invalid message', { errors: errs });
  ctx.tx(() => {
    if (!thread) ctx.run('INSERT INTO threads(thread_id,trace_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', threadId, env.trace.trace_id, body.payload.text.slice(0, 80), ctx.iso(), ctx.iso());
    ctx.run('UPDATE threads SET message_count=message_count+1, updated_at=? WHERE thread_id=?', ctx.iso(), threadId);
    ctx.run('INSERT INTO messages(message_id,thread_id,kind,from_node,from_agent,to_node,to_agent,envelope,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, threadId, 'message', s.from.node, s.from.agent, to.node, to.agent, JSON.stringify(env), body.idempotency_key || null, ctx.iso());
  });
  ctx.bus.emit(`mailbox:${to.node}:${to.agent}`);
  ctx.event('message.sent', { from: addr(s.from), to: addr(to) }, { thread_id: threadId, trace_id: env.trace.trace_id, node_id: to.node });
  const p = C.presenceOf(ctx, n);
  const warnings = p.presence === 'online' ? [] : warningObjs(ctx, [{ code: { asleep: 'W_TARGET_ASLEEP', offline: 'W_TARGET_OFFLINE', never: 'W_TARGET_NEVER_SEEN' }[p.presence], params: { node_id: n.node_id, silent_sec: p.silent_sec } }], lang);
  return { status: 201, body: { message_id: id, thread_id: threadId, warnings } };
}

async function inbox(ctx, auth, agent, q = {}) {
  const deadline = ctx.now() + Math.min(Math.max(Number(q.wait) || 0, 0), 50) * 1000;
  const unreadOnly = q.unread_only === undefined || q.unread_only === true || q.unread_only === '1' || q.unread_only === 'true';
  const limit = Math.min(Number(q.limit) || 20, 50);
  for (;;) {
    const rows = ctx.all(`SELECT message_id, kind, envelope, read_at, created_at FROM messages WHERE to_node=? AND to_agent=? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at, message_id LIMIT ${limit}`,
      auth.node_id, agent);
    if (rows.length || ctx.now() >= deadline) return { items: rows.map((r) => ({ message_id: r.message_id, kind: r.kind, read_at: r.read_at, envelope: JSON.parse(r.envelope) })) };
    await waitEvent(ctx.bus, `mailbox:${auth.node_id}:${agent}`, Math.min(deadline - ctx.now(), 5000));
  }
}

function ack(ctx, auth, agent, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new AipError('E_VALIDATION', 'ids required');
  let n = 0;
  for (const id of ids.slice(0, 100)) n += ctx.run('UPDATE messages SET read_at=? WHERE message_id=? AND to_node=? AND to_agent=? AND read_at IS NULL', ctx.iso(), id, auth.node_id, agent).changes;
  return { acked: n };
}

function summary(ctx, auth, agent) {
  const unread = ctx.all('SELECT kind, envelope FROM messages WHERE to_node=? AND to_agent=? AND read_at IS NULL ORDER BY created_at DESC', auth.node_id, agent);
  const top = unread.slice(0, 3).map((r) => {
    const e = JSON.parse(r.envelope);
    if (r.kind === 'task.result') return `任務結果（${e.payload.status}）：${(e.payload.summary || '').slice(0, 60)}`;
    if (r.kind === 'system.notice') return e.payload.text.slice(0, 80);
    return `${e.from.agent}@${e.from.node}：${e.payload.text.slice(0, 60)}`;
  });
  const waiting = ctx.one("SELECT COUNT(*) AS c FROM tasks WHERE from_node=? AND from_agent=? AND state='queued'", auth.node_id, agent).c;
  const pendingApprovals = ctx.one(`SELECT COUNT(*) AS c FROM approvals a JOIN tasks t ON t.task_id=a.task_id WHERE a.state='pending' AND t.from_node=? AND t.from_agent=?`, auth.node_id, agent).c;
  return { unread: unread.length, tasks_done: unread.filter((r) => r.kind === 'task.result').length, approvals_pending: pendingApprovals, waiting_tasks: waiting, top };
}

// ---------- approvals ----------
function createApproval(ctx, auth, body) {
  if (auth.kind !== 'task') throw new AipError('E_FORBIDDEN', 'task token required');
  const t = taskRow(ctx, auth.task_id);
  if (!ACTIVE.includes(t.state)) throw new AipError('E_CONFLICT', 'task is ' + t.state);
  const id = ulid(ctx.now());
  const timeout = Math.min(Math.max(Number(body.timeout_sec) || ctx.cfg.approval_default_timeout_sec || 600, 30), 3600);
  let input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {};
  if (JSON.stringify(input).length > 8192) input = { truncated: JSON.stringify(input).slice(0, 8000) };
  const payload = { approval_id: id, task_id: t.task_id, tool_name: String(body.tool_name || '').slice(0, 100), tool_input: input, risk: body.risk || 'medium', timeout_sec: timeout, on_timeout: 'deny' };
  if (body.reason) payload.reason = String(body.reason).slice(0, 1000);
  const errs = check('envelope', 'approvalRequest', payload);
  if (errs) throw new AipError('E_VALIDATION', 'invalid approval', { errors: errs });
  ctx.tx(() => {
    ctx.run("INSERT INTO approvals(approval_id,task_id,tool_name,tool_input,reason,risk,state,expires_at,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
      id, t.task_id, payload.tool_name, JSON.stringify(input), payload.reason || null, payload.risk, ctx.iso(ctx.now() + timeout * 1000), ctx.iso());
    ctx.run("UPDATE tasks SET state='waiting_approval', updated_at=? WHERE task_id=? AND state IN ('claimed','running')", ctx.iso(), t.task_id);
  });
  const env = JSON.parse(t.envelope);
  const on = (env.payload.notify && env.payload.notify.on) || ['approval', 'result'];
  if (on.includes('approval')) notice(ctx, env.from, 'APPROVAL_REQUESTED', `「${t.title}」在 ${t.assigned_node} 要求核准 ${payload.tool_name}，請到 Dashboard 審核（${M.duration(timeout)}內未處理將自動拒絕）`, { task_id: t.task_id, thread_id: t.thread_id, ref_id: id });
  ctx.event('approval.request', payload, { task_id: t.task_id, thread_id: t.thread_id, trace_id: t.trace_id, node_id: t.assigned_node });
  return { approval_id: id, expires_at: ctx.iso(ctx.now() + timeout * 1000) };
}

function approvalView(a) {
  return Object.assign({}, a, { tool_input: JSON.parse(a.tool_input), updated_input: a.updated_input ? JSON.parse(a.updated_input) : null });
}

async function waitApproval(ctx, auth, id, timeoutSec) {
  const deadline = ctx.now() + Math.min(Math.max(Number(timeoutSec) || 0, 0), 50) * 1000;
  for (;;) {
    const a = ctx.one('SELECT * FROM approvals WHERE approval_id=?', id);
    if (!a) throw new AipError('E_NOT_FOUND', 'approval ' + id);
    if (auth.kind === 'task' && auth.task_id !== a.task_id) throw new AipError('E_FORBIDDEN');
    if (a.state !== 'pending' || ctx.now() >= deadline) {
      const r = { state: a.state };
      if (a.state !== 'pending') r.decision = a.state === 'expired' ? 'expired' : a.state;
      if (a.note) r.note = a.note;
      if (a.updated_input) r.updated_input = JSON.parse(a.updated_input);
      return r;
    }
    await waitEvent(ctx.bus, 'approval:' + id, Math.min(deadline - ctx.now(), 5000));
  }
}

function decide(ctx, auth, id, body, by) {
  const decision = body && body.decision;
  if (!['allow', 'deny', 'expired'].includes(decision)) throw new AipError('E_VALIDATION', 'decision must be allow or deny');
  ctx.tx(() => {
    const a = ctx.one('SELECT * FROM approvals WHERE approval_id=?', id);
    if (!a) throw new AipError('E_NOT_FOUND', 'approval ' + id);
    if (a.state !== 'pending') throw new AipError('E_CONFLICT', 'approval already ' + a.state);
    ctx.run('UPDATE approvals SET state=?, decided_by=?, note=?, updated_input=?, decided_at=? WHERE approval_id=?',
      decision, by || auth.token_id, (body.note || '').slice(0, 1000) || null, body.updated_input ? JSON.stringify(body.updated_input) : null, ctx.iso(), id);
    const pending = ctx.one("SELECT COUNT(*) AS c FROM approvals WHERE task_id=? AND state='pending'", a.task_id).c;
    if (!pending) ctx.run("UPDATE tasks SET state='running', updated_at=? WHERE task_id=? AND state='waiting_approval'", ctx.iso(), a.task_id);
    const t = taskRow(ctx, a.task_id);
    ctx.event('approval.decision', { approval_id: id, decision, note: body.note || null }, { task_id: a.task_id, thread_id: t.thread_id, trace_id: t.trace_id, actor: by || auth.token_id });
  });
  ctx.bus.emit('approval:' + id);
  return approvalView(ctx.one('SELECT * FROM approvals WHERE approval_id=?', id));
}

function listApprovals(ctx, q = {}) {
  const rows = q.state ? ctx.all('SELECT * FROM approvals WHERE state=? ORDER BY created_at DESC LIMIT 200', q.state) : ctx.all('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200');
  return { items: rows.map((a) => Object.assign(approvalView(a), { task: (() => { const t = ctx.one('SELECT title, assigned_node, from_node, from_agent FROM tasks WHERE task_id=?', a.task_id); return t; })() })) };
}

module.exports = {
  createTask, claim, renewLease, progress, submitResult, cancel, getTask, waitTask, listTasks, stuck, finish, runThen,
  sendMessage, inbox, ack, summary, createApproval, waitApproval, decide, listApprovals, notice, TERMINAL, ACTIVE, waitEvent, render,
};
