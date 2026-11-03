'use strict';
// Test harness: real Hub over HTTP on a random port, temp data dir, controllable clock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startHub } = require('../lib/hub/hub');
const { initAdmin } = require('../lib/hub/admin');
const { HubClient } = require('../lib/common/client');

async function startTestHub(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipager-hub-'));
  let offset = 0;
  const clock = () => Date.now() + offset;
  const cfg = Object.assign({
    data_dir: dir, listen: { host: '127.0.0.1', port: 0 },
    limits: { rate_per_sender_per_min: 1000, max_hops: 4, max_tasks_per_thread: 20 },
    log: { level: 'debug', dir: path.join(dir, 'logs') },
  }, extra);
  const admin = initAdmin(cfg).token;
  const hub = await startHub(cfg, { clock, sweepIntervalMs: 0 });
  const base = `http://127.0.0.1:${hub.port}`;
  hub.cfg = cfg;
  hub.dir = dir;
  hub.base = base;
  hub.adminToken = admin;
  hub.admin = new HubClient({ baseUrl: base, token: admin });
  hub.advance = (sec) => { offset += sec * 1000; };
  hub.client = (token, agent) => new HubClient({ baseUrl: base, token, agent });
  hub.sweep = () => require('../lib/hub/sweeper').sweepOnce(hub.ctx);
  hub.cleanup = async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return hub;
}

function facts(os_ = 'linux', arch = 'x64') {
  return { os: os_, arch, hostname: 'test-host', worker_version: '0.4.0', claude_version: 'stub', claude_auth_mode: 'login', worker_enabled: true };
}

// Enroll + approve a node; returns { id, token, client }.
async function addNode(hub, id, { roles = [], labels = {}, power = 'desktop', os_ = 'linux', arch = 'x64', profiles = ['echo', 'build'], approve = true } = {}) {
  const en = await hub.admin.post('/admin/enrollments', { preset: { display_name: id, roles, labels, power } });
  const r = await hub.client().post('/enroll', { code: en.data.code, node_id: id, facts: facts(os_, arch) });
  const client = hub.client(r.data.node_token, 'main');
  const node = { id, token: r.data.node_token, client, profiles, os_, arch };
  node.heartbeat = (extra = {}) => client.post('/nodes/heartbeat', Object.assign({
    facts: facts(os_, arch), profiles: profiles.map((name) => ({ name })), capacity: { max_concurrent: 1, running: 0 }, meta_version: 0,
  }, extra));
  if (approve) await hub.admin.post(`/nodes/${id}/state`, { state: 'active' });
  await node.heartbeat();
  return node;
}

function taskBody(to, extra = {}) {
  return Object.assign({ to, payload: { title: 'test task', profile: 'echo', instructions: 'say hi' } }, extra);
}

module.exports = { startTestHub, addNode, facts, taskBody };
