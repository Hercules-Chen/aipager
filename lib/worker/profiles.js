'use strict';
// profiles.json: load, validate, hot reload (spec chapter 06 "profiles.json 熱重載").
const fs = require('node:fs');
const { readJson } = require('../common/config');

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function validateProfiles(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || !data.profiles || typeof data.profiles !== 'object') return ['top-level "profiles" object is required'];
  for (const [name, p] of Object.entries(data.profiles)) {
    if (!NAME.test(name)) errors.push(`${name}: name must match ${NAME}`);
    if (!p || typeof p !== 'object') { errors.push(`${name}: must be an object`); continue; }
    if (typeof p.workdir !== 'string' || !p.workdir) errors.push(`${name}: workdir is required`);
    for (const k of ['allowed_tools', 'disallowed_tools', 'pre_commands']) if (p[k] !== undefined && !Array.isArray(p[k])) errors.push(`${name}: ${k} must be an array`);
    for (const k of ['max_turns', 'timeout_sec', 'artifacts_max_mb']) if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] > 0)) errors.push(`${name}: ${k} must be a positive integer`);
    if (p.repo && (!Array.isArray(p.repo.allow_remote) || !p.repo.allow_remote.length)) errors.push(`${name}: repo.allow_remote must be a non-empty array`);
    if (p.permission_mode && !['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(p.permission_mode)) errors.push(`${name}: unknown permission_mode ${p.permission_mode}`);
    if (p.permission_mode === 'bypassPermissions') errors.push(`${name}: bypassPermissions is not allowed for relay tasks`);
  }
  return errors;
}

class Profiles {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.current = {};
    this.error = null;
    this.mtime = 0;
  }

  load() {
    try {
      const st = fs.statSync(this.file);
      this.mtime = st.mtimeMs;
      const data = readJson(this.file);
      const errs = validateProfiles(data);
      if (errs.length) throw new Error(errs.join('; '));
      this.current = data.profiles;
      this.error = null;
      this.log.info('profiles.reload', `loaded ${Object.keys(this.current).length} profiles`, { file: this.file, names: Object.keys(this.current) });
    } catch (e) {
      this.error = String(e.message).slice(0, 1000);
      this.log.error('profiles.reload', 'profiles.json rejected, keeping the previous valid set', { file: this.file, error: this.error });
    }
    return this;
  }

  watch(intervalMs = 2000) {
    fs.watchFile(this.file, { interval: intervalMs }, (cur) => { if (cur.mtimeMs !== this.mtime) this.load(); });
    return () => fs.unwatchFile(this.file);
  }

  get(name) { return this.current[name]; }
  summary() { return Object.entries(this.current).map(([name, p]) => (p.description ? { name, description: String(p.description).slice(0, 300) } : { name })); }
  names() { return Object.keys(this.current); }
}

module.exports = { Profiles, validateProfiles };
