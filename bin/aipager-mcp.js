#!/usr/bin/env node
'use strict';
// aipager MCP server over stdio. stdout carries the MCP protocol only; logs go to the log dir.
// Usage: node bin/aipager-mcp.js --mode interactive|task
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`); });
const i = process.argv.indexOf('--mode');
const mode = i > 0 ? process.argv[i + 1] : 'interactive';
require('../lib/mcp/server').main(mode).catch((e) => { process.stderr.write(`[aipager-mcp] fatal: ${e.stack || e.message}\n`); process.exit(1); });
