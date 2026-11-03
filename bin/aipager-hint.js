#!/usr/bin/env node
'use strict';
// Claude Code hook (SessionStart / UserPromptSubmit). Prints one line only when there is something unread.
// Never fails the hook: any problem is logged and the hook exits 0 silently. Finishes within ~3 s.
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, readSecret } = require('../lib/common/config');
const { HubClient } = require('../lib/common/client');
const { createLogger } = require('../lib/common/log');
const { defaultNodeConfigPath, nodeDirs } = require('../lib/common/paths');

const hardStop = setTimeout(() => process.exit(0), 3000);

async function main() {
  if (process.env.AIPAGER_TASK_ID) return; // inside a worker task session
  let input = {};
  try { const raw = fs.readFileSync(0, 'utf8'); if (raw.trim()) input = JSON.parse(raw); } catch { /* no stdin */ }
  const cfgPath = defaultNodeConfigPath();
  if (!fs.existsSync(cfgPath)) return;
  const cfg = readJson(cfgPath);
  const log = createLogger({ comp: 'hint', dir: (cfg.log && cfg.log.dir) || nodeDirs().logs, level: (cfg.log && cfg.log.level) || 'info', base: { node: cfg.node_id } });
  try {
    let agent = (cfg.mcp && cfg.mcp.default_agent) || 'main';
    const cwd = input.cwd || process.cwd();
    const mcpFile = path.join(cwd, '.mcp.json');
    if (fs.existsSync(mcpFile)) {
      const m = readJson(mcpFile);
      const env = m.mcpServers && m.mcpServers.aipager && m.mcpServers.aipager.env;
      if (env && env.AIPAGER_AGENT) agent = env.AIPAGER_AGENT;
    }
    const hub = new HubClient({ baseUrl: cfg.hub_url, token: readSecret(cfg.token_file), agent });
    const s = (await hub.get(`/mailboxes/${agent}/summary`, { timeoutMs: 2500 })).data;
    log.debug('hint.summary', 'summary', { agent, event: input.hook_event_name, s });
    if (!s.unread && !s.approvals_pending) return;
    const parts = [];
    if (s.unread) parts.push(`${s.unread} 則未讀：${s.top.join('；')}`);
    if (s.approvals_pending) parts.push(`${s.approvals_pending} 個任務等待人工審核`);
    if (s.waiting_tasks) parts.push(`${s.waiting_tasks} 個任務排隊中`);
    process.stdout.write(`[AIPager] ${parts.join('。')}。可用 aipager 的 inbox 工具讀取（信箱 ${agent}@${cfg.node_id}）。\n`);
  } catch (e) {
    log.warn('hint.failed', e.message, { code: e.code });
  }
}

main().finally(() => { clearTimeout(hardStop); process.exit(0); });
