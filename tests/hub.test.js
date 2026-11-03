'use strict';
// Hub integration tests over real HTTP (node --test). Maps to test plan items in comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestHub, addNode, taskBody } = require('./helpers');

const W = (node) => ({ node, agent: 'worker' });
const expectErr = async (p, code) => {
  try { await p; } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  assert.fail('expected error ' + code);
};

test('enrollment: pending until approved, code single-use, node_id taken, rate limit (T23, T24)', async () => {
  const hub = await startTestHub();
  try {
    const en = await hub.admin.post('/admin/enrollments', { preset: { display_name: '測試機', roles: ['tester'], power: 'laptop' } });
    assert.match(en.data.code, /^ape_[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const f = { os: 'macos', arch: 'arm64', hostname: 'h', worker_version: '0.4.0' };
    const r = await hub.client().post('/enroll', { code: en.data.code.toLowerCase(), node_id: 'mac-1', facts: f, suggested: { labels: { battery: 'yes' } } });
    assert.equal(r.data.state, 'pending');
    assert.equal(r.data.meta.display_name, '測試機');
    assert.deepEqual(r.data.meta.labels, { battery: 'yes' });
    await expectErr(hub.client().post('/enroll', { code: en.data.code, node_id: 'mac-2', facts: f }), 'E_ENROLL_INVALID');
    const en2 = await hub.admin.post('/admin/enrollments', {});
    await expectErr(hub.client().post('/enroll', { code: en2.data.code, node_id: 'mac-1', facts: f }), 'E_NODE_EXISTS');
    // pending node: heartbeat ok, cannot claim, cannot send
    const c = hub.client(r.data.node_token);
    const hb = await c.post('/nodes/heartbeat', { facts: f, profiles: [{ name: 'echo' }], capacity: { max_concurrent: 1, running: 0 }, meta_version: 0 });
    assert.equal(hb.data.state, 'pending');
    assert.ok(hb.data.meta, 'meta sent because version differs');
    const claim = await c.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    assert.equal(claim.status, 204);
    await expectErr(c.post('/tasks', taskBody(W('mac-1'))), 'E_NODE_NOT_ACTIVE');
    await hub.admin.post('/nodes/mac-1/state', { state: 'active' });
    const view = await hub.admin.get('/nodes/mac-1');
    assert.equal(view.data.state, 'active');
    assert.equal(view.data.presence, 'online');
    // rate limit: already 3 enroll calls from this IP; 2 more allowed, 6th refused
    await expectErr(hub.client().post('/enroll', { code: 'ape_AAAA-AAAA-AAAA-AAAA', node_id: 'x1', facts: f }), 'E_ENROLL_INVALID');
    await expectErr(hub.client().post('/enroll', { code: 'ape_AAAA-AAAA-AAAA-AAAA', node_id: 'x1', facts: f }), 'E_ENROLL_INVALID');
    await expectErr(hub.client().post('/enroll', { code: 'ape_AAAA-AAAA-AAAA-AAAA', node_id: 'x1', facts: f }), 'E_RATE_LIMIT');
  } finally { await hub.cleanup(); }
});

test('metadata: If-Match conflict, versioned history, rollback, heartbeat delivers new meta (T25)', async () => {
  const hub = await startTestHub();
  try {
    const n = await addNode(hub, 'linux-box', { roles: ['tester'] });
    await expectErr(hub.admin.patch('/nodes/linux-box/meta', { labels: { gpu: 'yes' } }, { headers: { 'If-Match': '9' } }), 'E_META_CONFLICT');
    const v = await hub.admin.patch('/nodes/linux-box/meta', { labels: { gpu: 'yes' }, notes: '辦公室' }, { headers: { 'If-Match': '1' } });
    assert.equal(v.data.meta_version, 2);
    assert.equal(v.data.meta.labels.gpu, 'yes');
    const hb = await n.heartbeat({ meta_version: 1 });
    assert.equal(hb.data.meta_version, 2);
    assert.equal(hb.data.meta.labels.gpu, 'yes');
    const rb = await hub.admin.post('/nodes/linux-box/meta/rollback', { to_version: 1 });
    assert.equal(rb.data.meta_version, 3);
    assert.equal(rb.data.meta.labels.gpu, undefined);
    const h = await hub.admin.get('/nodes/linux-box/history');
    assert.deepEqual(h.data.meta.map((x) => x.meta_version), [3, 2, 1]);
  } finally { await hub.cleanup(); }
});

test('dispatch to sleeping laptop: confirm refuses with alternatives, queue creates with warning (T27, T28)', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    await addNode(hub, 'macbook', { power: 'laptop', os_: 'macos', arch: 'arm64', profiles: ['ios'], labels: { xcode: '16' } });
    hub.advance(120);
    const studio = await addNode(hub, 'mac-studio', { os_: 'macos', arch: 'arm64', profiles: ['ios'], labels: { xcode: '16' } });
    await dev.heartbeat();
    await studio.heartbeat();
    const body = taskBody(W('macbook'), { payload: { title: 'iOS tests', profile: 'ios', instructions: 'run', dispatch: { on_unavailable: 'confirm' } } });
    const e = await expectErr(dev.client.post('/tasks', body), 'E_TARGET_UNAVAILABLE');
    assert.equal(e.body.target_status.presence, 'asleep');
    assert.equal(e.body.warnings[0].code, 'W_TARGET_ASLEEP');
    assert.match(e.body.warnings[0].message, /macbook（macbook，筆電）已 2 分鐘沒有回應/);
    assert.deepEqual(e.body.alternatives.map((a) => a.node_id), ['mac-studio']);
    const tasks = await hub.admin.get('/tasks');
    assert.equal(tasks.data.items.length, 0, 'confirm must not create a task');
    body.payload.dispatch.on_unavailable = 'queue';
    const ok = await dev.client.post('/tasks', body);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.warnings[0].code, 'W_TARGET_ASLEEP');
    const st = await hub.admin.get('/tasks', { query: { stuck: 1 } });
    assert.equal(st.data.items[0].stuck_reason, 'waiting_node');
    assert.match(st.data.items[0].stuck_detail, /等待 macbook/);
  } finally { await hub.cleanup(); }
});

