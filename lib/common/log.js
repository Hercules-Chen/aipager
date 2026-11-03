'use strict';
// JSONL logger shared by every component. One file per component per day, UTF-8 without BOM.
// Never writes to stdout (stdout belongs to MCP / hooks); optional mirror to stderr.
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /\b(apa_|apn_|apt_|ape_|sk-ant-[a-z0-9]+-)([A-Za-z0-9_-]{4,})([A-Za-z0-9_-]{4})\b/g;

function mask(value) {
  if (typeof value === 'string') return value.replace(SECRET, (_, p, _mid, last) => `${p}***${last}`);
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|password|secret|authorization/i.test(k) && typeof v === 'string' ? mask(v).replace(/^(.{0,4}).*$/, '$1***') : mask(v);
    }
    return out;
  }
  return value;
}

function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

function createLogger({ comp, dir, level, base = {}, mirrorStderr = false, keepDays = 30 }) {
  const min = LEVELS[(process.env.AIPAGER_LOG_LEVEL || level || 'info').toLowerCase()] || LEVELS.info;
  let ready = false;
  function ensureDir() {
    if (ready || !dir) return;
    try { fs.mkdirSync(dir, { recursive: true }); ready = true; } catch { /* logging must never crash the app */ }
  }
  function prune() {
    if (!dir) return;
    try {
      const cutoff = Date.now() - keepDays * 86400000;
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(comp + '-') || !f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      }
    } catch { /* ignore */ }
  }
  prune();
  function write(lvl, event, msg, data, ctx) {
    if (LEVELS[lvl] < min) return;
    const now = new Date();
    const rec = Object.assign({ ts: now.toISOString(), level: lvl, comp }, base, ctx || {}, { event, msg });
    if (data !== undefined) rec.data = mask(data);
    const line = JSON.stringify(mask(rec)) + '\n';
    ensureDir();
    if (dir) { try { fs.appendFileSync(path.join(dir, `${comp}-${ymd(now)}.jsonl`), line, 'utf8'); } catch { /* ignore */ } }
    if (mirrorStderr) process.stderr.write(line);
  }
  const api = {
    debug: (e, m, d, c) => write('debug', e, m, d, c),
    info: (e, m, d, c) => write('info', e, m, d, c),
    warn: (e, m, d, c) => write('warn', e, m, d, c),
    error: (e, m, d, c) => write('error', e, m, d, c),
    child: (extra) => createLogger({ comp, dir, level, base: Object.assign({}, base, extra), mirrorStderr, keepDays: 3650 }),
  };
  return api;
}

module.exports = { createLogger, mask };
