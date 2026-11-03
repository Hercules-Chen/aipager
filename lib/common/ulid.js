'use strict';
// ULID: 48-bit millisecond time + 80 random bits, Crockford base32 (no I, L, O, U).
const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms) {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) { out = ALPHABET[t % 32] + out; t = Math.floor(t / 32); }
  return out;
}

function encodeRandom() {
  const bytes = crypto.randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i++) { out = ALPHABET[Number(bits & 31n)] + out; bits >>= 5n; }
  return out;
}

function ulid(ms = Date.now()) { return encodeTime(ms) + encodeRandom(); }

function traceId() { return crypto.randomBytes(16).toString('hex'); }

module.exports = { ulid, traceId, ALPHABET };
