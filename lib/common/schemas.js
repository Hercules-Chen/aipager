'use strict';
// Runtime validation against the same JSON Schemas the spec is validated with (single source).
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { APP_ROOT } = require('./paths');

let cache = null;
function load() {
  if (cache) return cache;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'spec/schemas', f), 'utf8'));
  const envelope = read('envelope.schema.json');
  const api = read('api.schema.json');
  ajv.addSchema(envelope);
  ajv.addSchema(api);
  cache = { ajv, envelopeId: envelope.$id, apiId: api.$id };
  return cache;
}

function validator(kind, def) {
  const { ajv, envelopeId, apiId } = load();
  const id = kind === 'envelope' ? (def ? `${envelopeId}#/$defs/${def}` : envelopeId) : `${apiId}#/$defs/${def}`;
  const v = ajv.getSchema(id);
  if (!v) throw new Error('unknown schema ' + id);
  return v;
}

// Returns null when valid, otherwise an array of "path message" strings.
function check(kind, def, data) {
  const v = validator(kind, def);
  if (v(data)) return null;
  return v.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
}

function compile(schema) { return load().ajv.compile(schema); }

module.exports = { check, validator, compile };
