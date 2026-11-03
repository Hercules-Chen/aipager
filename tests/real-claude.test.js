'use strict';
// Runs the Worker against the REAL Claude Code CLI (costs a few cents with haiku).
// Skipped unless AIPAGER_TEST_REAL_CLAUDE=1. Verifies CLI behaviour the design depends on:
//   - stream-json parsing with a real session, MCP task server connected, submit_result used
//   - --permission-prompt-tool routes a non-allowed tool to aipager permission_prompt; deny reaches Claude
//   - --setting-sources '' is accepted
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTestHub, facts } = require('./helpers');
const { Worker } = require('../lib/worker/worker');
const { writeJson, writeSecret } = require('../lib/common/config');

const enabled = process.env.AIPAGER_TEST_REAL_CLAUDE === '1';
const claudePath = enabled ? execFileSync('which', ['claude']).toString().trim() : '';

async function setup(hub, profiles) {
  const home = path.join(hub.dir, 'node');
  fs.mkdirSync(home, { recursive: true });
  for (const [id, worker] of [['dev-pc', false], ['build-pc', true]]) {
    const en = await hub.admin.post('/admin/enrollments', { preset: { display_name: id } });
    const r = await hub.client().post('/enroll', { code: en.data.code, node_id: id, facts: facts() });
    await hub.admin.post(`/nodes/${id}/state`, { state: 'active' });
    if (!worker) { hub.dev = hub.client(r.data.node_token, 'main'); await hub.dev.post('/nodes/heartbeat', { facts: facts(), profiles: [], capacity: { max_concurrent: 0, running: 0 }, meta_version: 0 }); continue; }
    writeSecret(path.join(home, 'node.token'), r.data.node_token);
    writeJson(path.join(home, 'node.json'), { node_id: id, hub_url: hub.base, token_file: path.join(home, 'node.token'), claude_path: claudePath, claude_auth: { mode: 'login' },
      worker: { enabled: true, heartbeat_sec: 2, claim_wait_sec: 2, lease_renew_sec: 5, tasks_dir: path.join(home, 'tasks') }, log: { level: 'debug', dir: path.join(home, 'logs') } });
    writeJson(path.join(home, 'profiles.json'), { profiles });
  }
  const w = new Worker(path.join(home, 'node.json'));
  await w.start();
  return w;
}

async function waitDone(client, id) {
  for (let i = 0; i < 40; i++) {
    const r = await client.get(`/tasks/${id}/wait`, { query: { timeout: 10 }, timeoutMs: 30000 });
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(r.data.state)) return r.data;
  }
  throw new Error('timeout');
}

test('real claude: submit_result via MCP and permission_prompt deny', { skip: !enabled, timeout: 600000 }, async () => {
  const hub = await startTestHub();
  let w;
  try {
    const wd = path.join(hub.dir, 'work');
    w = await setup(hub, { echo: { description: 'smoke', workdir: wd, model: 'haiku', max_turns: 8, timeout_sec: 240,
      allowed_tools: ['Bash(hostname)', 'Read'], approval: { timeout_sec: 120 } } });
    const t1 = await hub.dev.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: { title: 'hostname', profile: 'echo',
      instructions: '用 Bash 執行 hostname，然後呼叫 submit_result（status=succeeded），summary 填主機名稱。', expected_output: { format: 'text' } } });
    const r1 = await waitDone(hub.dev, t1.data.task_id);
    console.log('T1', JSON.stringify({ state: r1.state, summary: r1.result.summary, metrics: r1.result.metrics, error: r1.result.error }));
    assert.equal(r1.state, 'succeeded');
    assert.equal(r1.result.metrics.result_source, 'submit_tool');
    assert.ok(r1.result.summary.includes(require('node:os').hostname()), 'summary has hostname');

    const t2 = await hub.dev.post('/tasks', { to: { node: 'build-pc', agent: 'worker' }, payload: { title: 'touch', profile: 'echo',
      instructions: '用 Bash 執行 `touch aipager-test.txt`（這個指令需要核准）。不論是否被允許，最後都呼叫 submit_result（status=succeeded），summary 寫明是否被拒絕以及拒絕理由原文。' } });
    let ap;
    for (let i = 0; i < 300 && !ap; i++) { ap = (await hub.admin.get('/approvals', { query: { state: 'pending' } })).data.items[0]; if (!ap) await new Promise((x) => setTimeout(x, 500)); }
    console.log('APPROVAL', JSON.stringify(ap && { tool_name: ap.tool_name, tool_input: ap.tool_input, risk: ap.risk }));
    assert.ok(ap, 'permission_prompt created an approval');
    await hub.admin.post(`/approvals/${ap.approval_id}/decision`, { decision: 'deny', note: 'AIPAGER-DENY-7731：測試中不允許建立檔案' });
    const r2 = await waitDone(hub.dev, t2.data.task_id);
    console.log('T2', JSON.stringify({ state: r2.state, summary: r2.result.summary, metrics: r2.result.metrics }));
    // Claude may report failed (system prompt rule 4 wins over the task text) — both are correct.
    assert.ok(['succeeded', 'failed'].includes(r2.state));
    assert.equal(r2.result.metrics.result_source, 'submit_tool');
    assert.ok(!fs.existsSync(path.join(wd, 'aipager-test.txt')), 'file must not be created after deny');
    assert.match(r2.result.summary, /7731/, 'the reviewer note reached Claude verbatim');
  } finally { if (w) await w.stop(); await hub.cleanup(); }
});