test('full task lifecycle: claim with routing, lease, progress, result, mailbox notice, summary, ack (T19 core)', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const win = await addNode(hub, 'build-pc', { roles: ['tester'], os_: 'windows', profiles: ['e2e'] });
    const lin = await addNode(hub, 'linux-box', { roles: ['tester'], profiles: ['e2e'], labels: { browser: 'chromium' } });
    const created = await dev.client.post('/tasks', { to: { role: 'tester', agent: 'worker' }, payload: { title: 'E2E', profile: 'e2e', instructions: 'go', requires: { os: ['linux'], labels: { browser: '*' } } } });
    assert.equal(created.data.warnings.length, 0);
    assert.equal((await win.client.post('/tasks/claim', { profiles: ['e2e'] }, { query: { wait: 0 } })).status, 204, 'windows node must not claim linux-only task');
    const c = await lin.client.post('/tasks/claim', { profiles: ['e2e'] }, { query: { wait: 0 } });
    assert.equal(c.status, 200);
    assert.match(c.data.task_token, /^apt_/);
    const id = c.data.task.id;
    await lin.client.post(`/tasks/${id}/progress`, { phase: 'started', message: 'go', claude_session_id: 'sess-1' });
    const tc = hub.client(c.data.task_token);
    await tc.post(`/tasks/${id}/progress`, { phase: 'note', message: 'from MCP without seq' });
    const lease = await lin.client.post(`/tasks/${id}/lease`, { lease_id: c.data.lease.lease_id });
    assert.equal(lease.data.cancel_requested, false);
    await expectErr(lin.client.post(`/tasks/${id}/result`, { status: 'succeeded', summary: 'x' }, { headers: { 'X-AIPager-Lease': 'wrong' } }), 'E_LEASE_LOST');
    await lin.client.post(`/tasks/${id}/result`, { status: 'succeeded', summary: '全部通過', metrics: { cost_usd: 0.5, claude_session_id: 'sess-1' } }, { headers: { 'X-AIPager-Lease': c.data.lease.lease_id } });
    const t = await hub.admin.get(`/tasks/${id}`, { query: { events: 1 } });
    assert.equal(t.data.state, 'succeeded');
    assert.deepEqual(t.data.events.map((e) => e.seq), [1, 2]);
    const sum = await dev.client.get('/mailboxes/main/summary');
    assert.equal(sum.data.unread, 1);
    assert.equal(sum.data.tasks_done, 1);
    const inbox = await dev.client.get('/mailboxes/main/inbox');
    assert.equal(inbox.data.items[0].envelope.kind, 'task.result');
    assert.equal(inbox.data.items[0].envelope.payload.summary, '全部通過');
    await dev.client.post('/mailboxes/main/ack', { ids: [inbox.data.items[0].message_id] });
    assert.equal((await dev.client.get('/mailboxes/main/summary')).data.unread, 0);
    await expectErr(hub.client(c.data.task_token).post('/approvals', { tool_name: 'Bash', tool_input: {} }), 'E_CONFLICT');
  } finally { await hub.cleanup(); }
});

