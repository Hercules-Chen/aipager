'use strict';
// Default locations per OS (spec chapter "跨平台差異"). AIPAGER_HOME puts everything under one root.
const os = require('node:os');
const path = require('node:path');

function osName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

function archName(arch = process.arch) { return arch === 'arm64' ? 'arm64' : 'x64'; }

// App root = repository / release root (bin, lib, spec, ui live here).
const APP_ROOT = path.resolve(__dirname, '..', '..');

function nodeDirs(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (env.AIPAGER_HOME) {
    const r = env.AIPAGER_HOME;
    return { config: path.join(r, 'node'), data: path.join(r, 'worker'), logs: path.join(r, 'logs') };
  }
  switch (osName(platform)) {
    case 'windows': {
      const pd = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
      const r = path.win32.join(pd, 'AIPager');
      return { config: path.win32.join(r, 'node'), data: path.win32.join(r, 'worker'), logs: path.win32.join(r, 'logs') };
    }
    case 'macos': {
      const r = path.posix.join(home, 'Library', 'Application Support', 'AIPager');
      return { config: path.posix.join(r, 'node'), data: path.posix.join(r, 'worker'), logs: path.posix.join(home, 'Library', 'Logs', 'AIPager') };
    }
    default: {
      const cfg = env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
      const state = env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state');
      return { config: path.posix.join(cfg, 'aipager'), data: path.posix.join(state, 'aipager', 'worker'), logs: path.posix.join(state, 'aipager', 'logs') };
    }
  }
}

function defaultNodeConfigPath(env = process.env, platform = process.platform) {
  return env.AIPAGER_CONFIG || path.join(nodeDirs(env, platform).config, 'node.json');
}

module.exports = { osName, archName, nodeDirs, defaultNodeConfigPath, APP_ROOT };
