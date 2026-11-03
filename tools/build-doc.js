// Builds the design document from sources and audits the whole project.
//   docs/src/layout.html            page shell: <head>, styles, nav, script; placeholders {{TOC}} {{HEADER}} {{SECTIONS}} {{DOC_VERSION}}
//   docs/src/header.html            page header
//   docs/src/sections/NN-<id>.html  one file per chapter: <section id="<id>" data-title="..." data-group="...">
// Generated automatically (never write these by hand):
//   - chapter numbers (from file order), <h2> headings, the table of contents
//   - cross references: <a data-ref="<id>"></a>  ->  <a href="#<id>">NN title</a>
//   - code blocks: <!--INCLUDE:path-->  ->  HTML-escaped file content
// Outputs: docs/claude-relay-design.html (standalone) and docs/artifact/claude-relay-design.html (fragment for publishing)
// Usage: node tools/build-doc.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DOC_VERSION = 'v0.3';
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'docs/src');
let problems = 0;
const ok = (m) => console.log('[OK]  ' + m);
const bad = (m) => { problems++; console.log('[ERR] ' + m); };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrEsc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// ---------- sections ----------
const files = fs.readdirSync(path.join(src, 'sections')).filter((f) => /^\d{2}-[a-z-]+\.html$/.test(f)).sort();
const sections = files.map((f, i) => {
  const text = fs.readFileSync(path.join(src, 'sections', f), 'utf8');
  const m = text.match(/^<section id="([a-z-]+)" data-title="([^"]+)" data-group="([^"]+)">/);
  if (!m) { bad(`${f}: must start with <section id=".." data-title=".." data-group="..">`); return null; }
  const [, id, title, group] = m;
  if (f.slice(3, -5) !== id) bad(`${f}: file name does not match section id "${id}"`);
  const no = String(i + 1).padStart(2, '0');
  return { file: f, id, title, group, no, body: text.slice(m[0].length) };
}).filter(Boolean);
const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
if (Object.keys(byId).length !== sections.length) bad('duplicate section ids');
ok(`${sections.length} sections loaded`);

// ---------- TOC ----------
let toc = '';
let lastGroup = null;
for (const s of sections) {
  if (s.group !== lastGroup) { toc += `    <li class="group">${s.group}</li>\n`; lastGroup = s.group; }
  toc += `    <li><a href="#${s.id}">${s.title.replace(/（.*?）$/, '')}</a></li>\n`;
}

// ---------- assemble ----------
let refCount = 0;
const sectionHtml = sections.map((s) => {
  const body = s.body.replace(/<a data-ref="([a-z-]+)"><\/a>/g, (_, id) => {
    refCount++;
    const t = byId[id];
    if (!t) { bad(`${s.file}: data-ref to unknown section "${id}"`); return `<a href="#${id}">??</a>`; }
    return `<a href="#${id}">${t.no} ${t.title}</a>`;
  });
  return `<!-- ${s.file} -->\n<section id="${s.id}">\n  <h2><span class="no">${s.no}</span>${s.title}</h2>${body}`;
}).join('\n');

const layout = fs.readFileSync(path.join(src, 'layout.html'), 'utf8');
const header = fs.readFileSync(path.join(src, 'header.html'), 'utf8');
let html = layout
  .replace('{{TOC}}', toc.replace(/\n$/, ''))
  .replace('{{HEADER}}', header.replace('{{DOC_VERSION}}', DOC_VERSION).replace(/\n$/, ''))
  .replace('{{SECTIONS}}', sectionHtml)
  .replace('{{DOC_VERSION}}', DOC_VERSION);