test('cancel: queued immediately, running via heartbeat and lease (T11/T12 hub side)', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const b = await addNode(hub, 'build-pc');
    const q = await dev.client.post('/tasks', taskBody(W('build-pc')));
    await dev.client.post(`/tasks/${q.data.task_id}/cancel`, { reason: 'changed my mind' });
    assert.equal((await hub.admin.get(`/tasks/${q.data.task_id}`)).data.state, 'cancelled');
    const r = await dev.client.post('/tasks', taskBody(W('build-pc')));
    const c = await b.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    await dev.client.post(`/tasks/${r.data.task_id}/cancel`, {});
    const hb = await b.heartbeat();
    assert.deepEqual(hb.data.cancel_requests, [r.data.task_id]);
    const l = await b.client.post(`/tasks/${r.data.task_id}/lease`, { lease_id: c.data.lease.lease_id });
    assert.equal(l.data.cancel_requested, true);
    await expectErr(b.client.post(`/tasks/${r.data.task_id}/cancel`, {}), 'E_FORBIDDEN');
  } finally { await hub.cleanup(); }
});

test('idempotency, self target, hop limit via task tokens (T14, T15)', async () => {
  const hub = await startTestHub({ limits: { rate_per_sender_per_min: 1000, max_hops: 2 } });
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: ['echo'] });
    const a = await addNode(hub, 'a-pc');
    const b = await addNode(hub, 'b-pc');
    const one = await dev.client.post('/tasks', taskBody(W('a-pc'), { idempotency_key: 'k1' }));
    const two = await dev.client.post('/tasks', taskBody(W('a-pc'), { idempotency_key: 'k1' }));
    assert.equal(one.status, 201);
    assert.equal(two.status, 200);
    assert.equal(one.data.task_id, two.data.task_id);
    const ca = await a.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    const ta = hub.client(ca.data.task_token);
    await expectErr(ta.post('/tasks', taskBody(W('a-pc'))), 'E_SELF_TARGET');
    const h1 = await ta.post('/tasks', taskBody(W('b-pc')));
    const cb = await b.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    assert.equal(cb.data.task.trace.hop, 1);
    assert.equal(cb.data.task.thread_id, h1.data.thread_id);
    const tb = hub.client(cb.data.task_token);
    await tb.post('/tasks', taskBody(W('a-pc')));
    const ca2 = await a.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    assert.equal(ca2.data.task.trace.hop, 2);
    await expectErr(hub.client(ca2.data.task_token).post('/tasks', taskBody(W('b-pc'))), 'E_HOP_LIMIT');
  } finally { await hub.cleanup(); }
});

