'use strict';
// Node lifecycle: enrollment, approval/state changes, heartbeat, metadata (versioned), history.
const crypto = require('node:crypto');
const { AipError } = require('../common/errors');
const { check } = require('../common/schemas');
const { ulid } = require('../common/ulid');
const C = require('./core');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function enrollmentCode() {
  const bytes = crypto.randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 16; i++) { s = B32[Number(bits & 31n)] + s; bits >>= 5n; }
  return 'ape_' + s.match(/.{4}/g).join('-');
}

function validate(def, data) {
  const errs = check('api', def, data);
  if (errs) throw new AipError('E_VALIDATION', `invalid ${def}`, { errors: errs });
}

function metaColumns(meta) {
  return {
    display_name: meta.display_name, description: meta.description ?? null, roles: JSON.stringify(meta.roles || []),
    labels: JSON.stringify(meta.labels || {}), power: meta.power || 'desktop',
    presence_override: meta.presence ? JSON.stringify(meta.presence) : null, owner: meta.owner ?? null, notes: meta.notes ?? null,
  };
}

function saveMeta(ctx, nodeId, meta, version, by, note) {
  const c = metaColumns(meta);
  ctx.run(`UPDATE nodes SET display_name=?,description=?,roles=?,labels=?,power=?,presence_override=?,owner=?,notes=?,
           meta_version=?,meta_updated_at=?,meta_updated_by=? WHERE node_id=?`,
  c.display_name, c.description, c.roles, c.labels, c.power, c.presence_override, c.owner, c.notes, version, ctx.iso(), by, nodeId);
  ctx.run('INSERT INTO node_meta_history(node_id,meta_version,meta,change_note,changed_by,changed_at) VALUES(?,?,?,?,?,?)',
    nodeId, version, JSON.stringify(meta), note || null, by, ctx.iso());
}

