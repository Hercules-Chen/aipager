'use strict';
// Background jobs (spec chapter 03 relay-hub card, chapter 07 presence, chapter 09 state machine).
const fs = require('node:fs');
const path = require('node:path');
const C = require('./core');
const T = require('./tasks');
const M = require('../common/messages');
const P = require('../../spec/reference/presence');

// Recompute one node's presence; record transitions; mark/unmark running tasks whose node sleeps.
function updatePresence(ctx, n) {
  const p = C.presenceOf(ctx, n);
  if (p.presence === n.presence_cached) return p.presence;
  ctx.run('UPDATE nodes SET presence=?, presence_changed_at=? WHERE node_id=?', p.presence, ctx.iso(), n.node_id);
  ctx.event('node.presence', { from: n.presence_cached, to: p.presence, silent_sec: p.silent_sec }, { node_id: n.node_id });
  const active = ctx.all("SELECT * FROM tasks WHERE assigned_node=? AND state IN ('claimed','running','waiting_approval')", n.node_id);
  if (p.presence === 'online') {
    for (const t of active) {
      if (t.node_asleep_since) {
        const ms = Math.max(0, ctx.now() - Date.parse(t.node_asleep_since));
        ctx.run('UPDATE tasks SET node_asleep_since=NULL, asleep_ms_total=asleep_ms_total+? WHERE task_id=?', ms, t.task_id);
      }
    }
  } else if (n.presence_cached === 'online') {
    const since = n.last_seen || ctx.iso();
    for (const t of active) {
      ctx.run('UPDATE tasks SET node_asleep_since=? WHERE task_id=? AND node_asleep_since IS NULL', since, t.task_id);
      const env = JSON.parse(t.envelope);
      T.notice(ctx, env.from, 'NODE_ASLEEP_RUNNING', `執行「${t.title}」的機器 ${n.node_id}（${n.meta.display_name}）沒有回應，可能睡著了；任務最多保留 ${M.duration(p.settings.suspend_grace_sec)}`,
        { task_id: t.task_id, thread_id: t.thread_id, ref_id: t.task_id });
    }
    if (p.presence === 'offline' && p.settings.alert_on_offline) webhook(ctx, 'node.offline', { node_id: n.node_id, display_name: n.meta.display_name, silent_sec: p.silent_sec });
  }
  if (p.presence === 'offline' && n.presence_cached === 'asleep' && p.settings.alert_on_offline) webhook(ctx, 'node.offline', { node_id: n.node_id, display_name: n.meta.display_name, silent_sec: p.silent_sec });
  return p.presence;
}

function sweepPresence(ctx) {
  for (const n of C.allNodes(ctx)) updatePresence(ctx, n);
}

function sweepLeases(ctx) {
  const rows = ctx.all("SELECT * FROM tasks WHERE state IN ('claimed','running','waiting_approval') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?", ctx.iso());
  for (const t of rows) {
    const n = C.getNode(ctx, t.assigned_node);
    const expired = n ? P.leaseExpired({ expires_at: t.lease_expires_at }, { last_seen: n.last_seen, meta: n.meta }, ctx.now(), ctx.presenceDefaults) : true;
    if (!expired) continue;
    const asleep = n && C.presenceOf(ctx, n).presence !== 'online';
    ctx.tx(() => {
      const cur = ctx.one('SELECT * FROM tasks WHERE task_id=?', t.task_id);
      if (!cur || !T.ACTIVE.includes(cur.state) || cur.lease_id !== t.lease_id) return;
      ctx.run("UPDATE tokens SET revoked_at=? WHERE task_id=? AND kind='task' AND revoked_at IS NULL", ctx.iso(), t.task_id);
      if (cur.attempt < cur.max_attempts) {
        ctx.run("UPDATE tasks SET state='queued', assigned_node=NULL, lease_id=NULL, lease_expires_at=NULL, node_asleep_since=NULL, updated_at=? WHERE task_id=?", ctx.iso(), t.task_id);
        ctx.event('task.requeued', { reason: asleep ? 'node_asleep' : 'lease_expired', attempt: cur.attempt }, { task_id: t.task_id, thread_id: t.thread_id, trace_id: t.trace_id, node_id: t.assigned_node });
        ctx.bus.emit('task-available');
      } else {
        T.finish(ctx, cur, { task_id: t.task_id, status: 'failed', summary: asleep ? `執行機器 ${t.assigned_node} 睡著超過保留時間，任務判定失敗` : `執行機器 ${t.assigned_node} 失聯，租約過期`,
          error: { code: 'E_LEASE_LOST', message: 'lease expired', detail: { reason: asleep ? 'node_asleep' : 'lease_expired', node_id: t.assigned_node } } }, 'sweeper');
      }
    });
  }
}

