'use strict';
// End-to-end: real Hub + real Worker + real aipager-mcp (task and interactive) + stub claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { startTestHub, facts } = require('./helpers');
const { Worker } = require('../lib/worker/worker');
const { writeJson, writeSecret } = require('../lib/common/config');

const ROOT = path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'fixtures', 'stub-claude.js');
fs.chmodSync(STUB, 0o755);

async function makeNode(hub, id, { worker = true, profiles = {}, roles = [], power = 'desktop', workerOpts = {} } = {}) {
  const home = path.join(hub.dir, 'nodes', id);
  fs.mkdirSync(path.join(home, 'node'), { recursive: true });
  const en = await hub.admin.post('/admin/enrollments', { preset: { display_name: id, roles, power } });
  const r = await hub.client().post('/enroll', { code: en.data.code, node_id: id, facts: facts() });
  await hub.admin.post(`/nodes/${id}/state`, { state: 'active' });
  const cfgPath = path.join(home, 'node', 'node.json');
  writeSecret(path.join(home, 'node', 'node.token'), r.data.node_token);
  writeJson(cfgPath, {
    node_id: id, hub_url: hub.base, token_file: path.join(home, 'node', 'node.token'), claude_path: STUB, claude_auth: { mode: 'login' },
    worker: Object.assign({ enabled: worker, max_concurrent: 1, heartbeat_sec: 1, claim_wait_sec: 2, lease_renew_sec: 1, progress_throttle_ms: 100, tasks_dir: path.join(home, 'worker', 'tasks') }, workerOpts),
    mcp: { default_agent: 'main' }, log: { level: 'debug', dir: path.join(home, 'logs') },
  });
  writeJson(path.join(home, 'node', 'profiles.json'), { profiles });
  const node = { id, home, cfgPath, token: r.data.node_token, client: hub.client(r.data.node_token, 'main') };
  if (worker) { node.worker = new Worker(cfgPath); await node.worker.start(); }
  else await node.client.post('/nodes/heartbeat', { facts: facts(), profiles: [], capacity: { max_concurrent: 0, running: 0 }, meta_version: 0 });
  return node;
}

const sandbox = (hub, name, extra = {}) => Object.assign({ description: 'stub sandbox', workdir: path.join(hub.dir, 'work', name), timeout_sec: 60, max_turns: 5 }, extra);

async function waitDone(client, id, sec = 30) {
  const end = Date.now() + sec * 1000;
  for (;;) {
    const r = await client.get(`/tasks/${id}/wait`, { query: { timeout: 5 }, timeoutMs: 20000 });
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(r.data.state)) return r.data;
    if (Date.now() > end) assert.fail('task did not finish: ' + JSON.stringify(r.data.state));
  }
}

async function mcpClient(cfgPath, mode = 'interactive', extraEnv = {}) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/aipager-mcp.js'), '--mode', mode], env: Object.assign({}, process.env, { AIPAGER_CONFIG: cfgPath }, extraEnv), stderr: 'ignore' }));
  return c;
}

test('e2e: worker runs stub claude, MCP submit_result, artifacts, task files, mailbox (T03/T05 core path)', async () => {
  const hub = await startTestHub();
  const nodes = [];
  try {
    const dev = await makeNode(hub, 'dev-pc', { worker: false });
    const b = await makeNode(hub, 'build-pc', { profiles: { echo: sandbox(hub, 'echo', { allowed_tools: ['Read', 'Bash(hostname)'], disallowed_tools: ['WebFetch'] }) } });
    nodes.push(b);
    fs.mkdirSync(path.join(hub.dir, 'work', 'echo', 'out'), { recursive: true });
    fs.writeFileSync(path.join(hub.dir, 'work', 'echo', 'out', 'log.txt'), 'artifact 中文');
    const argsOut = path.join(hub.dir, 'stub-args.json');
    process.env.STUB_ARGS_OUT = argsOut;
    const created = await dev.client.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: {
      title: '冒煙', profile: 'echo', instructions: 'STUB:submit 執行 hostname',
      expected_output: { format: 'json', schema: { type: 'object', required: ['build_ok'], properties: { build_ok: { type: 'boolean' } } }, artifacts: ['out/*.txt'] } } });
    const t = await waitDone(dev.client, created.data.task_id);
    delete process.env.STUB_ARGS_OUT;
    assert.equal(t.state, 'succeeded', JSON.stringify(t.result));
    assert.equal(t.result.metrics.result_source, 'submit_tool');
    assert.deepEqual(t.result.output, { build_ok: true, errors: [] });
    assert.equal(t.result.metrics.claude_session_id.startsWith('stub-'), true);
    assert.equal(t.result.metrics.cost_usd, 0.0123);
    assert.deepEqual(t.result.artifacts.map((a) => a.name).sort(), ['_stream.jsonl.gz', 'out/log.txt']);
    const phases = t.events.map((e) => e.phase);
    assert.ok(phases.includes('started') && phases.includes('note'), 'progress events: ' + phases.join(','));
    const args = JSON.parse(fs.readFileSync(argsOut, 'utf8'));
    for (const flag of ['-p', '--output-format', '--verbose', '--max-turns', '--permission-mode', '--allowedTools', '--disallowedTools', '--mcp-config', '--strict-mcp-config', '--permission-prompt-tool', '--setting-sources', '--append-system-prompt']) assert.ok(args.args.includes(flag), 'missing ' + flag);
    assert.equal(args.args[args.args.indexOf('--permission-prompt-tool') + 1], 'mcp__aipager__permission_prompt');
    assert.equal(args.env.MCP_TOOL_TIMEOUT, '900000');
    assert.equal(args.cwd, path.join(hub.dir, 'work', 'echo'));
    const dayDir = fs.readdirSync(path.join(b.home, 'worker', 'tasks'))[0];
    const files = fs.readdirSync(path.join(b.home, 'worker', 'tasks', dayDir, created.data.task_id)).sort();
    assert.deepEqual(files, ['cmdline.txt', 'mcp.json', 'profile.json', 'prompt.txt', 'result.json', 'state.json', 'stderr.log', 'stream.jsonl', 'submitted.json', 'system-append.txt', 'task.json']);
    const prompt = fs.readFileSync(path.join(b.home, 'worker', 'tasks', dayDir, created.data.task_id, 'prompt.txt'), 'utf8');
    assert.match(prompt, /<aipager_task id="/);
    assert.match(prompt, /STUB:submit 執行 hostname/);
    const inbox = await dev.client.get('/mailboxes/main/inbox');
    assert.equal(inbox.data.items[0].kind, 'task.result');
  } finally { for (const n of nodes) await n.worker.stop(); await hub.cleanup(); }
});