test('approvals: request moves task to waiting_approval, admin deny is returned, timeout expires (T09, T10 hub side)', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const b = await addNode(hub, 'build-pc');
    const r = await dev.client.post('/tasks', taskBody(W('build-pc')));
    const c = await b.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    await b.client.post(`/tasks/${r.data.task_id}/progress`, { phase: 'started' });
    const tc = hub.client(c.data.task_token);
    const ap = await tc.post('/approvals', { tool_name: 'Bash', tool_input: { command: 'git push' }, risk: 'high', timeout_sec: 60 });
    assert.equal((await hub.admin.get(`/tasks/${r.data.task_id}`)).data.state, 'waiting_approval');
    const notices = await dev.client.get('/mailboxes/main/inbox');
    assert.equal(notices.data.items[0].envelope.payload.code, 'APPROVAL_REQUESTED');
    const pending = await hub.admin.get('/approvals', { query: { state: 'pending' } });
    assert.equal(pending.data.items.length, 1);
    const waiter = tc.get(`/approvals/${ap.data.approval_id}/wait`, { query: { timeout: 10 } });
    await hub.admin.post(`/approvals/${ap.data.approval_id}/decision`, { decision: 'deny', note: '只做編譯' });
    const w = await waiter;
    assert.equal(w.data.decision, 'deny');
    assert.equal(w.data.note, '只做編譯');
    assert.equal((await hub.admin.get(`/tasks/${r.data.task_id}`)).data.state, 'running');
    const ap2 = await tc.post('/approvals', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, timeout_sec: 30 });
    hub.advance(31);
    await b.heartbeat();
    hub.sweep();
    assert.equal((await tc.get(`/approvals/${ap2.data.approval_id}/wait`, { query: { timeout: 0 } })).data.decision, 'expired');
  } finally { await hub.cleanup(); }
});

test('laptop sleeps during a task: grace keeps lease, notice sent, beyond grace fails with node_asleep (T29 hub side)', async () => {
  const hub = await startTestHub({ lease: { duration_sec: 60 } });
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const mac = await addNode(hub, 'macbook', { power: 'laptop', os_: 'macos', arch: 'arm64' });
    const r = await dev.client.post('/tasks', taskBody(W('macbook')));
    await mac.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    await mac.client.post(`/tasks/${r.data.task_id}/progress`, { phase: 'started' });
    hub.advance(600); // 10 min asleep: lease (60 s) expired, laptop grace 30 min
    await dev.heartbeat();
    hub.sweep();
    let t = (await hub.admin.get(`/tasks/${r.data.task_id}`)).data;
    assert.equal(t.state, 'running');
    assert.ok(t.node_asleep_since);
    const inbox = await dev.client.get('/mailboxes/main/inbox');
    assert.equal(inbox.data.items[0].envelope.payload.code, 'NODE_ASLEEP_RUNNING');
    const st = await hub.admin.get('/tasks', { query: { stuck: 1 } });
    assert.equal(st.data.items[0].stuck_reason, 'node_asleep');
    assert.match(st.data.items[0].stuck_detail, /保留時間還剩 20 分鐘/);
    hub.advance(1500); // 35 min since last seen
    await dev.heartbeat();
    hub.sweep();
    t = (await hub.admin.get(`/tasks/${r.data.task_id}`)).data;
    assert.equal(t.state, 'failed');
    assert.equal(t.result.error.code, 'E_LEASE_LOST');
    assert.equal(t.result.error.detail.reason, 'node_asleep');
  } finally { await hub.cleanup(); }
});

test('server goes silent without grace: task requeued when attempts remain (T18 hub side)', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const srv = await addNode(hub, 'srv', { power: 'server' });
    const r = await dev.client.post('/tasks', taskBody(W('srv'), { payload: { title: 't', profile: 'echo', instructions: 'x', limits: { max_attempts: 2 } } }));
    await srv.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    hub.advance(90);
    hub.sweep();
    assert.equal((await hub.admin.get(`/tasks/${r.data.task_id}`)).data.state, 'queued');
    await srv.heartbeat();
    const again = await srv.client.post('/tasks/claim', { profiles: ['echo'] }, { query: { wait: 0 } });
    assert.equal(again.data.attempt, 2);
  } finally { await hub.cleanup(); }
});

