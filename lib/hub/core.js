'use strict';
// Hub core: database, clock, event bus, token handling, shared views. No HTTP here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { APP_ROOT } = require('../common/paths');
const { ulid } = require('../common/ulid');
const { AipError } = require('../common/errors');
const P = require('../../spec/reference/presence');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(APP_ROOT, 'spec/sql/hub-schema.sql'), 'utf8'));
  return db;
}

function createContext({ cfg, log, clock }) {
  const db = openDb(path.join(cfg.data_dir, 'aipager.db'));
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const now = clock || (() => Date.now());
  const iso = (ms = now()) => new Date(ms).toISOString();
  const ctx = { cfg, log, db, bus, now, iso };

  ctx.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  };
  ctx.one = (sql, ...a) => db.prepare(sql).get(...a);
  ctx.all = (sql, ...a) => db.prepare(sql).all(...a);
  ctx.run = (sql, ...a) => db.prepare(sql).run(...a);

  // Append-only event log + live notification (SSE, long-polls).
  ctx.event = (kind, data, refs = {}) => {
    const created = iso();
    const r = ctx.run('INSERT INTO events(kind,trace_id,thread_id,task_id,node_id,actor,data,created_at) VALUES(?,?,?,?,?,?,?,?)',
      kind, refs.trace_id || null, refs.thread_id || null, refs.task_id || null, refs.node_id || null, refs.actor || null, JSON.stringify(data || {}), created);
    const ev = { event_seq: Number(r.lastInsertRowid), kind, data, created_at: created, ...refs };
    bus.emit('event', ev);
    return ev;
  };

  ctx.presenceDefaults = cfg.presence_defaults || P.DEFAULT_PRESENCE;
  return ctx;
}

// ---------- tokens ----------
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
function newToken(prefix) { return prefix + crypto.randomBytes(32).toString('base64url'); }

function issueToken(ctx, { kind, node_id = null, task_id = null, label = null, expires_at = null }) {
  const prefix = { admin: 'apa_', node: 'apn_', task: 'apt_' }[kind];
  const token = newToken(prefix);
  const token_id = 'tok_' + ulid();
  ctx.run('INSERT INTO tokens(token_id,kind,node_id,task_id,token_hash,label,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
    token_id, kind, node_id, task_id, hash(token), label, expires_at, ctx.iso());
  return { token, token_id };
}

// Resolve "Authorization: Bearer <token>" into an auth object, or throw E_AUTH.
function authenticate(ctx, header, agentHeader) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) throw new AipError('E_AUTH', 'missing bearer token');
  const row = ctx.one('SELECT * FROM tokens WHERE token_hash=?', hash(m[1]));
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) < ctx.now())) throw new AipError('E_AUTH');
  const auth = { kind: row.kind, token_id: row.token_id, node_id: row.node_id, task_id: row.task_id };
  if (row.kind === 'node' || row.kind === 'task') {
    const node = ctx.one('SELECT state FROM nodes WHERE node_id=?', row.node_id);
    if (!node || node.state === 'retired') throw new AipError('E_AUTH', 'node retired');
    auth.node_state = node.state;
  }
  if (row.kind === 'node') auth.agent = /^[a-z0-9][a-z0-9-]{0,31}$/.test(agentHeader || '') ? agentHeader : 'main';
  if (row.kind === 'task') auth.agent = 'worker';
  return auth;
}

function requireKind(auth, ...kinds) {
  if (!kinds.includes(auth.kind)) throw new AipError('E_FORBIDDEN', `requires ${kinds.join(' or ')} token`);
}

// ---------- node views ----------
function parseNode(row) {
  if (!row) return null;
  const meta = { display_name: row.display_name, roles: JSON.parse(row.roles), labels: JSON.parse(row.labels), power: row.power };
  if (row.description) meta.description = row.description;
  if (row.presence_override) meta.presence = JSON.parse(row.presence_override);
  if (row.owner) meta.owner = row.owner;
  if (row.notes) meta.notes = row.notes;
  return {
    node_id: row.node_id, state: row.state, meta, meta_version: row.meta_version,
    os: row.os, arch: row.arch, facts: JSON.parse(row.facts), profiles: JSON.parse(row.profiles), profiles_error: row.profiles_error,
    max_concurrent: row.max_concurrent, running: row.running, last_seen: row.last_seen, last_wake_at: row.last_wake_at,
    presence_cached: row.presence, presence_changed_at: row.presence_changed_at, created_at: row.created_at,
  };
}

function presenceOf(ctx, n) { return P.computePresence({ last_seen: n.last_seen, meta: n.meta }, ctx.now(), ctx.presenceDefaults); }

function onlineHours7d(ctx, n) {
  const since = ctx.now() - 7 * 86400000;
  const evs = ctx.all("SELECT data, created_at FROM events WHERE node_id=? AND kind='node.presence' AND created_at>=? ORDER BY event_seq", n.node_id, new Date(since).toISOString());
  const before = ctx.one("SELECT data FROM events WHERE node_id=? AND kind='node.presence' AND created_at<? ORDER BY event_seq DESC LIMIT 1", n.node_id, new Date(since).toISOString());
  let online = before ? JSON.parse(before.data).to === 'online' : false;
  let t = since;
  let total = 0;
  for (const e of evs) {
    const at = Date.parse(e.created_at);
    if (online) total += at - t;
    online = JSON.parse(e.data).to === 'online';
    t = at;
  }
  if (online) total += ctx.now() - t;
  return Math.round((total / 3600000) * 10) / 10;
}

function nodeView(ctx, n, { detail = false } = {}) {
  const p = presenceOf(ctx, n);
  const v = {
    node_id: n.node_id, state: n.state, presence: p.presence, last_seen: n.last_seen, silent_sec: p.silent_sec,
    last_wake_at: n.last_wake_at, presence_settings: p.settings, meta: n.meta, meta_version: n.meta_version,
    profiles: n.profiles, profiles_error: n.profiles_error || null, capacity: { max_concurrent: n.max_concurrent, running: n.running },
  };
  if (n.facts && n.facts.os) v.facts = n.facts;
  if (detail) v.online_hours_7d = Math.min(168, onlineHours7d(ctx, n));
  return v;
}

function getNode(ctx, id) { return parseNode(ctx.one('SELECT * FROM nodes WHERE node_id=?', id)); }
function allNodes(ctx) { return ctx.all("SELECT * FROM nodes WHERE state<>'retired' ORDER BY node_id").map(parseNode); }

function labelsMatch(nodeLabels, required) {
  for (const [k, v] of Object.entries(required || {})) {
    if (v === '*') { if (!(k in (nodeLabels || {}))) return false; } else if ((nodeLabels || {})[k] !== v) return false;
  }
  return true;
}

// true / false / null (unknown because the node never reported facts)
function meetsRequires(n, req) {
  if (!req) return true;
  if ((req.os || req.arch) && !n.os) return null;
  if (req.os && !req.os.includes(n.os)) return false;
  if (req.arch && !req.arch.includes(n.arch)) return false;
  if (req.labels && !labelsMatch(n.meta.labels, req.labels)) return false;
  return true;
}

module.exports = {
  createContext, issueToken, authenticate, requireKind, hash, newToken,
  parseNode, nodeView, presenceOf, getNode, allNodes, meetsRequires, labelsMatch,
};