// ---------- enrollments (admin) ----------
function createEnrollment(ctx, auth, body) {
  validate('enrollmentCreate', body);
  const e = ctx.cfg.enrollment || {};
  const ttl = Math.min(body.ttl_sec || e.default_ttl_sec || 86400, e.max_ttl_sec || 604800);
  const code = enrollmentCode();
  const id = 'enr_' + ulid();
  const expires = ctx.iso(ctx.now() + ttl * 1000);
  ctx.run('INSERT INTO enrollments(enrollment_id,code_hash,bound_node_id,preset,auto_approve,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, C.hash(code), body.node_id || null, JSON.stringify(body.preset || {}), body.auto_approve ? 1 : 0, expires, auth.token_id, ctx.iso());
  ctx.event('enrollment.created', { enrollment_id: id, node_id: body.node_id || null, expires_at: expires }, { actor: auth.token_id });
  const hub = ctx.cfg.public_base_url;
  const cmd = `aipagerctl join --hub ${hub} --code ${code}` + (body.node_id ? ` --node-id ${body.node_id}` : '');
  return { enrollment_id: id, code, expires_at: expires, join_commands: { windows: cmd, macos: cmd, linux: cmd } };
}

function listEnrollments(ctx) {
  return ctx.all('SELECT enrollment_id,bound_node_id,preset,auto_approve,expires_at,used_at,used_by_node,revoked_at,created_at FROM enrollments ORDER BY created_at DESC LIMIT 200')
    .map((r) => Object.assign(r, { preset: JSON.parse(r.preset), auto_approve: !!r.auto_approve,
      status: r.revoked_at ? 'revoked' : r.used_at ? 'used' : Date.parse(r.expires_at) < ctx.now() ? 'expired' : 'open' }));
}

function revokeEnrollment(ctx, id) {
  const r = ctx.run('UPDATE enrollments SET revoked_at=? WHERE enrollment_id=? AND used_at IS NULL AND revoked_at IS NULL', ctx.iso(), id);
  if (!r.changes) throw new AipError('E_NOT_FOUND', 'no open enrollment ' + id);
}

// ---------- enroll (new machine) ----------
function enroll(ctx, body, ip) {
  validate('enrollRequest', body);
  return ctx.tx(() => {
    const en = ctx.one('SELECT * FROM enrollments WHERE code_hash=?', C.hash(String(body.code).trim().toUpperCase().replace(/^APE_/, 'ape_')));
    if (!en || en.used_at || en.revoked_at || Date.parse(en.expires_at) < ctx.now()) throw new AipError('E_ENROLL_INVALID');
    if (en.bound_node_id && en.bound_node_id !== body.node_id) throw new AipError('E_ENROLL_INVALID', 'code is bound to another node_id', { bound_node_id: en.bound_node_id });
    const existing = C.getNode(ctx, body.node_id);
    const preset = JSON.parse(en.preset);
    let state;
    let meta;
    let version;
    if (existing) {
      if (en.bound_node_id !== body.node_id) throw new AipError('E_NODE_EXISTS', null, { node_id: body.node_id });
      // Reinstall of the same machine: keep metadata, revoke old tokens, bump version.
      ctx.run('UPDATE tokens SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL', ctx.iso(), body.node_id);
      meta = Object.assign({}, existing.meta, preset);
      version = existing.meta_version + 1;
      state = existing.state === 'retired' ? 'pending' : existing.state;
      ctx.run('UPDATE nodes SET state=? WHERE node_id=?', state, body.node_id);
      saveMeta(ctx, body.node_id, meta, version, 'enroll:' + en.enrollment_id, 'reinstall');
    } else {
      const sug = body.suggested || {};
      meta = Object.assign({ display_name: body.node_id, roles: [], labels: {}, power: (ctx.cfg.enrollment || {}).default_power || 'desktop' }, sug, preset);
      meta.labels = Object.assign({}, sug.labels || {}, preset.labels || {});
      validate('nodeMeta', meta);
      const requireApproval = (ctx.cfg.enrollment || {}).require_approval !== false;
      state = en.auto_approve || !requireApproval ? 'active' : 'pending';
      version = 1;
      const c = metaColumns(meta);
      ctx.run(`INSERT INTO nodes(node_id,state,display_name,description,roles,labels,power,presence_override,owner,notes,meta_version,meta_updated_at,
               meta_updated_by,os,arch,facts,enrolled_via,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`,
      body.node_id, state, c.display_name, c.description, c.roles, c.labels, c.power, c.presence_override, c.owner, c.notes,
      ctx.iso(), 'enroll:' + en.enrollment_id, body.facts.os, body.facts.arch, JSON.stringify(body.facts), en.enrollment_id, ctx.iso());
      ctx.run('INSERT INTO node_meta_history(node_id,meta_version,meta,change_note,changed_by,changed_at) VALUES(?,?,?,?,?,?)',
        body.node_id, 1, JSON.stringify(meta), 'enrolled', 'enroll:' + en.enrollment_id, ctx.iso());
    }
    ctx.run('UPDATE enrollments SET used_at=?, used_by_node=? WHERE enrollment_id=?', ctx.iso(), body.node_id, en.enrollment_id);
    const { token } = C.issueToken(ctx, { kind: 'node', node_id: body.node_id, label: 'enroll ' + en.enrollment_id });
    ctx.event('node.enrolled', { node_id: body.node_id, state, reinstall: !!existing, ip, facts: body.facts }, { node_id: body.node_id });
    return { node_id: body.node_id, node_token: token, state, meta, meta_version: version };
  });
}

// ---------- heartbeat ----------
function heartbeat(ctx, auth, body) {
  validate('heartbeatRequest', body);
  const n = C.getNode(ctx, auth.node_id);
  const f = body.facts;
  const nowIso = ctx.iso();
  ctx.run(`UPDATE nodes SET os=?,arch=?,facts=?,profiles=?,profiles_error=?,max_concurrent=?,running=?,last_seen=?${body.resumed_from_sleep_sec ? ',last_wake_at=?' : ''} WHERE node_id=?`,
    ...[f.os, f.arch, JSON.stringify(f), JSON.stringify(body.profiles), body.profiles_error || null, body.capacity.max_concurrent, body.capacity.running, nowIso]
      .concat(body.resumed_from_sleep_sec ? [nowIso] : [], [auth.node_id]));
  if (body.resumed_from_sleep_sec) ctx.event('node.wake', { slept_sec: body.resumed_from_sleep_sec }, { node_id: auth.node_id });
  if (n.profiles_error !== (body.profiles_error || null)) ctx.event('node.profiles', { profiles_error: body.profiles_error || null }, { node_id: auth.node_id });
  // Presence transition to online is applied immediately (the sweeper handles the other direction).
  require('./sweeper').updatePresence(ctx, C.getNode(ctx, auth.node_id));
  const cancels = ctx.all("SELECT task_id FROM tasks WHERE assigned_node=? AND cancel_requested=1 AND state IN ('claimed','running','waiting_approval')", auth.node_id).map((r) => r.task_id);
  const fresh = C.getNode(ctx, auth.node_id);
  const res = { server_time: nowIso, state: fresh.state, meta_version: fresh.meta_version, presence_settings: C.presenceOf(ctx, fresh).settings, cancel_requests: cancels };
  if (body.meta_version !== fresh.meta_version) res.meta = fresh.meta;
  return res;
}

// ---------- metadata ----------
function patchMeta(ctx, auth, nodeId, ifMatch, patch) {
  validate('nodeMetaPatch', patch);
  return ctx.tx(() => {
    const n = C.getNode(ctx, nodeId);
    if (!n || n.state === 'retired') throw new AipError('E_NOT_FOUND', 'node ' + nodeId);
    if (String(ifMatch) !== String(n.meta_version)) throw new AipError('E_META_CONFLICT', null, { current_meta_version: n.meta_version });
    const meta = JSON.parse(JSON.stringify(n.meta));
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'labels') {
        meta.labels = meta.labels || {};
        for (const [lk, lv] of Object.entries(v)) { if (lv === null) delete meta.labels[lk]; else meta.labels[lk] = lv; }
      } else if (v === null) delete meta[k];
      else meta[k] = v;
    }
    validate('nodeMeta', meta);
    saveMeta(ctx, nodeId, meta, n.meta_version + 1, auth.token_id, patch.notes !== undefined && Object.keys(patch).length === 1 ? 'notes' : null);
    ctx.event('node.meta', { meta_version: n.meta_version + 1, patch }, { node_id: nodeId, actor: auth.token_id });
    ctx.bus.emit('task-available');
    return C.nodeView(ctx, C.getNode(ctx, nodeId), { detail: true });
  });
}

