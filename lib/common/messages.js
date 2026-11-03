'use strict';
// User-facing texts for error and warning codes, zh-TW and en. Selected by Accept-Language.
const M = {
  E_VALIDATION: { 'zh-TW': '請求格式不符合規格', en: 'Request does not match the schema' },
  E_AUTH: { 'zh-TW': 'token 無效、已過期或已撤銷', en: 'Token is invalid, expired or revoked' },
  E_FORBIDDEN: { 'zh-TW': '此 token 沒有權限執行這個動作', en: 'This token is not allowed to do this' },
  E_NOT_FOUND: { 'zh-TW': '找不到指定的資料', en: 'Not found' },
  E_CONFLICT: { 'zh-TW': '目前狀態不允許這個操作', en: 'The current state does not allow this operation' },
  E_LEASE_LOST: { 'zh-TW': '租約不符或已過期', en: 'Lease does not match or has expired' },
  E_PAYLOAD_TOO_LARGE: { 'zh-TW': '內容超過大小上限', en: 'Payload too large' },
  E_PROFILE_UNKNOWN: { 'zh-TW': '目標節點沒有這個 profile', en: 'The target node does not offer this profile' },
  E_REQUIREMENT_UNMET: { 'zh-TW': '目標節點不符合 requires 條件', en: 'The target node does not meet the requirements' },
  E_TARGET_UNAVAILABLE: { 'zh-TW': '目標機器目前不在線，任務尚未建立', en: 'The target machine is not online; the task was not created' },
  E_ENROLL_INVALID: { 'zh-TW': '加入碼無效、已過期、已使用或已撤銷', en: 'Enrollment code is invalid, expired, used or revoked' },
  E_NODE_EXISTS: { 'zh-TW': 'node_id 已被使用', en: 'node_id is already taken' },
  E_NODE_NOT_ACTIVE: { 'zh-TW': '節點尚未核准或已停用', en: 'The node is not approved or is disabled' },
  E_META_CONFLICT: { 'zh-TW': 'metadata 已被其他人修改，請重新讀取後再改', en: 'Metadata was changed by someone else; reload and retry' },
  E_HOP_LIMIT: { 'zh-TW': '轉派層數超過上限', en: 'Hop limit exceeded' },
  E_THREAD_LIMIT: { 'zh-TW': '此 thread 的任務或訊息數超過上限', en: 'Thread limit exceeded' },
  E_BUDGET: { 'zh-TW': '此 thread 的累計花費超過上限', en: 'Thread budget exceeded' },
  E_SELF_TARGET: { 'zh-TW': '不能寄給自己', en: 'Cannot send to yourself' },
  E_RATE_LIMIT: { 'zh-TW': '請求太頻繁，請稍後再試', en: 'Too many requests' },
  E_UNAVAILABLE: { 'zh-TW': 'Hub 暫時無法處理，請稍後重試', en: 'Hub is temporarily unavailable' },
  E_INTERNAL: { 'zh-TW': 'Hub 內部錯誤，請查看 hub Log 中同一個 trace_id', en: 'Internal error; see the hub log for this trace_id' },
};

const POWER = { server: { 'zh-TW': '伺服器', en: 'server' }, desktop: { 'zh-TW': '桌機', en: 'desktop' }, laptop: { 'zh-TW': '筆電', en: 'laptop' } };

function lang(acceptLanguage) {
  return /^\s*en\b/i.test(acceptLanguage || '') ? 'en' : 'zh-TW';
}

function errorText(code, l = 'zh-TW') { return (M[code] && M[code][l]) || code; }

function duration(sec, l = 'zh-TW') {
  if (sec == null) return l === 'en' ? 'never' : '從未';
  if (sec < 60) return l === 'en' ? `${sec} s` : `${sec} 秒`;
  if (sec < 3600) return l === 'en' ? `${Math.floor(sec / 60)} min` : `${Math.floor(sec / 60)} 分鐘`;
  if (sec < 86400) return l === 'en' ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.floor(sec / 3600)} 小時 ${Math.floor((sec % 3600) / 60)} 分`;
  return l === 'en' ? `${Math.floor(sec / 86400)} d` : `${Math.floor(sec / 86400)} 天`;
}

function nodeLabel(n, l) {
  const p = POWER[n.power] ? POWER[n.power][l] : '';
  return `${n.node_id}（${n.display_name}${p ? '，' + p : ''}）`;
}

function warningText(code, params, l = 'zh-TW') {
  const n = params.node || {};
  switch (code) {
    case 'W_TARGET_ASLEEP':
      return l === 'en' ? `${n.node_id} has not responded for ${duration(params.silent_sec, l)}; it may be asleep.`
        : `${nodeLabel(n, l)}已 ${duration(params.silent_sec, l)}沒有回應，可能睡著了。`;
    case 'W_TARGET_OFFLINE':
      return l === 'en' ? `${n.node_id} has been offline for ${duration(params.silent_sec, l)}.`
        : `${nodeLabel(n, l)}已離線 ${duration(params.silent_sec, l)}。`;
    case 'W_TARGET_NEVER_SEEN':
      return l === 'en' ? `${n.node_id} has never come online.` : `${nodeLabel(n, l)}從未上線過。`;
    case 'W_TARGET_DRAINING':
      return l === 'en' ? `${n.node_id} is draining and does not accept new tasks.` : `${nodeLabel(n, l)}正在暫停接新任務（draining）。`;
    case 'W_NO_ONLINE_CANDIDATE':
      return l === 'en' ? `No machine with role ${params.role} is online (${params.total} matching).`
        : `角色 ${params.role} 目前沒有任何在線的機器（符合條件的共 ${params.total} 台）。`;
    default: return code;
  }
}

module.exports = { lang, errorText, warningText, duration, nodeLabel, POWER };
