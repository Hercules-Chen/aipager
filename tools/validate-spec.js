// Validates every spec artifact. Exit code 0 = all checks passed.
//   - envelope.schema.json + examples/*.json + negative cases
//   - api.schema.json + examples/api/<defName>.<variant>.json + negative cases
//   - config templates parse, MCP tool input schemas compile
//   - reference/presence.js behaviour (presence, lease grace, sleep detection, dispatch decision)
//   - hub-schema.sql applies twice; claim query honours priority, state, role, os, labels
// Usage: node tools/validate-spec.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const root = path.resolve(__dirname, '..');
let failed = 0;
const ok = (m) => console.log('[OK]  ' + m);
const bad = (m) => { failed++; console.log('[ERR] ' + m); };
const expect = (cond, msg) => (cond ? ok(msg) : bad(msg));

function readJson(p) {
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad(`${path.relative(root, p)} has UTF-8 BOM`);
  return JSON.parse(buf.toString('utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// ---------- envelope ----------
const envelopeSchema = readJson(path.join(root, 'spec/schemas/envelope.schema.json'));
const validateEnvelope = ajv.compile(envelopeSchema);
ok('envelope schema compiled');
const exDir = path.join(root, 'spec/examples');
for (const f of fs.readdirSync(exDir).filter((f) => f.endsWith('.json')).sort()) {
  const data = readJson(path.join(exDir, f));
  if (validateEnvelope(data)) ok('envelope example valid: ' + f);
  else bad('envelope example invalid: ' + f + '\n      ' + ajv.errorsText(validateEnvelope.errors, { separator: '\n      ' }));
}
const base = readJson(path.join(exDir, 'task-create.json'));
const envelopeNegatives = {
  'bad ulid (contains I)': (e) => { e.id = '01JBX7Q3M8ZK4N2P6R9T0V1W2I'; },
  'unknown top-level field': (e) => { e.foo = 1; },
  'profile with uppercase': (e) => { e.payload.profile = 'Build'; },
  'timeout too large': (e) => { e.payload.limits.timeout_sec = 99999; },
  'role target with non-worker agent': (e) => { e.to = { role: 'builder', agent: 'main' }; },
  'then item without to': (e) => { delete e.payload.then[0].to; },
  'unknown payload field': (e) => { e.payload.cwd = 'C:\\'; },
  'requires.os unknown value': (e) => { e.payload.then[0].requires = { os: ['freebsd'] }; },
  'requires.os empty array': (e) => { e.payload.then[0].requires = { os: [] }; },
  'requires.labels key uppercase': (e) => { e.payload.requires = { labels: { Xcode: '16' } }; },
  'requires.labels key with dot': (e) => { e.payload.requires = { labels: { 'a.b': '1' } }; },
  'dispatch.on_unavailable unknown': (e) => { e.payload.dispatch = { on_unavailable: 'wait' }; },
};
for (const [name, mutate] of Object.entries(envelopeNegatives)) {
  const e = structuredClone(base); mutate(e);
  expect(!validateEnvelope(e), 'envelope negative rejected: ' + name);
}

// ---------- api bodies ----------
const apiSchema = readJson(path.join(root, 'spec/schemas/api.schema.json'));
ajv.addSchema(apiSchema);
const apiValidator = (def) => ajv.getSchema(`${apiSchema.$id}#/$defs/${def}`);
ok('api schema compiled (' + Object.keys(apiSchema.$defs).length + ' defs)');
const apiDir = path.join(exDir, 'api');
const apiExamples = {};
for (const f of fs.readdirSync(apiDir).filter((f) => f.endsWith('.json')).sort()) {
  const def = f.split('.')[0];
  const v = apiValidator(def);
  if (!v) { bad(`api example ${f}: no $defs/${def}`); continue; }
  const data = readJson(path.join(apiDir, f));
  apiExamples[def] = data;
  if (v(data)) ok(`api example valid: ${f} -> ${def}`);
  else bad(`api example invalid: ${f}\n      ` + ajv.errorsText(v.errors, { separator: '\n      ' }));
}
const apiNegatives = [
  ['enrollmentCreated', 'code with lowercase', (d) => { d.code = 'rle_k7qf-2xma-pl4d-9rte'; }],
  ['enrollResponse', 'short node token', (d) => { d.node_token = 'rln_abc'; }],
  ['nodeView', 'meta label value "*"', (d) => { d.meta.labels.any = '*'; }],
  ['nodeView', 'unknown presence', (d) => { d.presence = 'sleeping'; }],
  ['nodeMetaPatch', 'empty patch', () => ({})],
  ['nodeMetaPatch', 'presence threshold too small', (d) => { d.presence = { asleep_after_sec: 5 }; }],
  ['heartbeatRequest', 'facts os unknown', (d) => { d.facts.os = 'freebsd'; }],
  ['heartbeatRequest', 'missing meta_version', (d) => { delete d.meta_version; }],
  ['targetUnavailable', 'wrong error code', (d) => { d.error.code = 'E_TIMEOUT'; }],
];
for (const [def, name, mutate] of apiNegatives) {
  const d = structuredClone(apiExamples[def]);
  const replaced = mutate(d);
  expect(!apiValidator(def)(replaced || d), `api negative rejected: ${def} ${name}`);
}

// ---------- configs and MCP tools ----------
for (const f of fs.readdirSync(path.join(root, 'spec/config')).sort()) {
  try { readJson(path.join(root, 'spec/config', f)); ok('config parses: ' + f); }
  catch (e) { bad('config parse failed: ' + f + ' ' + e.message); }
}
const tools = readJson(path.join(root, 'spec/mcp/relay-tools.json'));
for (const t of tools.tools) {
  try { ajv.compile(t.inputSchema); } catch (e) { bad('mcp tool schema invalid: ' + t.name + ' ' + e.message); }
}
ok('mcp tool input schemas compile: ' + tools.tools.length);

// ---------- reference algorithms ----------
const P = require(path.join(root, 'spec/reference/presence.js'));
const T0 = Date.parse('2026-11-03T09:00:00.000Z');
const ago = (sec) => new Date(T0 - sec * 1000).toISOString();
const node = (id, power, silentSec, extra = {}) => Object.assign({
  node_id: id, state: 'active', last_seen: silentSec == null ? null : ago(silentSec), meta: { power },
}, extra);

expect(P.computePresence(node('s', 'server', 30), T0).presence === 'online', 'presence: server silent 30s -> online');
expect(P.computePresence(node('s', 'server', 50), T0).presence === 'asleep', 'presence: server silent 50s -> asleep');
expect(P.computePresence(node('s', 'server', 700), T0).presence === 'offline', 'presence: server silent 700s -> offline');
expect(P.computePresence(node('l', 'laptop', 55), T0).presence === 'online', 'presence: laptop silent 55s -> online');
expect(P.computePresence(node('l', 'laptop', 3 * 86400), T0).presence === 'asleep', 'presence: laptop silent 3 days -> asleep');
expect(P.computePresence(node('l', 'laptop', 8 * 86400), T0).presence === 'offline', 'presence: laptop silent 8 days -> offline');
expect(P.computePresence(node('n', 'desktop', null), T0).presence === 'never', 'presence: never seen -> never');
expect(P.computePresence(node('o', 'laptop', 200, { meta: { power: 'laptop', presence: { asleep_after_sec: 300 } } }), T0).presence === 'online',
  'presence: per-node override asleep_after_sec=300 keeps silent 200s online');

const lease = { expires_at: ago(10) };
expect(!P.leaseExpired(lease, node('l', 'laptop', 600), T0), 'lease: laptop asleep 10 min is within 30 min suspend grace');
expect(P.leaseExpired(lease, node('l', 'laptop', 2400), T0), 'lease: laptop asleep 40 min exceeds grace -> expired');
expect(P.leaseExpired(lease, node('s', 'server', 60), T0), 'lease: server has no suspend grace -> expired');
expect(!P.leaseExpired({ expires_at: new Date(T0 + 5000).toISOString() }, node('s', 'server', 0), T0), 'lease: not yet expired');

expect(P.detectSleepGap(T0, T0 + 5000, 5000) === 0, 'sleep detect: normal 5s tick -> 0');
expect(P.detectSleepGap(T0, T0 + 5000 + 2470000, 5000) === 2470000, 'sleep detect: 41 min jump detected');
expect(P.awakeElapsedMs(T0, T0 + 3600000, [2400000]) === 1200000, 'timeout: 60 min wall - 40 min sleep = 20 min awake');

const hubCfg = readJson(path.join(root, 'spec/config/hub.json'));
expect(JSON.stringify(hubCfg.presence_defaults) === JSON.stringify(P.DEFAULT_PRESENCE),
  'hub.json presence_defaults equals reference DEFAULT_PRESENCE');

const mac = node('macbook-hc', 'laptop', 2552);
const studio = node('mac-studio', 'desktop', 5);
let d = P.decideDispatch({ target: { kind: 'node', node: mac }, alternatives: [studio], onUnavailable: 'confirm' }, T0);
expect(d.action === 'refuse' && d.warnings[0].code === 'W_TARGET_ASLEEP' && d.alternatives[0] === 'mac-studio',
  'dispatch: asleep target + confirm -> refuse with W_TARGET_ASLEEP and alternative mac-studio');
d = P.decideDispatch({ target: { kind: 'node', node: mac }, alternatives: [studio], onUnavailable: 'queue' }, T0);
expect(d.action === 'create' && d.warnings.length === 1, 'dispatch: asleep target + queue -> create with warning');
d = P.decideDispatch({ target: { kind: 'node', node: studio }, onUnavailable: 'confirm' }, T0);
expect(d.action === 'create' && d.warnings.length === 0, 'dispatch: online target -> create, no warning');
d = P.decideDispatch({ target: { kind: 'node', node: node('n', 'desktop', null) }, onUnavailable: 'reject' }, T0);
expect(d.action === 'refuse' && d.warnings[0].code === 'W_TARGET_NEVER_SEEN', 'dispatch: never-seen target + reject -> refuse');
d = P.decideDispatch({ target: { kind: 'node', node: node('b', 'desktop', 5, { state: 'draining' }) }, onUnavailable: 'confirm' }, T0);
expect(d.action === 'refuse' && d.warnings[0].code === 'W_TARGET_DRAINING', 'dispatch: draining target -> refuse with W_TARGET_DRAINING');
d = P.decideDispatch({ target: { kind: 'role', role: 'tester', candidates: [mac, studio] }, onUnavailable: 'confirm' }, T0);
expect(d.action === 'create', 'dispatch: role with one online candidate -> create');
d = P.decideDispatch({ target: { kind: 'role', role: 'tester', candidates: [mac] }, onUnavailable: 'confirm' }, T0);
expect(d.action === 'refuse' && d.warnings[0].code === 'W_NO_ONLINE_CANDIDATE', 'dispatch: role with no online candidate -> refuse');
d = P.decideDispatch({ target: { kind: 'node', node: mac }, alternatives: [node('p', 'desktop', 5, { state: 'pending' })], onUnavailable: 'confirm' }, T0);
expect(d.alternatives.length === 0, 'dispatch: pending node is never offered as alternative');

// ---------- database ----------
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
const sql = fs.readFileSync(path.join(root, 'spec/sql/hub-schema.sql'), 'utf8');
try {
  db.exec(sql);
  db.exec(sql);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  ok('DDL applied twice (idempotent). tables=' + tables.join(','));

  const now = new Date(T0).toISOString();
  db.prepare("INSERT INTO threads(thread_id,trace_id,created_at,updated_at) VALUES('T1','x',?,?)").run(now, now);
  const addNode = db.prepare(`INSERT INTO nodes(node_id,state,display_name,roles,labels,power,os,arch,meta_updated_at,meta_updated_by,created_at)
                              VALUES(?,?,?,?,?,?,?,?,?, 'test', ?)`);
  addNode.run('build-pc', 'active', 'Build PC', '["builder","tester"]', '{}', 'desktop', 'windows', 'x64', now, now);
  addNode.run('macbook-hc', 'active', 'MacBook', '["tester"]', '{"xcode":"16","ios-sim":"yes"}', 'laptop', 'macos', 'arm64', now, now);
  addNode.run('new-mac', 'pending', 'New Mac', '["tester"]', '{"xcode":"16"}', 'laptop', 'macos', 'arm64', now, now);

  const ins = db.prepare(`INSERT INTO tasks(task_id,thread_id,from_node,from_agent,to_node,to_role,profile,require_os,require_arch,require_labels,
                          title,priority,state,envelope,trace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const task = (id, toNode, toRole, profile, os, labels, prio) =>
    ins.run(id, 'T1', 'dev-pc', 'main', toNode, toRole, profile, os, null, labels, id, prio, 'queued', '{}', 'x', now, now);
  task('A', 'build-pc', null, 'build', null, null, 7);
  task('B', 'build-pc', null, 'build', null, null, 2);
  task('M', null, 'tester', 'ios', '["macos"]', '{"xcode":"16"}', 1);
  task('X', null, 'tester', 'ios', null, '{"xcode":"15"}', 1);
  task('H', null, 'tester', 'ios', null, '{"ios-sim":"*"}', 3);

  const claim = db.prepare(`UPDATE tasks SET state='claimed', assigned_node=n.node_id, lease_id=:lease, lease_expires_at=:exp,
           attempt=attempt+1, claimed_at=:now, updated_at=:now
      FROM (SELECT node_id, roles, labels, os, arch FROM nodes WHERE node_id=:node AND state='active') AS n
     WHERE tasks.task_id = (
       SELECT t.task_id FROM tasks t
        WHERE t.state='queued'
          AND (t.to_node=n.node_id OR t.to_role IN (SELECT value FROM json_each(n.roles)))
          AND t.profile IN (SELECT value FROM json_each(:free_profiles))
          AND (t.require_os   IS NULL OR n.os   IN (SELECT value FROM json_each(t.require_os)))
          AND (t.require_arch IS NULL OR n.arch IN (SELECT value FROM json_each(t.require_arch)))
          AND (t.require_labels IS NULL OR NOT EXISTS (
                SELECT 1 FROM json_each(t.require_labels) r
                 WHERE NOT (CASE WHEN r.value = '*'
                                 THEN json_extract(n.labels, '$."' || r.key || '"') IS NOT NULL
                                 ELSE json_extract(n.labels, '$."' || r.key || '"') IS r.value END)))
        ORDER BY t.priority ASC, t.created_at ASC, t.task_id ASC
        LIMIT 1)
    RETURNING tasks.task_id`);
  const args = (n, profiles) => ({ ':node': n, ':lease': 'L', ':exp': now, ':now': now, ':free_profiles': JSON.stringify(profiles) });
  let r = claim.get(args('build-pc', ['build']));
  expect(r && r.task_id === 'B', 'claim: highest priority first (B)');
  r = claim.get(args('build-pc', ['ios']));
  expect(!r, 'claim: windows node without xcode label claims none of M/X/H');
  r = claim.get(args('new-mac', ['ios']));
  expect(!r, 'claim: pending node cannot claim');
  r = claim.get(args('macbook-hc', ['ios']));
  expect(r && r.task_id === 'M', 'claim: macbook matches os=macos + xcode=16 (M)');
  r = claim.get(args('macbook-hc', ['ios']));
  expect(r && r.task_id === 'H', 'claim: wildcard label "ios-sim":"*" matches (H), xcode=15 task X skipped');
  r = claim.get(args('macbook-hc', ['ios']));
  expect(!r, 'claim: task X (xcode=15) is never claimed by xcode=16 node');
  try { ins.run('C', 'T1', 'dev-pc', 'main', null, null, 'build', null, null, null, 'x', 5, 'queued', '{}', 'x', now, now); bad('CHECK to_node/to_role not enforced'); }
  catch { ok('CHECK (to_node OR to_role) enforced'); }
  try { addNode.run('bad', 'sleeping', 'x', '[]', '{}', 'desktop', 'linux', 'x64', now, now); bad('CHECK nodes.state not enforced'); }
  catch { ok('CHECK nodes.state enforced'); }
} catch (e) { bad('DDL / claim failed: ' + e.message); }

console.log(failed ? `\nFAILED: ${failed} problem(s)` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