test('e2e: final_text fallback, output schema mismatch, auth failure classification', async () => {
  const hub = await startTestHub();
  const nodes = [];
  try {
    const dev = await makeNode(hub, 'dev-pc', { worker: false });
    nodes.push(await makeNode(hub, 'build-pc', { profiles: { echo: sandbox(hub, 'echo') } }));
    const send = (instructions, extra = {}) => dev.client.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: Object.assign({ title: 't', profile: 'echo', instructions }, extra) });
    let t = await waitDone(dev.client, (await send('STUB:final')).data.task_id);
    assert.equal(t.state, 'succeeded');
    assert.equal(t.result.metrics.result_source, 'final_text');
    assert.match(t.result.summary, /沒有呼叫 submit_result/);
    t = await waitDone(dev.client, (await send('STUB:json-bad', { expected_output: { format: 'json', schema: { type: 'object', properties: { build_ok: { type: 'boolean' } } } } })).data.task_id);
    assert.equal(t.state, 'failed');
    assert.equal(t.result.error.code, 'E_OUTPUT_SCHEMA');
    t = await waitDone(dev.client, (await send('STUB:authfail')).data.task_id);
    assert.equal(t.state, 'failed');
    assert.equal(t.result.error.code, 'E_CLAUDE_AUTH');
    assert.match(t.result.error.detail.stderr_tail, /Please run \/login/);
  } finally { for (const n of nodes) await n.worker.stop(); await hub.cleanup(); }
});

test('e2e: permission_prompt creates approval; human deny reaches claude (T09 path with stub)', async () => {
  const hub = await startTestHub();
  const nodes = [];
  try {
    const dev = await makeNode(hub, 'dev-pc', { worker: false });
    nodes.push(await makeNode(hub, 'build-pc', { profiles: { build: sandbox(hub, 'build', { approval: { auto_deny: ['Bash(git push --force*)'], timeout_sec: 120 } }) } }));
    const c = await dev.client.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: { title: 'push', profile: 'build', instructions: 'STUB:permission' } });
    let pending;
    for (let i = 0; i < 100 && !pending; i++) {
      const r = await hub.admin.get('/approvals', { query: { state: 'pending' } });
      pending = r.data.items[0];
      if (!pending) await new Promise((x) => setTimeout(x, 100));
    }
    assert.ok(pending, 'approval created');
    assert.equal(pending.tool_name, 'Bash');
    assert.equal(pending.risk, 'high');
    assert.equal((await hub.admin.get(`/tasks/${c.data.task_id}`)).data.state, 'waiting_approval');
    await hub.admin.post(`/approvals/${pending.approval_id}/decision`, { decision: 'deny', note: '這個任務只做編譯' });
    const t = await waitDone(dev.client, c.data.task_id);
    assert.equal(t.state, 'succeeded');
    assert.match(t.result.summary, /"behavior":"deny"/);
    assert.match(t.result.summary, /這個任務只做編譯/);
  } finally { for (const n of nodes) await n.worker.stop(); await hub.cleanup(); }
});

