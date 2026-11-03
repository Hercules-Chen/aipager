#!/usr/bin/env node
'use strict';
// AIPager Hub entry point. Usage: node bin/hub.js --config /etc/aipager/hub.json
// Chrome DevTools: start with  node --inspect=127.0.0.1:9229 bin/hub.js ...  (or AIPAGER_INSPECT_PORT via the service).
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`); });
const { startHub, loadHubConfig } = require('../lib/hub/hub');

const i = process.argv.indexOf('--config');
const file = i > 0 ? process.argv[i + 1] : process.env.AIPAGER_HUB_CONFIG || '/etc/aipager/hub.json';
let hub;
(async () => {
  const cfg = loadHubConfig(file);
  process.stderr.write(`[hub] config=${file} data_dir=${cfg.data_dir} listen=${cfg.listen.host}:${cfg.listen.port} log=${cfg.log.dir}\n`);
  hub = await startHub(cfg);
  process.stderr.write(`[hub] listening on ${hub.address}\n`);
})().catch((e) => { process.stderr.write(`[hub] fatal: ${e.stack || e.message}\n`); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { if (hub) await hub.stop(); process.exit(0); });
}
