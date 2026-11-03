'use strict';
// HTTP client for the Hub REST API (Node 22 global fetch). Shared by worker, MCP, hint and aipagerctl.
const { AipError } = require('./errors');

class HubClient {
  constructor({ baseUrl, token, agent, lang = 'zh-TW', log, userAgent = 'aipager' }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.agent = agent;
    this.lang = lang;
    this.log = log;
    this.userAgent = userAgent;
  }

  // Returns { status, data, headers }. Throws AipError for HTTP errors (code from the body) and
  // AipError('E_UNAVAILABLE') for network failures after `retries` attempts.
  async request(method, p, { body, query, timeoutMs = 30000, headers = {}, raw, retries = 0, okStatuses = [] } = {}) {
    let url = this.baseUrl + '/api/v1' + p;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.append(k, String(v));
      const s = qs.toString();
      if (s) url += '?' + s;
    }
    const h = Object.assign({ 'Accept-Language': this.lang, 'User-Agent': this.userAgent }, headers);
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    if (this.agent) h['X-AIPager-Agent'] = this.agent;
    let payload;
    if (raw !== undefined) { payload = raw; h['Content-Type'] = h['Content-Type'] || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; }
    let attempt = 0;
    for (;;) {
      attempt++;
      let res;
      try {
        res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt <= retries) { await sleep(Math.min(16000, 1000 * 2 ** (attempt - 1))); continue; }
        throw new AipError('E_UNAVAILABLE', `cannot reach hub ${this.baseUrl}: ${e.cause ? e.cause.code || e.cause.message : e.message}`, { url: url.replace(/\?.*$/, '') });
      }
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (res.status === 503 && attempt <= retries) { await sleep(Math.min(16000, 1000 * 2 ** (attempt - 1))); continue; }
      if (res.status >= 400 && !okStatuses.includes(res.status)) {
        const err = data && data.error ? data.error : { code: 'E_HTTP_' + res.status, message: text.slice(0, 300) };
        const e = new AipError(err.code, err.message, err.detail);
        e.status = res.status;
        e.body = data;
        e.traceId = res.headers.get('x-trace-id');
        throw e;
      }
      return { status: res.status, data, headers: res.headers };
    }
  }

  get(p, o) { return this.request('GET', p, o); }
  post(p, body, o = {}) { return this.request('POST', p, Object.assign({ body }, o)); }
  patch(p, body, o = {}) { return this.request('PATCH', p, Object.assign({ body }, o)); }
  del(p, o) { return this.request('DELETE', p, o); }
}

// "worker@build-pc" -> {node, agent}; "worker@role:tester" -> {role, agent}; "build-pc" -> worker@build-pc
function parseAddress(s, defaultAgent = 'worker') {
  const str = String(s || '').trim();
  const at = str.indexOf('@');
  const agent = at >= 0 ? str.slice(0, at) : defaultAgent;
  const where = at >= 0 ? str.slice(at + 1) : str;
  if (where.startsWith('role:')) return { role: where.slice(5), agent };
  return { node: where, agent };
}

function formatAddress(a) { return a.role ? `${a.agent}@role:${a.role}` : `${a.agent}@${a.node}`; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { HubClient, parseAddress, formatAddress, sleep };
