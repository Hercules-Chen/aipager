// AIPager reference algorithms: node presence and dispatch decision (aipager/1.0).
// The Hub, the Dashboard and aipagerctl must behave exactly like these functions.
// Pure functions only (no I/O) so they can be unit-tested and copied into any component.
'use strict';

// Default presence thresholds per power class. hub.json "presence_defaults" may override these.
const DEFAULT_PRESENCE = Object.freeze({
  server:  Object.freeze({ asleep_after_sec: 45, offline_after_sec: 600,    suspend_grace_sec: 0,    alert_on_offline: true }),
  desktop: Object.freeze({ asleep_after_sec: 45, offline_after_sec: 7200,   suspend_grace_sec: 300,  alert_on_offline: false }),
  laptop:  Object.freeze({ asleep_after_sec: 60, offline_after_sec: 604800, suspend_grace_sec: 1800, alert_on_offline: false }),
});

// Effective settings = defaults of the node's power class, then the node's own overrides.
function effectiveSettings(meta, defaults = DEFAULT_PRESENCE) {
  const power = (meta && meta.power) || 'desktop';
  const base = defaults[power] || defaults.desktop;
  return Object.assign({}, base, (meta && meta.presence) || {});
}

// presence: never (enrolled, no heartbeat yet) | online | asleep | offline
function computePresence(node, nowMs, defaults = DEFAULT_PRESENCE) {
  const settings = effectiveSettings(node.meta, defaults);
  if (!node.last_seen) return { presence: 'never', silent_sec: null, settings };
  const silent = Math.max(0, Math.floor((nowMs - Date.parse(node.last_seen)) / 1000));
  let presence = 'online';
  if (silent > settings.offline_after_sec) presence = 'offline';
  else if (silent > settings.asleep_after_sec) presence = 'asleep';
  return { presence, silent_sec: silent, settings };
}

// A node may claim work only when it is active and currently online.
function canClaim(node, nowMs, defaults = DEFAULT_PRESENCE) {
  return node.state === 'active' && computePresence(node, nowMs, defaults).presence === 'online';
}

// Lease handling while the node sleeps: keep the lease during suspend_grace_sec after the node went silent.
function leaseExpired(lease, node, nowMs, defaults = DEFAULT_PRESENCE) {
  if (nowMs <= Date.parse(lease.expires_at)) return false;
  const { presence, settings } = computePresence(node, nowMs, defaults);
  if (presence === 'asleep' && node.last_seen) {
    const silentSince = Date.parse(node.last_seen);
    return nowMs > silentSince + settings.suspend_grace_sec * 1000;
  }
  return true;
}

// Worker side: detect that the machine slept by comparing wall-clock progress with the timer interval.
// Returns the slept milliseconds (0 when no sleep was detected).
function detectSleepGap(prevWallMs, nowWallMs, intervalMs, toleranceMs = 30000) {
  const gap = nowWallMs - prevWallMs - intervalMs;
  return gap > toleranceMs ? gap : 0;
}

// Task timeout counts awake time only, on every OS: elapsed wall time minus detected sleep gaps.
function awakeElapsedMs(startWallMs, nowWallMs, sleepGapsMs) {
  const slept = (sleepGapsMs || []).reduce((a, b) => a + b, 0);
  return Math.max(0, nowWallMs - startWallMs - slept);
}

const WARNING_BY_PRESENCE = { asleep: 'W_TARGET_ASLEEP', offline: 'W_TARGET_OFFLINE', never: 'W_TARGET_NEVER_SEEN' };

// Decide what POST /tasks does.
//   target: { kind: 'node', node } | { kind: 'role', role, candidates: [node...] }  (candidates already filtered
//           by role, profile and requires; for kind 'node' pass "alternatives" = other eligible nodes)
//   onUnavailable: 'confirm' | 'queue' | 'reject'
// Returns { action: 'create' | 'refuse', warnings: [{code, params}], alternatives: [node_id...] }
function decideDispatch({ target, alternatives = [], onUnavailable = 'queue' }, nowMs, defaults = DEFAULT_PRESENCE) {
  const warnings = [];
  const onlineAlternatives = alternatives
    .filter((n) => canClaim(n, nowMs, defaults))
    .map((n) => n.node_id);

  let available;
  if (target.kind === 'node') {
    const n = target.node;
    const p = computePresence(n, nowMs, defaults);
    if (n.state === 'draining') warnings.push({ code: 'W_TARGET_DRAINING', params: { node_id: n.node_id } });
    if (p.presence !== 'online') warnings.push({ code: WARNING_BY_PRESENCE[p.presence], params: { node_id: n.node_id, silent_sec: p.silent_sec } });
    available = n.state === 'active' && p.presence === 'online';
  } else {
    const online = target.candidates.filter((n) => canClaim(n, nowMs, defaults));
    if (online.length === 0) warnings.push({ code: 'W_NO_ONLINE_CANDIDATE', params: { role: target.role, total: target.candidates.length } });
    available = online.length > 0;
  }

  if (available) return { action: 'create', warnings, alternatives: [] };
  if (onUnavailable === 'queue') return { action: 'create', warnings, alternatives: onlineAlternatives };
  return { action: 'refuse', warnings, alternatives: onlineAlternatives };
}

module.exports = {
  DEFAULT_PRESENCE, effectiveSettings, computePresence, canClaim, leaseExpired,
  detectSleepGap, awakeElapsedMs, decideDispatch,
};
