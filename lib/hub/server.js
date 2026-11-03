'use strict';
// HTTP layer (spec chapter 10). All business logic lives in nodes.js / tasks.js / sweeper.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const { AipError } = require('../common/errors');
const M = require('../common/messages');
const { APP_ROOT } = require('../common/paths');
const { traceId } = require('../common/ulid');
const C = require('./core');
const N = require('./nodes');
const T = require('./tasks');
const S = require('./sweeper');

const VERSION = require('../../package.json').version;

function buildServer(ctx) {
  // forceCloseConnections: SSE and keep-alive sockets must not block shutdown (systemd stop timeout is 30 s).
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false, forceCloseConnections: true });
  const blobLimit = (ctx.cfg.limits?.max_blob_mb || 50) * 1024 * 1024;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: blobLimit }, (req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    req.traceId = traceId();
    req.started = Date.now();
    req.lang = M.lang(req.headers['accept-language']);
    reply.header('X-Trace-Id', req.traceId);
    if (req.headers['x-request-id']) reply.header('X-Request-Id', String(req.headers['x-request-id']).slice(0, 100));
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/ui/')) return;
    const lvl = reply.statusCode >= 500 ? 'error' : 'info';
    ctx.log[lvl]('http.request', `${req.method} ${req.routeOptions.url || req.url} ${reply.statusCode}`,
      { ms: Date.now() - req.started, status: reply.statusCode, ip: req.ip }, { trace_id: req.traceId, node: req.auth && req.auth.node_id });
  });

  app.setErrorHandler((err, req, reply) => {
    let e = err;
    if (!(err instanceof AipError)) {
      if (err.validation) e = new AipError('E_VALIDATION', err.message);
      else if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new AipError('E_PAYLOAD_TOO_LARGE');
      else if (err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) e = new AipError('E_VALIDATION', err.message);
      else { ctx.log.error('http.error', err.message, { stack: err.stack }, { trace_id: req.traceId }); e = new AipError('E_INTERNAL'); }
    }
    const body = Object.assign({ error: { code: e.code, message: e.message && e.message !== e.code ? e.message : M.errorText(e.code, req.lang), trace_id: req.traceId } }, e.extra || {});
    if (e.detail) body.error.detail = e.detail;
    if (e.code === 'E_RATE_LIMIT') reply.header('Retry-After', String((e.detail && e.detail.retry_after_sec) || 60));
    reply.code(e.status).send(body);
  });

  const auth = (...kinds) => async (req) => {
    req.auth = C.authenticate(ctx, req.headers.authorization, req.headers['x-aipager-agent']);
    if (kinds.length) C.requireKind(req.auth, ...kinds);
  };
  const r = (method, url, kinds, handler) => app.route({ method, url: '/api/v1' + url, preHandler: kinds ? auth(...kinds) : undefined, handler });
  const send = (reply, res) => reply.code(res.status).send(res.body);

  // ---------- health ----------
  r('GET', '/health', null, async () => ({ ok: true, version: VERSION, protocol: '1.0', time: ctx.iso() }));

  // ---------- nodes & enrollment ----------
  const enrollHits = new Map();
  r('POST', '/enroll', null, async (req) => {
    const per = ctx.cfg.enrollment?.rate_per_ip_per_min || 5;
    const now = Date.now();
    const hits = (enrollHits.get(req.ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= per) throw new AipError('E_RATE_LIMIT', null, { retry_after_sec: 60 });
    hits.push(now);
    enrollHits.set(req.ip, hits);
    return N.enroll(ctx, req.body, req.ip);
  });
  r('POST', '/nodes/heartbeat', ['node'], async (req) => N.heartbeat(ctx, req.auth, req.body));
  r('GET', '/nodes', ['node', 'task', 'admin'], async (req) => ({ items: N.listNodes(ctx, req.auth, req.query) }));
  r('GET', '/nodes/self', ['node'], async (req) => C.nodeView(ctx, C.getNode(ctx, req.auth.node_id), { detail: true }));
  r('GET', '/nodes/:id', ['node', 'task', 'admin'], async (req) => {
    const n = C.getNode(ctx, req.params.id);
    if (!n || (n.state === 'retired' && req.auth.kind !== 'admin')) throw new AipError('E_NOT_FOUND', 'node ' + req.params.id);
    return C.nodeView(ctx, n, { detail: true });
  });
  r('PATCH', '/nodes/:id/meta', ['admin'], async (req) => {
    if (req.headers['if-match'] === undefined) throw new AipError('E_VALIDATION', 'If-Match header (meta_version) is required');
    return N.patchMeta(ctx, req.auth, req.params.id, String(req.headers['if-match']).replace(/"/g, ''), req.body);
  });
  r('POST', '/nodes/:id/state', ['admin'], async (req) => N.changeState(ctx, req.auth, req.params.id, req.body));
  r('GET', '/nodes/:id/history', ['admin'], async (req) => N.history(ctx, req.params.id));
  r('POST', '/nodes/:id/meta/rollback', ['admin'], async (req) => N.rollback(ctx, req.auth, req.params.id, req.body && req.body.to_version));
  r('POST', '/admin/enrollments', ['admin'], async (req, reply) => reply.code(201).send(N.createEnrollment(ctx, req.auth, req.body || {})));
  r('GET', '/admin/enrollments', ['admin'], async () => ({ items: N.listEnrollments(ctx) }));
  r('DELETE', '/admin/enrollments/:id', ['admin'], async (req) => { N.revokeEnrollment(ctx, req.params.id); return { ok: true }; });

  // ---------- tasks ----------
  r('POST', '/tasks', ['node', 'task', 'admin'], async (req, reply) => send(reply, T.createTask(ctx, req.auth, req.body, req.lang)));
  r('POST', '/tasks/claim', ['node'], async (req, reply) => {
    const res = await T.claim(ctx, req.auth, req.body || {}, req.query.wait);
    if (!res) return reply.code(204).send();
    return res;
  });
  r('POST', '/tasks/:id/lease', ['node'], async (req) => T.renewLease(ctx, req.auth, req.params.id, req.body));
  r('POST', '/tasks/:id/progress', ['node', 'task'], async (req, reply) => reply.code(202).send(T.progress(ctx, req.auth, req.params.id, req.body)));
  r('POST', '/tasks/:id/result', ['node'], async (req) => T.submitResult(ctx, req.auth, req.params.id, req.headers['x-aipager-lease'], req.body));
  r('POST', '/tasks/:id/cancel', ['node', 'task', 'admin'], async (req, reply) => reply.code(202).send(T.cancel(ctx, req.auth, req.params.id, req.body)));
  r('GET', '/tasks', ['node', 'admin'], async (req) => T.listTasks(ctx, req.auth, Object.assign({}, req.query, { stuck: req.query.stuck === '1' || req.query.stuck === 'true' })));
  r('GET', '/tasks/:id', ['node', 'task', 'admin'], async (req) => T.getTask(ctx, req.auth, req.params.id, { events: req.query.events === '1' }));
  r('GET', '/tasks/:id/wait', ['node', 'task', 'admin'], async (req) => T.waitTask(ctx, req.auth, req.params.id, req.query.timeout || 45));
  r('GET', '/tasks/:id/events', ['node', 'task', 'admin'], async (req) => ({
    items: ctx.all('SELECT seq,phase,message,data,created_at FROM task_events WHERE task_id=? AND seq>? ORDER BY seq', req.params.id, Number(req.query.after_seq) || 0)
      .map((e) => Object.assign(e, { data: e.data ? JSON.parse(e.data) : null })),
  }));

  // ---------- messages ----------
  r('POST', '/messages', ['node', 'task', 'admin'], async (req, reply) => send(reply, T.sendMessage(ctx, req.auth, req.body, req.lang)));
  const agentOf = (req) => { if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(req.params.agent)) throw new AipError('E_VALIDATION', 'bad agent'); return req.params.agent; };
  r('GET', '/mailboxes/:agent/inbox', ['node'], async (req) => T.inbox(ctx, req.auth, agentOf(req), req.query));
  r('POST', '/mailboxes/:agent/ack', ['node'], async (req) => T.ack(ctx, req.auth, agentOf(req), req.body && req.body.ids));
  r('GET', '/mailboxes/:agent/summary', ['node'], async (req) => T.summary(ctx, req.auth, agentOf(req)));

  // ---------- approvals ----------
  r('POST', '/approvals', ['task'], async (req, reply) => reply.code(201).send(T.createApproval(ctx, req.auth, req.body || {})));
  r('GET', '/approvals/:id/wait', ['task', 'admin'], async (req) => T.waitApproval(ctx, req.auth, req.params.id, req.query.timeout || 50));
  r('GET', '/approvals', ['admin'], async (req) => T.listApprovals(ctx, req.query));
  r('POST', '/approvals/:id/decision', ['admin'], async (req) => T.decide(ctx, req.auth, req.params.id, req.body || {}));

  // ---------- blobs ----------
  const blobPath = (h) => path.join(ctx.cfg.data_dir, 'blobs', h.slice(0, 2), h.slice(2, 4), h);
  app.route({
    method: 'PUT', url: '/api/v1/blobs/:sha', preHandler: auth('node', 'task', 'admin'), bodyLimit: blobLimit,
    handler: async (req, reply) => {
      const h = String(req.params.sha);
      if (!/^[0-9a-f]{64}$/.test(h)) throw new AipError('E_VALIDATION', 'sha256 must be 64 hex chars');
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (crypto.createHash('sha256').update(buf).digest('hex') !== h) throw new AipError('E_VALIDATION', 'sha256 does not match content');
      const p = blobPath(h);
      if (fs.existsSync(p)) return reply.code(200).send({ sha256: h, size: buf.length, existed: true });
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p + '.tmp', buf);
      fs.renameSync(p + '.tmp', p);
      ctx.run('INSERT OR IGNORE INTO blobs(sha256,size,mime,created_at) VALUES(?,?,?,?)', h, buf.length, req.headers['x-aipager-mime'] || null, ctx.iso());
      return reply.code(201).send({ sha256: h, size: buf.length });
    },
  });
  app.route({
    method: ['GET', 'HEAD'], url: '/api/v1/blobs/:sha', preHandler: auth('node', 'task', 'admin'),
    handler: async (req, reply) => {
      const h = String(req.params.sha);
      const row = /^[0-9a-f]{64}$/.test(h) ? ctx.one('SELECT * FROM blobs WHERE sha256=?', h) : null;
      if (!row || !fs.existsSync(blobPath(h))) throw new AipError('E_NOT_FOUND', 'blob ' + h);
      ctx.run('UPDATE blobs SET last_access_at=? WHERE sha256=?', ctx.iso(), h);
      reply.header('Content-Type', row.mime || 'application/octet-stream').header('Content-Length', row.size);
      if (req.method === 'HEAD') return reply.send();
      return reply.send(fs.createReadStream(blobPath(h)));
    },
  });

  // ---------- threads, trace, SSE ----------
  r('GET', '/threads/:id', ['node', 'admin'], async (req) => ({
    tasks: ctx.all('SELECT envelope, state, created_at FROM tasks WHERE thread_id=? ORDER BY created_at', req.params.id).map((t) => Object.assign(JSON.parse(t.envelope), { state: t.state })),
    messages: ctx.all('SELECT envelope FROM messages WHERE thread_id=? ORDER BY created_at', req.params.id).map((m) => JSON.parse(m.envelope)),
  }));
  r('GET', '/trace/:id', ['admin'], async (req) => ({ items: ctx.all('SELECT * FROM events WHERE trace_id=? ORDER BY event_seq', req.params.id).map((e) => Object.assign(e, { data: JSON.parse(e.data) })) }));
  r('GET', '/events/stream', ['admin'], async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Trace-Id': req.traceId });
    const write = (e) => res.write(`id: ${e.event_seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    const last = Number(req.headers['last-event-id'] || req.query.after || 0);
    if (last) for (const e of ctx.all('SELECT * FROM events WHERE event_seq>? ORDER BY event_seq LIMIT 500', last)) write(Object.assign(e, { data: JSON.parse(e.data) }));
    res.write(': connected\n\n');
    const onEv = (e) => write(e);
    ctx.bus.on('event', onEv);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.raw.on('close', () => { ctx.bus.off('event', onEv); clearInterval(ping); });
  });

  // ---------- admin ----------
  r('POST', '/admin/tokens', ['admin'], async (req, reply) => {
    const { token, token_id } = C.issueToken(ctx, { kind: 'admin', label: (req.body && req.body.label) || null });
    ctx.event('token.created', { token_id, kind: 'admin' }, { actor: req.auth.token_id });
    return reply.code(201).send({ token_id, token });
  });
  r('DELETE', '/admin/tokens/:id', ['admin'], async (req) => {
    const x = ctx.run('UPDATE tokens SET revoked_at=? WHERE token_id=? AND revoked_at IS NULL', ctx.iso(), req.params.id);
    if (!x.changes) throw new AipError('E_NOT_FOUND', 'token ' + req.params.id);
    return { ok: true };
  });
  r('POST', '/admin/backup', ['admin'], async () => S.backup(ctx));
  if (ctx.cfg.debug && ctx.cfg.debug.enable_debug_routes) {
    r('GET', '/debug/stats', ['admin'], async () => ({
      queued: ctx.one("SELECT COUNT(*) c FROM tasks WHERE state='queued'").c, active: ctx.one("SELECT COUNT(*) c FROM tasks WHERE state IN ('claimed','running','waiting_approval')").c,
      sse_listeners: ctx.bus.listenerCount('event'), db_bytes: fs.statSync(path.join(ctx.cfg.data_dir, 'aipager.db')).size,
    }));
  }

  // ---------- dashboard ----------
  if (!ctx.cfg.ui || ctx.cfg.ui.enabled !== false) {
    app.register(require('@fastify/static'), { root: path.join(APP_ROOT, 'ui'), prefix: '/ui/', cacheControl: false });
    app.get('/', async (req, reply) => reply.redirect('/ui/'));
  }
  return app;
}

module.exports = { buildServer };
