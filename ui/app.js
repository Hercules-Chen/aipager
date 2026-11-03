// AIPager Dashboard — plain ES module, no build step (open DevTools and set breakpoints directly).
// Routes (hash): #home #nodes #node-<id> #tasks #task-<id> #approvals #enroll. Add ?debug=1 to see raw JSON.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
let lang = safeGet('aipager.lang') || (navigator.language.startsWith('zh') ? 'zh-TW' : 'en');
let dict = {};
let token = safeGet('aipager.token', sessionStorage);
let debugData = {};
let editing = false;

function safeGet(k, store = localStorage) { try { return store.getItem(k); } catch { return null; } }
function safeSet(k, v, store = localStorage) { try { if (v === null) store.removeItem(k); else store.setItem(k, v); } catch { /* storage blocked */ } }
const t = (k) => dict[k] || k;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pill = (v) => `<span class="pill p-${esc(v)}">${esc(v)}</span>`;
function dur(sec) {
  if (sec == null) return '—';
  const en = lang === 'en';
  if (sec < 60) return en ? `${sec}s` : `${sec} 秒`;
  if (sec < 3600) return en ? `${Math.floor(sec / 60)} min` : `${Math.floor(sec / 60)} 分鐘`;
  if (sec < 86400) return en ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} m` : `${Math.floor(sec / 3600)} 小時 ${Math.floor((sec % 3600) / 60)} 分`;
  return en ? `${Math.floor(sec / 86400)} d` : `${Math.floor(sec / 86400)} 天`;
}
const ago = (iso) => (iso ? dur(Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))) : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString(lang) : '—');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(method, path, body, headers = {}) {
  const h = Object.assign({ Authorization: 'Bearer ' + token, 'Accept-Language': lang }, headers);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch('/api/v1' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  if (!res.ok) {
    const e = new Error(data && data.error ? `${data.error.code} ${data.error.message}` : res.status);
    e.code = data && data.error && data.error.code;
    e.traceId = res.headers.get('x-trace-id');
    throw e;
  }
  if (DEBUG) debugData[method + ' ' + path] = data;
  return data;
}

function debugBlock() {
  if (!DEBUG) return '';
  return `<details class="debug"><summary>debug: raw JSON</summary><div class="codebox">${esc(JSON.stringify(debugData, null, 2))}</div></details>`;
}

// ---------- login ----------
function renderLogin() {
  app.innerHTML = `<div class="card login"><h1>${t('login.title')}</h1><p class="muted">${t('login.hint')}</p>
    <form id="login"><input id="token" type="password" autocomplete="off" placeholder="apa_..." required><div class="actions"><button class="primary" type="submit">${t('login.button')}</button></div></form></div>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#token').value.trim();
    try { await api('GET', '/nodes'); safeSet('aipager.token', token, sessionStorage); startLive(); route(); } catch (err) { toast(err.message); }
  });
}

function logout() { token = null; safeSet('aipager.token', null, sessionStorage); renderLogin(); }

