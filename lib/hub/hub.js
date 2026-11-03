'use strict';
// Hub assembly: config defaults, context, HTTP server, sweeper, bind with retry (Tailscale may start later).
const path = require('node:path');
const { createLogger } = require('../common/log');
const { readJson } = require('../common/config');
const { createContext } = require('./core');
const { buildServer } = require('./server');
const sweeper = require('./sweeper');
const P = require('../../spec/reference/presence');

function withDefaults(cfg) {
  const c = Object.assign({}, cfg);
  c.listen = Object.assign({ host: '127.0.0.1', port: 7300, bind_retry_sec: 5 }, c.listen || {});
  c.public_base_url = c.public_base_url || `http://${c.listen.host}:${c.listen.port}`;
  c.presence_defaults = c.presence_defaults || P.DEFAULT_PRESENCE;
  c.log = Object.assign({ level: 'info', dir: path.join(c.data_dir, 'logs'), keep_days: 30 }, c.log || {});
  return c;
}

function loadHubConfig(file) { return withDefaults(readJson(file)); }

async function startHub(cfg, { clock, sweepIntervalMs = 5000, log } = {}) {
  const c = withDefaults(cfg);
  const logger = log || createLogger({ comp: 'hub', dir: c.log.dir, level: c.log.level, keepDays: c.log.keep_days });
  const ctx = createContext({ cfg: c, log: logger, clock });
  const app = buildServer(ctx);
  const stopSweeper = sweepIntervalMs > 0 ? sweeper.start(ctx, sweepIntervalMs) : () => {};
  let address;
  for (;;) {
    try {
      address = await app.listen({ host: c.listen.host, port: c.listen.port });
      break;
    } catch (e) {
      if (e.code !== 'EADDRNOTAVAIL') throw e;
      logger.warn('hub.bind_retry', `cannot bind ${c.listen.host}:${c.listen.port} yet (Tailscale not up?)`, { retry_sec: c.listen.bind_retry_sec });
      await new Promise((r) => setTimeout(r, c.listen.bind_retry_sec * 1000));
    }
  }
  logger.info('hub.started', 'hub listening', { address, data_dir: c.data_dir, version: require('../../package.json').version });
  return {
    ctx, app, address, port: app.server.address().port,
    async stop() { stopSweeper(); await app.close(); ctx.db.close(); logger.info('hub.stopped', 'hub stopped'); },
  };
}

module.exports = { startHub, loadHubConfig, withDefaults };
