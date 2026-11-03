'use strict';
// Minimal, case-sensitive glob for artifacts (same result on every OS). Supports **, *, ?.
const fs = require('node:fs');
const path = require('node:path');

function toRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function safePattern(p) {
  return typeof p === 'string' && p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..');
}

const SKIP = new Set(['.git', 'node_modules', '.aipager']);

function walk(root, rel = '', out = [], limit = 5000) {
  if (out.length >= limit) return out;
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(root, r, out, limit); } else if (e.isFile()) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function match(root, patterns) {
  const regs = patterns.filter(safePattern).map((p) => toRegex(p.replace(/\\/g, '/')));
  if (!regs.length) return [];
  return walk(root).filter((f) => regs.some((r) => r.test(f)));
}

module.exports = { match, toRegex, safePattern };