const TRANSITIONS = {
  pending: ['active', 'disabled', 'retired'], active: ['draining', 'disabled', 'retired'],
  draining: ['active', 'disabled', 'retired'], disabled: ['active', 'retired'], retired: [],
};

function changeState(ctx, auth, nodeId, body) {
  validate('nodeStateChange', body);
  return ctx.tx(() => {
    const n = C.getNode(ctx, nodeId);
    if (!n) throw new AipError('E_NOT_FOUND', 'node ' + nodeId);
    if (n.state === body.state) return C.nodeView(ctx, n, { detail: true });
    if (!TRANSITIONS[n.state].includes(body.state)) throw new AipError('E_CONFLICT', `${n.state} -> ${body.state} not allowed`);
    ctx.run('UPDATE nodes SET state=? WHERE node_id=?', body.state, nodeId);
    if (body.state === 'retired') ctx.run('UPDATE tokens SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL', ctx.iso(), nodeId);
    ctx.event('node.state', { from: n.state, to: body.state, reason: body.reason || null }, { node_id: nodeId, actor: auth.token_id });
    if (body.state === 'active') ctx.bus.emit('task-available');
    return C.nodeView(ctx, C.getNode(ctx, nodeId), { detail: true });
  });
}

function history(ctx, nodeId) {
  if (!C.getNode(ctx, nodeId)) throw new AipError('E_NOT_FOUND', 'node ' + nodeId);
  return {
    meta: ctx.all('SELECT meta_version,meta,change_note,changed_by,changed_at FROM node_meta_history WHERE node_id=? ORDER BY meta_version DESC', nodeId)
      .map((r) => Object.assign(r, { meta: JSON.parse(r.meta) })),
    presence: ctx.all("SELECT kind,data,created_at FROM events WHERE node_id=? AND kind IN ('node.presence','node.wake','node.state','node.enrolled') ORDER BY event_seq DESC LIMIT 200", nodeId)
      .map((r) => Object.assign(r, { data: JSON.parse(r.data) })),
  };
}

function rollback(ctx, auth, nodeId, toVersion) {
  return ctx.tx(() => {
    const n = C.getNode(ctx, nodeId);
    if (!n) throw new AipError('E_NOT_FOUND', 'node ' + nodeId);
    const h = ctx.one('SELECT meta FROM node_meta_history WHERE node_id=? AND meta_version=?', nodeId, Number(toVersion));
    if (!h) throw new AipError('E_NOT_FOUND', `meta version ${toVersion}`);
    saveMeta(ctx, nodeId, JSON.parse(h.meta), n.meta_version + 1, auth.token_id, `rollback to ${toVersion}`);
    ctx.event('node.meta', { meta_version: n.meta_version + 1, rollback_to: Number(toVersion) }, { node_id: nodeId, actor: auth.token_id });
    ctx.bus.emit('task-available');
    return C.nodeView(ctx, C.getNode(ctx, nodeId), { detail: true });
  });
}

function listNodes(ctx, auth, q = {}) {
  let nodes = auth.kind === 'admin' && q.include_retired ? ctx.all('SELECT * FROM nodes ORDER BY node_id').map(C.parseNode) : C.allNodes(ctx);
  let views = nodes.map((n) => Object.assign(C.nodeView(ctx, n), { _n: n }));
  if (q.presence) views = views.filter((v) => v.presence === q.presence);
  if (q.state) views = views.filter((v) => v.state === q.state);
  if (q.role) views = views.filter((v) => v.meta.roles.includes(q.role));
  if (q.os) views = views.filter((v) => v._n.os === q.os);
  if (q.label) {
    const [k, val] = String(q.label).split('=');
    views = views.filter((v) => (val === undefined ? k in v.meta.labels : v.meta.labels[k] === val));
  }
  return views.map((v) => { delete v._n; return v; });
}

module.exports = { createEnrollment, listEnrollments, revokeEnrollment, enroll, heartbeat, patchMeta, changeState, history, rollback, listNodes, enrollmentCode };