// ---------- home: who is asleep, what is stuck ----------
async function renderHome() {
  const [nodes, stuck, approvals] = await Promise.all([api('GET', '/nodes'), api('GET', '/tasks?stuck=1'), api('GET', '/approvals?state=pending')]);
  const waitingFor = {};
  for (const s of stuck.items) { const id = s.to.startsWith('worker@role:') ? null : s.to.slice(7); if (id && s.stuck_reason === 'waiting_node') waitingFor[id] = (waitingFor[id] || 0) + 1; }
  const asleep = nodes.items.filter((n) => n.presence !== 'online' && n.state !== 'pending');
  const pending = nodes.items.filter((n) => n.state === 'pending');
  app.innerHTML = `<h1>${t('nav.home')}</h1><div class="grid">
    <section class="card ${asleep.length ? 'alert' : ''}"><h2>${t('home.asleep')} <span class="count">${asleep.length}</span></h2>
      ${asleep.length ? `<div class="tablewrap"><table><tr><th>${t('col.node')}</th><th>${t('col.presence')}</th><th>${t('col.silent')}</th><th>${t('col.power')}</th><th>${t('col.lastWake')}</th><th>${t('col.waiting')}</th></tr>
      ${asleep.map((n) => `<tr class="click" data-href="#node-${esc(n.node_id)}"><td><b>${esc(n.node_id)}</b><br><span class="muted">${esc(n.meta.display_name)}</span></td><td>${pill(n.presence)}</td><td>${dur(n.silent_sec)}</td><td>${t('power.' + n.meta.power)}</td><td>${ago(n.last_wake_at)}</td><td>${waitingFor[n.node_id] || 0}</td></tr>`).join('')}</table></div>` : `<p class="empty">${t('home.noneAsleep')}</p>`}
    </section>
    <section class="card ${stuck.items.length ? 'danger' : ''}"><h2>${t('home.stuck')} <span class="count">${stuck.items.length}</span></h2>
      ${stuck.items.length ? `<div class="list">${stuck.items.map((s) => `<div class="item"><div class="head">${pill(s.stuck_reason)} <a href="#task-${esc(s.task_id)}">${esc(s.title)}</a> <span class="muted">${esc(s.from)} → ${esc(s.to)}</span></div><div class="detail">${esc(s.stuck_detail)}</div></div>`).join('')}</div>` : `<p class="empty">${t('home.noneStuck')}</p>`}
    </section>
    <section class="card ${pending.length ? 'alert' : ''}"><h2>${t('home.pendingNodes')} <span class="count">${pending.length}</span></h2>
      ${pending.length ? `<div class="list">${pending.map((n) => `<div class="item"><div class="head"><b>${esc(n.node_id)}</b> ${esc(n.meta.display_name)} ${pill(n.presence)}</div>
        <div class="detail">${esc((n.facts && `${n.facts.os}/${n.facts.arch} ${n.facts.os_version || ''} · ${n.facts.hostname} · claude ${n.facts.claude_version || '?'}`) || '')}</div>
        <div class="actions"><button class="primary" data-approve="${esc(n.node_id)}">${t('btn.approve')}</button><a class="btn" href="#node-${esc(n.node_id)}">${t('node.edit')}</a></div></div>`).join('')}</div>` : `<p class="empty">${t('home.nonePending')}</p>`}
    </section>
    <section class="card ${approvals.items.length ? 'alert' : ''}"><h2>${t('home.approvals')} <span class="count">${approvals.items.length}</span></h2>
      ${approvals.items.length ? approvalList(approvals.items) : `<p class="empty">${t('home.noneApprovals')}</p>`}
    </section></div>${debugBlock()}`;
  bindApprovals();
  app.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/nodes/${b.dataset.approve}/state`, { state: 'active' }); toast(t('done')); route(); }));
}

// ---------- nodes ----------
async function renderNodes() {
  const nodes = await api('GET', '/nodes');
  app.innerHTML = `<h1>${t('nav.nodes')}</h1><div class="toolbar"><input id="filter" placeholder="filter" value="${esc(renderNodes.filter || '')}"></div>
    <div class="card tablewrap"><table id="ntable"><tr><th>${t('col.node')}</th><th>${t('col.state')}</th><th>${t('col.presence')}</th><th>${t('col.silent')}</th><th>${t('col.power')}</th><th>${t('col.os')}</th><th>${t('col.roles')}</th><th>${t('col.labels')}</th><th>${t('col.profiles')}</th><th>${t('col.running')}</th></tr>
    ${nodes.items.map((n) => `<tr class="click" data-href="#node-${esc(n.node_id)}" data-text="${esc([n.node_id, n.meta.display_name, n.meta.roles.join(' '), Object.entries(n.meta.labels).map((x) => x.join('=')).join(' '), n.presence, n.state].join(' ').toLowerCase())}">
      <td><b>${esc(n.node_id)}</b><br><span class="muted">${esc(n.meta.display_name)}</span></td><td>${pill(n.state)}</td><td>${pill(n.presence)}</td><td>${n.presence === 'online' ? '' : dur(n.silent_sec)}</td>
      <td>${t('power.' + n.meta.power)}</td><td>${esc(n.facts ? n.facts.os + '/' + n.facts.arch : '—')}</td><td>${esc(n.meta.roles.join(', '))}</td>
      <td class="mono">${esc(Object.entries(n.meta.labels).map((x) => x.join('=')).join(' '))}</td><td>${esc(n.profiles.map((p) => p.name).join(', '))}${n.profiles_error ? ' <span class="bad-text">⚠ profiles.json</span>' : ''}</td><td>${n.capacity.running}/${n.capacity.max_concurrent}</td></tr>`).join('')}</table></div>${debugBlock()}`;
  const f = $('#filter');
  const apply = () => { renderNodes.filter = f.value; const q = f.value.toLowerCase(); app.querySelectorAll('#ntable tr[data-text]').forEach((r) => { r.hidden = q && !r.dataset.text.includes(q); }); };
  f.addEventListener('input', apply);
  apply();
}

async function renderNode(id) {
  const [n, h] = await Promise.all([api('GET', '/nodes/' + encodeURIComponent(id)), api('GET', `/nodes/${encodeURIComponent(id)}/history`)]);
  const m = n.meta;
  const pres = m.presence || {};
  const stateBtns = { pending: ['approve', 'disable', 'retire'], active: ['drain', 'disable', 'retire'], draining: ['enable', 'disable', 'retire'], disabled: ['enable', 'retire'], retired: [] }[n.state];
  app.innerHTML = `<h1>${esc(n.node_id)} · ${esc(m.display_name)} ${pill(n.state)} ${pill(n.presence)}</h1>
  <div class="grid">
    <section class="card"><h2>${t('node.edit')} <span class="count">meta_version ${n.meta_version}</span></h2>
      <form id="meta" class="grid-form">
        <label for="f-name">${t('field.display_name')}</label><input id="f-name" value="${esc(m.display_name)}" required maxlength="64">
        <label for="f-desc">${t('field.description')}</label><input id="f-desc" value="${esc(m.description || '')}" maxlength="500">
        <label for="f-roles">${t('field.roles')}</label><input id="f-roles" value="${esc(m.roles.join(', '))}">
        <label for="f-labels">${t('field.labels')}</label><textarea id="f-labels">${esc(Object.entries(m.labels).map((x) => x.join('=')).join('\n'))}</textarea>
        <label for="f-power">${t('field.power')}</label><select id="f-power">${['server', 'desktop', 'laptop'].map((p) => `<option value="${p}" ${p === m.power ? 'selected' : ''}>${t('power.' + p)}</option>`).join('')}</select>
        <label for="f-asleep">${t('field.asleep_after_sec')}</label><input id="f-asleep" type="number" min="30" placeholder="${n.presence_settings.asleep_after_sec}" value="${pres.asleep_after_sec ?? ''}">
        <label for="f-offline">${t('field.offline_after_sec')}</label><input id="f-offline" type="number" min="60" placeholder="${n.presence_settings.offline_after_sec}" value="${pres.offline_after_sec ?? ''}">
        <label for="f-grace">${t('field.suspend_grace_sec')}</label><input id="f-grace" type="number" min="0" placeholder="${n.presence_settings.suspend_grace_sec}" value="${pres.suspend_grace_sec ?? ''}">
        <label for="f-owner">${t('field.owner')}</label><input id="f-owner" value="${esc(m.owner || '')}" maxlength="64">
        <label for="f-notes">${t('field.notes')}</label><textarea id="f-notes" maxlength="2000">${esc(m.notes || '')}</textarea>
        <span></span><div class="actions"><button class="primary" type="submit">${t('btn.save')}</button></div>
      </form>
      <div class="actions">${stateBtns.map((s) => `<button type="button" data-state="${s}" class="${s === 'retire' ? 'danger' : ''}">${t('btn.' + s)}</button>`).join('')}</div>
    </section>
    <section class="card"><h2>${t('node.facts')}</h2><dl class="kv">
      ${Object.entries(Object.assign({ last_seen: when(n.last_seen), silent: n.presence === 'online' ? '—' : dur(n.silent_sec), last_wake_at: when(n.last_wake_at), online_hours_7d: n.online_hours_7d }, n.facts || {}))
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      <dt>profiles</dt><dd>${esc(n.profiles.map((p) => p.name + (p.description ? ` — ${p.description}` : '')).join('\n')) || '—'}</dd>
      ${n.profiles_error ? `<dt class="bad-text">profiles_error</dt><dd class="bad-text">${esc(n.profiles_error)}</dd>` : ''}
      <dt>${t('node.presenceSettings')}</dt><dd class="mono">${esc(JSON.stringify(n.presence_settings))}</dd></dl>
    </section>
    <section class="card"><h2>${t('node.history')}</h2><div class="list">
      ${h.meta.map((x) => `<div class="item"><div class="head"><b>v${x.meta_version}</b> <span class="muted">${when(x.changed_at)} · ${esc(x.changed_by)}${x.change_note ? ' · ' + esc(x.change_note) : ''}</span>
        ${x.meta_version !== n.meta_version ? `<button type="button" data-rollback="${x.meta_version}">${t('btn.rollback')}</button>` : ''}</div>
        <div class="detail mono">${esc(JSON.stringify(x.meta))}</div></div>`).join('')}
      ${h.presence.slice(0, 30).map((x) => `<div class="muted wrap-any">${when(x.created_at)} ${esc(x.kind)} ${esc(JSON.stringify(x.data))}</div>`).join('')}</div>
    </section></div>${debugBlock()}`;
  const form = $('#meta');
  form.addEventListener('input', () => { editing = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (v) => (v === '' ? undefined : Number(v));
    const labels = {};
    for (const line of $('#f-labels').value.split('\n').map((l) => l.trim()).filter(Boolean)) { const i = line.indexOf('='); if (i > 0) labels[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    for (const k of Object.keys(m.labels)) if (!(k in labels)) labels[k] = null;
    const presence = {};
    for (const [k, el] of [['asleep_after_sec', '#f-asleep'], ['offline_after_sec', '#f-offline'], ['suspend_grace_sec', '#f-grace']]) if (num($(el).value) !== undefined) presence[k] = num($(el).value);
    const patch = { display_name: $('#f-name').value.trim(), roles: $('#f-roles').value.split(',').map((s) => s.trim()).filter(Boolean), labels, power: $('#f-power').value,
      description: $('#f-desc').value.trim() || null, owner: $('#f-owner').value.trim() || null, notes: $('#f-notes').value.trim() || null, presence: Object.keys(presence).length ? presence : null };
    try {
      await api('PATCH', `/nodes/${encodeURIComponent(id)}/meta`, patch, { 'If-Match': String(n.meta_version) });
      editing = false;
      toast(t('saved'));
      route();
    } catch (err) {
      if (err.code === 'E_META_CONFLICT') { editing = false; toast(t('conflict')); route(); } else toast(err.message);
    }
  });
  app.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', async () => {
    const st = b.dataset.state;
    if (st === 'retire' && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = t('confirm.retire'); return; }
    const map = { approve: 'active', enable: 'active', drain: 'draining', disable: 'disabled', retire: 'retired' };
    try { await api('POST', `/nodes/${encodeURIComponent(id)}/state`, { state: map[st] }); toast(t('done')); route(); } catch (err) { toast(err.message); }
  }));
  app.querySelectorAll('[data-rollback]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('POST', `/nodes/${encodeURIComponent(id)}/meta/rollback`, { to_version: Number(b.dataset.rollback) }); toast(t('saved')); route(); } catch (err) { toast(err.message); }
  }));
}

// ---------- tasks ----------
async function renderTasks() {
  const st = renderTasks.state || '';
  const data = await api('GET', '/tasks' + (st ? '?state=' + st : ''));
  app.innerHTML = `<h1>${t('nav.tasks')}</h1><div class="toolbar"><label for="st">${t('filter.state')}</label><select id="st"><option value="">${t('filter.all')}</option>
    ${['queued', 'claimed', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'expired'].map((s) => `<option ${s === st ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="card tablewrap"><table><tr><th>${t('col.task')}</th><th>${t('col.state')}</th><th>${t('col.title')}</th><th>${t('col.from')}</th><th>${t('col.to')}</th><th>${t('col.created')}</th></tr>
    ${data.items.map((x) => `<tr class="click" data-href="#task-${esc(x.task_id)}"><td class="mono">${esc(x.task_id)}</td><td>${pill(x.state)}</td><td>${esc(x.title)}${x.node_asleep_since ? ' <span class="warn-text">⏾</span>' : ''}</td><td>${esc(x.from)}</td><td>${esc(x.to)}${x.assigned_node ? ` → ${esc(x.assigned_node)}` : ''}</td><td>${ago(x.created_at)}</td></tr>`).join('')}</table></div>${debugBlock()}`;
  $('#st').addEventListener('change', (e) => { renderTasks.state = e.target.value; route(); });
}

async function renderTask(id) {
  const x = await api('GET', `/tasks/${id}?events=1`);
  const r = x.result;
  app.innerHTML = `<h1>${esc(x.title)} ${pill(x.state)}</h1><div class="grid">
    <section class="card"><dl class="kv">
      ${[['task_id', x.task_id], ['from', x.from], ['to', x.to], ['assigned_node', x.assigned_node], ['profile', x.profile], ['attempt', `${x.attempt}/${x.max_attempts}`], ['hop', x.hop],
    ['created_at', when(x.created_at)], ['started_at', when(x.started_at)], ['finished_at', when(x.finished_at)], ['expires_at', when(x.expires_at)], ['trace_id', x.trace_id], ['thread_id', x.thread_id]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v ?? '—')}</dd>`).join('')}
      ${x.node_status ? `<dt>node</dt><dd>${esc(x.node_status.node_id)} ${pill(x.node_status.presence)} ${x.node_status.presence === 'online' ? '' : dur(x.node_status.silent_sec)}</dd>` : ''}
      ${x.node_asleep_since ? `<dt class="warn-text">asleep since</dt><dd class="warn-text">${when(x.node_asleep_since)}</dd>` : ''}</dl>
      ${TERMINAL.includes(x.state) ? '' : `<div class="actions"><button class="danger" id="cancel">${t('btn.cancelTask')}</button></div>`}
      <h2 style="margin-top:14px">instructions</h2><div class="codebox">${esc(x.envelope.payload.instructions)}</div>
    </section>
    <section class="card"><h2>${t('task.events')}</h2><ul class="timeline">${(x.events || []).map((e) => `<li><span class="muted">${new Date(e.created_at).toLocaleTimeString(lang)}</span><span>${pill(e.phase)}</span><span>${esc(e.message || '')}</span></li>`).join('') || '<li class="empty">—</li>'}</ul>
      ${r ? `<h2 style="margin-top:14px">${t('task.result')} ${pill(r.status)}</h2><div class="codebox">${esc(r.summary)}</div>
        ${r.error ? `<p class="bad-text">${esc(r.error.code)} ${esc(r.error.message)}</p>` : ''}
        ${r.output !== undefined ? `<div class="codebox">${esc(JSON.stringify(r.output, null, 2))}</div>` : ''}
        ${r.metrics ? `<p class="muted">${esc(JSON.stringify(r.metrics))}</p>` : ''}
        ${(r.artifacts || []).length ? `<h2>${t('task.artifacts')}</h2><div class="actions">${r.artifacts.map((a) => `<button data-blob="${esc(a.sha256)}" data-name="${esc(a.name)}">${esc(a.name)} (${a.size} B)</button>`).join('')}</div>` : ''}` : ''}
    </section></div>${debugBlock()}`;
  const c = $('#cancel');
  if (c) c.addEventListener('click', async () => { try { await api('POST', `/tasks/${id}/cancel`, { reason: 'cancelled from dashboard' }); toast(t('done')); route(); } catch (err) { toast(err.message); } });
  app.querySelectorAll('[data-blob]').forEach((b) => b.addEventListener('click', async () => {
    const res = await fetch('/api/v1/blobs/' + b.dataset.blob, { headers: { Authorization: 'Bearer ' + token } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = b.dataset.name.split('/').pop(); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }));
}

// ---------- approvals ----------
function approvalList(items) {
  return `<div class="list">${items.map((a) => `<div class="item"><div class="head">${pill(a.risk)} <b>${esc(a.tool_name)}</b> <a href="#task-${esc(a.task_id)}">${esc(a.task ? a.task.title : a.task_id)}</a>
    <span class="muted">${esc(a.task ? a.task.assigned_node : '')} · ${lang === 'en' ? 'auto-deny in' : '自動拒絕倒數'} ${dur(Math.max(0, Math.round((Date.parse(a.expires_at) - Date.now()) / 1000)))}</span></div>
    <div class="codebox">${esc(JSON.stringify(a.tool_input, null, 2))}</div>
    <div class="actions"><input data-note="${esc(a.approval_id)}" placeholder="${t('field.note')}" aria-label="${t('field.note')}">
    <button class="primary" data-decide="allow" data-id="${esc(a.approval_id)}">${t('btn.allow')}</button><button class="danger" data-decide="deny" data-id="${esc(a.approval_id)}">${t('btn.deny')}</button></div></div>`).join('')}</div>`;
}

function bindApprovals() {
  app.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => {
    const note = (app.querySelector(`[data-note="${b.dataset.id}"]`) || {}).value || undefined;
    try { await api('POST', `/approvals/${b.dataset.id}/decision`, { decision: b.dataset.decide, note }); toast(t('done')); route(); } catch (err) { toast(err.message); }
  }));
  app.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('input', () => { editing = true; }));
}

async function renderApprovals() {
  const p = await api('GET', '/approvals?state=pending');
  const all = await api('GET', '/approvals');
  app.innerHTML = `<h1>${t('nav.approvals')}</h1><section class="card">${p.items.length ? approvalList(p.items) : `<p class="empty">${t('home.noneApprovals')}</p>`}</section>
    <section class="card" style="margin-top:14px"><div class="tablewrap"><table><tr><th>id</th><th>${t('col.state')}</th><th>tool</th><th>${t('col.task')}</th><th>note</th><th>${t('col.created')}</th></tr>
    ${all.items.filter((a) => a.state !== 'pending').map((a) => `<tr><td class="mono">${esc(a.approval_id)}</td><td>${pill(a.state)}</td><td>${esc(a.tool_name)}</td><td><a href="#task-${esc(a.task_id)}">${esc(a.task ? a.task.title : a.task_id)}</a></td><td>${esc(a.note || '')}</td><td>${ago(a.created_at)}</td></tr>`).join('')}</table></div></section>${debugBlock()}`;
  bindApprovals();
}

// ---------- enroll ----------
async function renderEnroll() {
  const list = await api('GET', '/admin/enrollments');
  app.innerHTML = `<h1>${t('nav.enroll')}</h1><div class="grid"><section class="card"><form id="en" class="grid-form">
      <label for="e-name">${t('field.display_name')}</label><input id="e-name" required maxlength="64">
      <label for="e-power">${t('field.power')}</label><select id="e-power">${['desktop', 'laptop', 'server'].map((p) => `<option value="${p}">${t('power.' + p)}</option>`).join('')}</select>
      <label for="e-roles">${t('field.roles')}</label><input id="e-roles">
      <label for="e-labels">${t('field.labels')}</label><textarea id="e-labels"></textarea>
      <label for="e-ttl">${t('field.ttl')}</label><select id="e-ttl"><option value="3600">1 h</option><option value="86400" selected>24 h</option><option value="604800">7 d</option></select>
      <label for="e-node">${t('field.node_id')}</label><input id="e-node" pattern="[a-z0-9][a-z0-9-]{1,31}">
      <label for="e-auto">${t('field.auto_approve')}</label><input id="e-auto" type="checkbox" style="width:auto">
      <span></span><div class="actions"><button class="primary" type="submit">${t('btn.create')}</button></div></form><div id="code"></div></section>
    <section class="card"><h2>${t('enroll.list')}</h2><div class="tablewrap"><table><tr><th>id</th><th>${t('col.state')}</th><th>${t('col.name')}</th><th>node</th><th>expires</th><th></th></tr>
    ${list.items.map((e) => `<tr><td class="mono">${esc(e.enrollment_id)}</td><td>${pill(e.status)}</td><td>${esc(e.preset.display_name || '')}</td><td>${esc(e.used_by_node || e.bound_node_id || '')}</td><td>${when(e.expires_at)}</td>
      <td>${e.status === 'open' ? `<button data-revoke="${esc(e.enrollment_id)}">${t('btn.revoke')}</button>` : ''}</td></tr>`).join('')}</table></div></section></div>${debugBlock()}`;
  $('#en').addEventListener('input', () => { editing = true; });
  $('#en').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const labels = {};
    for (const line of $('#e-labels').value.split('\n').map((l) => l.trim()).filter(Boolean)) { const i = line.indexOf('='); if (i > 0) labels[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    const body = { preset: { display_name: $('#e-name').value.trim(), power: $('#e-power').value, roles: $('#e-roles').value.split(',').map((s) => s.trim()).filter(Boolean), labels },
      ttl_sec: Number($('#e-ttl').value), auto_approve: $('#e-auto').checked };
    if ($('#e-node').value.trim()) body.node_id = $('#e-node').value.trim();
    try {
      const r = await api('POST', '/admin/enrollments', body);
      editing = true; // keep the code on screen; live updates must not wipe it
      $('#code').innerHTML = `<h2 style="margin-top:14px">${t('enroll.code')}</h2><div class="codebox" id="the-code">${esc(r.code)}</div>
        <h2 style="margin-top:10px">${t('enroll.cmd')}</h2><div class="codebox" id="the-cmd">${esc(r.join_commands.linux)}</div><div class="actions"><button id="copy">${t('btn.copy')}</button></div>`;
      $('#copy').addEventListener('click', () => navigator.clipboard.writeText(r.join_commands.linux).then(() => toast(t('done')), () => toast('copy failed — select the text')));
    } catch (err) { toast(err.message); }
  });
  app.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => { await api('DELETE', '/admin/enrollments/' + b.dataset.revoke); route(); }));
}

// ---------- routing & live updates ----------
async function route() {
  if (!token) return renderLogin();
  debugData = {};
  editing = false;
  const h = location.hash.slice(1) || 'home';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + h.split('-')[0] || (h.startsWith('node-') && a.getAttribute('href') === '#nodes') || (h.startsWith('task-') && a.getAttribute('href') === '#tasks')));
  try {
    if (h === 'home') await renderHome();
    else if (h === 'nodes') await renderNodes();
    else if (h.startsWith('node-')) await renderNode(h.slice(5));
    else if (h === 'tasks') await renderTasks();
    else if (h.startsWith('task-')) await renderTask(h.slice(5));
    else if (h === 'approvals') await renderApprovals();
    else if (h === 'enroll') await renderEnroll();
    else await renderHome();
  } catch (e) {
    if (e.message !== 'unauthorized') app.innerHTML = `<div class="card danger"><p class="bad-text">${esc(e.message)}</p><p class="muted">trace_id ${esc(e.traceId || '')}</p></div>`;
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  if (editing) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(route, 600);
}

async function startLive() {
  const dot = $('#live');
  for (;;) {
    if (!token) return;
    try {
      const res = await fetch('/api/v1/events/stream', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error(res.status);
      dot.classList.add('on');
      const dec = new TextDecoder();
      for await (const chunk of res.body) if (/^event: /m.test(dec.decode(chunk, { stream: true }))) scheduleRefresh();
    } catch { /* reconnect below */ }
    dot.classList.remove('on');
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function loadLang() {
  dict = await (await fetch(`i18n/${lang}.json`)).json();
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $('#lang').value = lang;
}

document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a,button')) location.hash = tr.dataset.href;
});
$('#lang').addEventListener('change', async (e) => { lang = e.target.value; safeSet('aipager.lang', lang); await loadLang(); route(); });
$('#logout').addEventListener('click', logout);
window.addEventListener('hashchange', route);
setInterval(() => { if (!editing && (location.hash || '#home') === '#home') route(); }, 30000); // silent durations keep moving
await loadLang();
if (token) startLive();
route();