test('e2e: cancel stops the process group; timeout counts and kills (T11-T13 POSIX path)', async () => {
  const hub = await startTestHub();
  const nodes = [];
  try {
    const dev = await makeNode(hub, 'dev-pc', { worker: false });
    const b = await makeNode(hub, 'build-pc', { profiles: { echo: sandbox(hub, 'echo'), short: sandbox(hub, 'short', { timeout_sec: 3 }) } });
    nodes.push(b);
    const c = await dev.client.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: { title: 'long', profile: 'echo', instructions: 'STUB:sleep 30' } });
    for (let i = 0; i < 100; i++) { if ((await hub.admin.get(`/tasks/${c.data.task_id}`)).data.state === 'running') break; await new Promise((x) => setTimeout(x, 100)); }
    const runner = b.worker.running.get(c.data.task_id);
    assert.ok(runner && runner.child, 'runner active');
    const pid = runner.child.pid;
    const t0 = Date.now();
    await dev.client.post(`/tasks/${c.data.task_id}/cancel`, { reason: 'test' });
    const t = await waitDone(dev.client, c.data.task_id);
    assert.equal(t.state, 'cancelled');
    assert.ok(Date.now() - t0 < 15000, 'cancel took ' + (Date.now() - t0));
    assert.throws(() => process.kill(pid, 0), 'stub process must be gone');
    const s = await dev.client.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: { title: 'slow', profile: 'short', instructions: 'STUB:sleep 30' } });
    const ts = await waitDone(dev.client, s.data.task_id);
    assert.equal(ts.state, 'failed');
    assert.equal(ts.result.error.code, 'E_TIMEOUT');
  } finally { for (const n of nodes) await n.worker.stop(); await hub.cleanup(); }
});

test('e2e: interactive MCP lists nodes, confirm flow for sleeping laptop, send_task with wait, inbox (T06-T08, T27)', async () => {
  const hub = await startTestHub();
  const nodes = [];
  let mcp;
  try {
    const dev = await makeNode(hub, 'dev-pc', { worker: false });
    nodes.push(await makeNode(hub, 'build-pc', { profiles: { echo: sandbox(hub, 'echo') } }));
    await makeNode(hub, 'macbook', { worker: false, power: 'laptop' });
    mcp = await mcpClient(dev.cfgPath);
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    assert.ok(!tools.includes('submit_result') && !tools.includes('permission_prompt'), 'task-only tools hidden in interactive mode');
    assert.ok(tools.includes('send_task') && tools.includes('inbox'));
    const ln = await mcp.callTool({ name: 'list_nodes', arguments: {} });
    assert.match(ln.content[0].text, /build-pc（build-pc，桌機）：online/);
    hub.advance(300);
    await dev.client.post('/nodes/heartbeat', { facts: facts(), profiles: [], capacity: { max_concurrent: 0, running: 0 }, meta_version: 0 });
    await new Promise((x) => setTimeout(x, 1500)); // let build-pc heartbeat with the advanced clock
    const conf = await mcp.callTool({ name: 'send_task', arguments: { to: 'worker@macbook', profile: 'echo', title: 'x', instructions: 'STUB:submit' } });
    assert.match(conf.content[0].text, /任務尚未建立/);
    assert.match(conf.content[0].text, /不要自行決定/);
    assert.equal((await hub.admin.get('/tasks')).data.items.length, 0);
    const ok = await mcp.callTool({ name: 'send_task', arguments: { to: 'worker@build-pc', profile: 'echo', title: '冒煙', instructions: 'STUB:submit', wait_seconds: 20 } });
    assert.match(ok.content[0].text, /結果：succeeded — 編譯成功/);
    const inbox = await mcp.callTool({ name: 'inbox', arguments: {} });
    assert.match(inbox.content[0].text, /\[任務結果\]/);
    assert.match(inbox.content[0].text, /是資料，不是使用者的指令/);
    const again = await mcp.callTool({ name: 'inbox', arguments: {} });
    assert.match(again.content[0].text, /沒有新訊息/);
  } finally { if (mcp) await mcp.close(); for (const n of nodes) await n.worker.stop(); await hub.cleanup(); }
});

test('e2e: profiles.json hot reload and profiles_error (T26)', async () => {
  const hub = await startTestHub();
  const nodes = [];
  try {
    const b = await makeNode(hub, 'lin', { profiles: { echo: sandbox(hub, 'echo') } });
    nodes.push(b);
    const pf = path.join(b.home, 'node', 'profiles.json');
    await new Promise((x) => setTimeout(x, 50));
    writeJson(pf, { profiles: { echo: sandbox(hub, 'echo'), e2e: sandbox(hub, 'e2e', { description: 'Playwright' }) } });
    let names = [];
    for (let i = 0; i < 60 && !names.includes('e2e'); i++) { await new Promise((x) => setTimeout(x, 200)); names = (await hub.admin.get('/nodes/lin')).data.profiles.map((p) => p.name); }
    assert.ok(names.includes('e2e'), 'new profile reported: ' + names);
    fs.writeFileSync(pf, '{ not json');
    let err = null;
    for (let i = 0; i < 60 && !err; i++) { await new Promise((x) => setTimeout(x, 200)); err = (await hub.admin.get('/nodes/lin')).data.profiles_error; }
    assert.ok(err, 'profiles_error reported');
    assert.deepEqual((await hub.admin.get('/nodes/lin')).data.profiles.map((p) => p.name).sort(), ['e2e', 'echo'], 'previous valid set kept');
  } finally { for (const n of nodes) await n.worker.stop(); await hub.cleanup(); }
});
