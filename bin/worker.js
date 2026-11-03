#!/usr/bin/env node
'use strict';
// AIPager Worker entry point. Usage: node bin/worker.js --config <node.json>
// Started by start-worker.sh / start-worker.ps1 (which print the environment first).
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`); });
const { Worker } = require('../lib/worker/worker');
const { defaultNodeConfigPath } = require('../lib/common/paths');

const i = process.argv.indexOf('--config');
const file = i > 0 ? process.argv[i + 1] : defaultNodeConfigPath();
let worker;
(async () => {
  worker = new Worker(file);
  process.stderr.write(`[worker] config=${file} node_id=${worker.cfg.node_id} hub=${worker.cfg.hub_url} log=${worker.cfg.log.dir}\n`);
  await worker.start();
})().catch((e) => { process.stderr.write(`[worker] fatal: ${e.stack || e.message}\n`); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { if (worker) await worker.stop(); process.exit(0); });
}
