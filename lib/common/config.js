'use strict';
const fs = require('node:fs');

// Read JSON written by any editor: strips a UTF-8 BOM if present (Windows Notepad adds one).
function readJson(p) {
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function readSecret(p) {
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trim();
}

// Write UTF-8 without BOM, LF, via a temp file + rename so readers never see a half-written file.
function writeJson(p, data, mode) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  fs.renameSync(tmp, p);
}

function writeSecret(p, value) {
  fs.writeFileSync(p, value + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows: ACL handled by restrictWindowsAcl */ }
}

module.exports = { readJson, readSecret, writeJson, writeSecret };
