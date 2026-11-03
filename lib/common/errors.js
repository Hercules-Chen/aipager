'use strict';
// AipError carries an API error code (E_*) and HTTP status; the Hub turns it into the standard error body.
const STATUS = {
  E_VALIDATION: 400, E_AUTH: 401, E_FORBIDDEN: 403, E_NODE_NOT_ACTIVE: 403, E_NOT_FOUND: 404,
  E_CONFLICT: 409, E_LEASE_LOST: 409, E_META_CONFLICT: 409, E_NODE_EXISTS: 409, E_TARGET_UNAVAILABLE: 409,
  E_PAYLOAD_TOO_LARGE: 413, E_PROFILE_UNKNOWN: 422, E_REQUIREMENT_UNMET: 422, E_ENROLL_INVALID: 422,
  E_HOP_LIMIT: 422, E_THREAD_LIMIT: 422, E_BUDGET: 422, E_SELF_TARGET: 422,
  E_RATE_LIMIT: 429, E_INTERNAL: 500, E_UNAVAILABLE: 503,
};

class AipError extends Error {
  constructor(code, message, detail, extra) {
    super(message || code);
    this.code = code;
    this.status = STATUS[code] || 500;
    this.detail = detail;
    this.extra = extra; // extra top-level fields for the response body (e.g. targetUnavailable)
  }
}

module.exports = { AipError, STATUS };
