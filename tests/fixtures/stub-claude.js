#!/usr/bin/env node
'use strict';
// Stub of `claude -p` for end-to-end tests. Emits the same stream-json shapes as Claude Code 2.1.x
// and really connects to the MCP servers listed in --mcp-config, so worker -> claude -> MCP -> hub is exercised.
// Behaviour is selected by markers in the prompt (stdin):
//   STUB:submit   call submit_result (succeeded) then exit 0
//   STUB:final    no submit_result; final text only
//   STUB:json-bad submit_result with output that does not match the schema
//   STUB:permission  call permission_prompt for `git push`, report the decision via submit_result
//   STUB:sleep N  sleep N seconds before finishing (cancel / timeout tests)
//   STUB:authfail write a login error to stderr and exit 1
const fs = require('node:fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sessionId = 'stub-' + process.pid;

(async () => {
  if (args[0] === '--version') { console.log('9.9.9 (Claude Code stub)'); return; }
  const prompt = fs.readFileSync(0, 'utf8');
  if (process.env.STUB_ARGS_OUT) fs.writeFileSync(process.env.STUB_ARGS_OUT, JSON.stringify({ args, cwd: process.cwd(), env: { AIPAGER_TASK_ID: process.env.AIPAGER_TASK_ID, MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : null } }));
  if (prompt.includes('STUB:authfail')) { process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); }
  out({ type: 'active_goal', value: null, session_id: sessionId });
  const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8'));
  const srv = cfg.mcpServers.aipager;
  const client = new Client({ name: 'stub-claude', version: '1' });
  await client.connect(new StdioClientTransport({ command: srv.command, args: srv.args, env: Object.assign({}, process.env, srv.env), stderr: 'ignore' }));
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub-model', mcp_servers: [{ name: 'aipager', status: 'connected' }], tools: [] });
  const tool = async (name, input) => {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_' + name, name: 'mcp__aipager__' + name, input }] }, session_id: sessionId });
    const r = await client.callTool({ name, arguments: input });
    return r.content.map((c) => c.text).join('\n');
  };
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'hostname' } }] }, session_id: sessionId });
  const m = /STUB:sleep (\d+)/.exec(prompt);
  if (m) await new Promise((r) => setTimeout(r, Number(m[1]) * 1000));
  let finalText = 'stub finished';
  if (prompt.includes('STUB:permission')) {
    const decision = await tool('permission_prompt', { tool_name: 'Bash', input: { command: 'git push origin main' } });
    await tool('submit_result', { status: 'succeeded', summary: 'permission decision: ' + decision });
  } else if (prompt.includes('STUB:json-bad')) {
    await tool('submit_result', { status: 'succeeded', summary: 'bad json', output: { build_ok: 'yes' } });
  } else if (prompt.includes('STUB:submit')) {
    await tool('report_progress', { message: 'halfway', pct: 50 });
    await tool('submit_result', { status: 'succeeded', summary: '編譯成功，0 錯誤', output: { build_ok: true, errors: [] } });
  } else {
    finalText = '最後的文字結果（沒有呼叫 submit_result）';
  }
  out({ type: 'rate_limit_event', rate_limit_info: {}, session_id: sessionId });
  out({ type: 'result', subtype: 'success', is_error: false, result: finalText, session_id: sessionId, num_turns: 3, total_cost_usd: 0.0123, duration_ms: 1000 });
  await client.close();
})().catch((e) => { process.stderr.write('stub error: ' + (e.stack || e.message) + '\n'); process.exit(2); });