let includes = 0;
html = html.replace(/<!--INCLUDE:([^>]+?)-->/g, (_, rel) => {
  const p = path.join(root, rel.trim());
  if (!fs.existsSync(p)) { bad('include not found: ' + rel); return ''; }
  includes++;
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return esc(text.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
});

const outPath = path.join(root, 'docs/claude-relay-design.html');
const standalone = '<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  html.replace(/\n<div class="shell">/, '\n</head>\n<body>\n<div class="shell">') + '\n</body>\n</html>\n';
fs.writeFileSync(outPath, standalone, { encoding: 'utf8' });
const fragPath = path.join(root, 'docs/artifact/claude-relay-design.html');
fs.mkdirSync(path.dirname(fragPath), { recursive: true });
fs.writeFileSync(fragPath, html, { encoding: 'utf8' });
ok(`built ${path.relative(root, outPath)} and artifact fragment (${includes} includes, ${refCount} cross-refs, ${Buffer.byteLength(standalone)} bytes)`);

// ---------- HTML checks ----------
for (const marker of ['<!--INCLUDE:', '{{TOC}}', '{{HEADER}}', '{{SECTIONS}}', '{{DOC_VERSION}}', '<a data-ref=']) {
  if (html.includes(marker)) bad('unresolved marker in output: ' + marker);
}
if (/<a href="#[^"]+">\d{2} /.test(sections.map((s) => s.body).join(''))) bad('hand-written numbered cross-ref found in a section source; use <a data-ref="id"></a>');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const missing = [...new Set(hrefs.filter((h) => !ids.has(h)))];
if (missing.length) bad('broken anchors: ' + missing.join(', ')); else ok(`anchors resolve (${hrefs.length} links)`);
const reserved = ['settings', 'sidebar', 'customize', 'upgrade', 'downloads'];
const clash = [...ids].filter((i) => reserved.includes(i) || i.startsWith('comment-'));
if (clash.length) bad('reserved ids used: ' + clash.join(', '));
const noScripts = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
for (const tag of ['section', 'table', 'details', 'div', 'pre', 'code', 'ol', 'ul', 'svg', 'figure']) {
  const open = (noScripts.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (noScripts.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) bad(`<${tag}> open=${open} close=${close}`);
}
for (const s of sections) {
  const o = (s.body.match(/<(div|table|details|ul|ol)[\s>]/g) || []).length;
  const c = (s.body.match(/<\/(div|table|details|ul|ol)>/g) || []).length;
  if (o !== c) bad(`${s.file}: block tags unbalanced (open ${o}, close ${c})`);
}
ok('tag balance checked (whole page and per section)');
const tIds = [...new Set([...html.matchAll(/<td class="num">(T\d{2})<\/td>/g)].map((m) => m[1]))];
tIds.forEach((t, i) => { if (t !== 'T' + String(i + 1).padStart(2, '0')) bad(`test ids not sequential: expected T${String(i + 1).padStart(2, '0')} got ${t}`); });
const tMentioned = [...new Set([...html.matchAll(/\bT(\d{2})\b/g)].map((m) => Number(m[1])))];
const tMax = tIds.length;
const tOutOfRange = tMentioned.filter((n) => n < 1 || n > tMax);
if (tOutOfRange.length) bad('test ids referenced but not defined: ' + tOutOfRange.join(', '));
ok(`test plan ids T01..T${String(tMax).padStart(2, '0')} sequential, all references defined`);

// ---------- encoding audit of all text files ----------
const textExt = new Set(['.json', '.jsonl', '.sql', '.txt', '.md', '.html', '.js', '.bat', '.ps1', '.sh', '.service', '.plist']);
const lfOnly = new Set(['.sh', '.service', '.plist']);
const decoder = new TextDecoder('utf-8', { fatal: true });
let audited = 0;
function audit(p) {
  audited++;
  const rel = path.relative(root, p);
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try { text = decoder.decode(buf); } catch { bad(`${rel}: invalid UTF-8`); return; }
  if (text.includes('\uFFFD')) bad(`${rel}: contains U+FFFD replacement char`);
  if (ext === '.ps1') { if (!hasBom) bad(`${rel}: .ps1 must have UTF-8 BOM`); }
  else if (hasBom) bad(`${rel}: must be UTF-8 without BOM`);
  if (ext === '.bat') {
    if (/[^\x00-\x7f]/.test(text)) bad(`${rel}: .bat must be pure ASCII`);
    if (/[^\r]\n/.test(text)) bad(`${rel}: .bat must use CRLF`);
  }
  if (ext === '.ps1' && /[^\r]\n/.test(text)) bad(`${rel}: .ps1 should use CRLF`);
  if (lfOnly.has(ext) && text.includes('\r')) bad(`${rel}: must use LF line endings`);
  if (ext === '.sh' && !(fs.statSync(p).mode & 0o111)) bad(`${rel}: .sh should be executable`);
  if (/(\u00c3.|\u00e2\u20ac|\u00ef\u00bc)/.test(text)) bad(`${rel}: looks like mojibake`);
}
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (textExt.has(path.extname(e.name).toLowerCase())) audit(p);
  }
})(root);
ok(`encoding audit: ${audited} text files`);

console.log(problems ? `\nFAILED: ${problems} problem(s)` : '\nBUILD + AUDIT PASSED');
process.exit(problems ? 1 : 0);