test('then chain creates follow-up task with rendered variables (T20 hub side)', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const b = await addNode(hub, 'build-pc', { os_: 'windows', profiles: ['build'] });
    await addNode(hub, 'linux-box', { roles: ['tester'], profiles: ['e2e'] });
    const r = await dev.client.post('/tasks', { to: W('build-pc'), payload: { title: 'build', profile: 'build', instructions: 'b',
      inputs: { repo: { url: 'git@x:y.git', ref: 'main', commit: 'abc1234' } },
      then: [{ to: { role: 'tester', agent: 'worker' }, title: 'E2E {{inputs.repo.commit}}', profile: 'e2e', instructions: '上一步：{{result.summary}}', requires: { os: ['linux'] } }] } });
    const c = await b.client.post('/tasks/claim', { profiles: ['build'] }, { query: { wait: 0 } });
    await b.client.post(`/tasks/${r.data.task_id}/result`, { status: 'succeeded', summary: '編譯 <OK>' }, { headers: { 'X-AIPager-Lease': c.data.lease.lease_id } });
    const all = await hub.admin.get('/tasks');
    const child = all.data.items.find((t) => t.title === 'E2E abc1234');
    assert.ok(child, 'child task created');
    assert.equal(child.thread_id, r.data.thread_id);
    assert.equal(child.hop, 1);
    assert.equal(child.envelope.payload.instructions, '上一步：編譯 ＜OK＞');
    assert.equal(child.envelope.from.node, 'dev-pc');
  } finally { await hub.cleanup(); }
});

test('blobs: upload verifies sha256, download and HEAD (attachments)', async () => {
  const hub = await startTestHub();
  try {
    const n = await addNode(hub, 'n1');
    const buf = Buffer.from('build log 中文\n');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    await expectErr(n.client.request('PUT', '/blobs/' + '0'.repeat(64), { raw: buf }), 'E_VALIDATION');
    const up = await n.client.request('PUT', '/blobs/' + sha, { raw: buf });
    assert.equal(up.status, 201);
    const res = await fetch(`${hub.base}/api/v1/blobs/${sha}`, { headers: { Authorization: 'Bearer ' + n.token } });
    assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'build log 中文\n');
  } finally { await hub.cleanup(); }
});

test('retire revokes tokens; reinstall with bound code keeps metadata (T32, T33)', async () => {
  const hub = await startTestHub();
  try {
    const n = await addNode(hub, 'old-box', { roles: ['tester'] });
    const en = await hub.admin.post('/admin/enrollments', { node_id: 'old-box' });
    const r = await hub.client().post('/enroll', { code: en.data.code, node_id: 'old-box', facts: { os: 'linux', arch: 'x64', hostname: 'h', worker_version: '1' } });
    assert.equal(r.data.meta_version, 2);
    assert.deepEqual(r.data.meta.roles, ['tester']);
    await expectErr(n.heartbeat(), 'E_AUTH');
    await hub.admin.post('/nodes/old-box/state', { state: 'retired' });
    await expectErr(hub.client(r.data.node_token).get('/nodes/self'), 'E_AUTH');
  } finally { await hub.cleanup(); }
});

test('expired queued task notifies sender; messages to sleeping node carry a warning', async () => {
  const hub = await startTestHub();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    await addNode(hub, 'sleepy', { power: 'laptop' });
    const r = await dev.client.post('/tasks', taskBody(W('sleepy'), { payload: { title: 't', profile: 'echo', instructions: 'x', dispatch: { max_wait_sec: 120 } } }));
    hub.advance(200);
    await dev.heartbeat();
    hub.sweep();
    assert.equal((await hub.admin.get(`/tasks/${r.data.task_id}`)).data.state, 'expired');
    const m = await dev.client.post('/messages', { to: { node: 'sleepy', agent: 'main' }, payload: { text: '在嗎？' } });
    assert.equal(m.data.warnings[0].code, 'W_TARGET_ASLEEP');
  } finally { await hub.cleanup(); }
});