function sweepTimeouts(ctx) {
  const grace = (ctx.cfg.lease?.run_timeout_grace_sec || 120) * 1000;
  for (const t of ctx.all("SELECT * FROM tasks WHERE state IN ('running','waiting_approval') AND started_at IS NOT NULL")) {
    const asleepNow = t.node_asleep_since ? ctx.now() - Date.parse(t.node_asleep_since) : 0;
    const awake = ctx.now() - Date.parse(t.started_at) - t.asleep_ms_total - asleepNow;
    if (awake > t.timeout_sec * 1000 + grace) {
      ctx.tx(() => T.finish(ctx, t, { task_id: t.task_id, status: 'failed', summary: `超過逾時 ${t.timeout_sec} 秒仍沒有結果（Hub 端保護）`, error: { code: 'E_TIMEOUT', message: 'hub timeout guard' } }, 'sweeper'));
    }
  }
  const force = (ctx.cfg.lease?.cancel_force_after_sec || 60) * 1000;
  for (const t of ctx.all("SELECT * FROM tasks WHERE cancel_requested=1 AND state IN ('claimed','running','waiting_approval') AND updated_at < ?", ctx.iso(ctx.now() - force))) {
    ctx.tx(() => T.finish(ctx, t, { task_id: t.task_id, status: 'cancelled', summary: 'Worker 未在時限內回報，Hub 強制取消', error: { code: 'E_CANCELLED', message: 'forced by hub' } }, 'sweeper'));
  }
  for (const t of ctx.all("SELECT * FROM tasks WHERE state='queued' AND expires_at IS NOT NULL AND expires_at < ?", ctx.iso())) {
    ctx.tx(() => T.finish(ctx, t, { task_id: t.task_id, status: 'expired', summary: `等到 ${t.expires_at} 仍沒有機器領取，任務已過期` }, 'sweeper'));
  }
  for (const a of ctx.all("SELECT approval_id FROM approvals WHERE state='pending' AND expires_at < ?", ctx.iso())) {
    try { T.decide(ctx, { token_id: 'sweeper' }, a.approval_id, { decision: 'expired', note: '審核逾時，自動拒絕' }, 'sweeper'); } catch { /* raced */ }
  }
}

function startupGrace(ctx) {
  const g = (ctx.cfg.lease?.startup_grace_sec || 120) * 1000;
  const r = ctx.run("UPDATE tasks SET lease_expires_at=? WHERE state IN ('claimed','running','waiting_approval') AND lease_expires_at IS NOT NULL", ctx.iso(ctx.now() + g));
  if (r.changes) ctx.log.info('hub.startup_grace', `extended ${r.changes} leases`, { grace_sec: g / 1000 });
}

function retention(ctx) {
  const r = ctx.cfg.retention || {};
  const cut = (d) => ctx.iso(ctx.now() - d * 86400000);
  ctx.run('DELETE FROM events WHERE created_at < ?', cut(r.events_days || 30));
  ctx.run('DELETE FROM task_events WHERE created_at < ?', cut(r.events_days || 30));
}

function backup(ctx) {
  const b = ctx.cfg.backup || {};
  const dir = b.dir || path.join(ctx.cfg.data_dir, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const name = `aipager-${new Date(ctx.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}.db`;
  const file = path.join(dir, name);
  ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const keep = b.keep || 14;
  const files = fs.readdirSync(dir).filter((f) => /^aipager-\d{8}T\d{6}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  ctx.event('hub.backup', { file: name });
  return { file: name, dir };
}

function webhook(ctx, on, data) {
  for (const w of ctx.cfg.webhooks || []) {
    if (!(w.on || []).includes(on)) continue;
    const text = `[AIPager] ${on} ${JSON.stringify(data)}`;
    const opts = w.format === 'ntfy' ? { method: 'POST', body: text, headers: { Title: `AIPager ${on}` } }
      : { method: 'POST', body: JSON.stringify({ on, data, text }), headers: { 'Content-Type': 'application/json' } };
    fetch(w.url, Object.assign(opts, { signal: AbortSignal.timeout(5000) })).catch((e) => ctx.log.warn('webhook.failed', e.message, { url: w.url, on }));
  }
}

function sweepOnce(ctx) {
  for (const [name, fn] of [['presence', sweepPresence], ['leases', sweepLeases], ['timeouts', sweepTimeouts]]) {
    try { fn(ctx); } catch (e) { ctx.log.error('sweeper.' + name, e.message, { stack: e.stack }); }
  }
}

function start(ctx, intervalMs = 5000) {
  startupGrace(ctx);
  let lastDaily = 0;
  const timer = setInterval(() => {
    sweepOnce(ctx);
    if (ctx.now() - lastDaily > 86400000) {
      lastDaily = ctx.now();
      try { retention(ctx); } catch (e) { ctx.log.error('sweeper.retention', e.message); }
      if (ctx.cfg.backup && ctx.cfg.backup.daily !== false) { try { backup(ctx); } catch (e) { ctx.log.error('sweeper.backup', e.message); } }
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, sweepOnce, updatePresence, backup, webhook, startupGrace };
