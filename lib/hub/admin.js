'use strict';
// Local admin operations that run on the Hub machine without HTTP (aipagerctl admin init / restore).
const fs = require('node:fs');
const path = require('node:path');
const { createContext, issueToken } = require('./core');
const { withDefaults } = require('./hub');
const { createLogger } = require('../common/log');

function initAdmin(cfgRaw, label = 'initial admin') {
  const cfg = withDefaults(cfgRaw);
  fs.mkdirSync(cfg.data_dir, { recursive: true });
  const log = createLogger({ comp: 'hub', dir: cfg.log.dir, level: cfg.log.level });
  const ctx = createContext({ cfg, log });
  try {
    const t = issueToken(ctx, { kind: 'admin', label });
    ctx.event('token.created', { token_id: t.token_id, kind: 'admin', via: 'admin init' });
    log.info('admin.init', 'admin token created', { token_id: t.token_id });
    return Object.assign(t, { db: path.join(cfg.data_dir, 'aipager.db') });
  } finally { ctx.db.close(); }
}

function restore(cfgRaw, file) {
  const cfg = withDefaults(cfgRaw);
  const target = path.join(cfg.data_dir, 'aipager.db');
  if (!fs.existsSync(file)) throw new Error('backup file not found: ' + file);
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(target + suffix)) fs.renameSync(target + suffix, `${target}${suffix}.before-restore-${Date.now()}`);
  }
  fs.copyFileSync(file, target);
  return { restored: target };
}

module.exports = { initAdmin, restore };
