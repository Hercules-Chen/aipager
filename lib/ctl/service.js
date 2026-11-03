'use strict';
// aipagerctl service install|uninstall|status — registers the worker with the OS service manager.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_ROOT, osName } = require('../common/paths');
const platform = require('../common/platform');

const SCRIPTS = path.join(APP_ROOT, 'spec', 'scripts');

function linuxUnit(configPath) {
  const tpl = fs.readFileSync(path.join(SCRIPTS, 'linux', 'aipager-worker.service'), 'utf8');
  return tpl
    .replace(/^Environment=AIPAGER_CONFIG=.*$/m, `Environment=AIPAGER_CONFIG=${configPath}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=/bin/bash ${path.join(SCRIPTS, 'posix', 'start-worker.sh')}`)
    .replace(/^Environment=PATH=(.*)$/m, (m, p) => `Environment=AIPAGER_APP_DIR=${APP_ROOT}\nEnvironment=PATH=${path.dirname(process.execPath)}:${p}`);
}

function macPlist(configPath, user) {
  const home = os.homedir();
  let tpl = fs.readFileSync(path.join(SCRIPTS, 'macos', 'com.aipager.worker.plist'), 'utf8');
  tpl = tpl.replace(/\/Users\/USERNAME/g, home).replace(/USERNAME/g, user)
    .replace('<string>/opt/aipager/spec/scripts/posix/start-worker.sh</string>', `<string>${path.join(SCRIPTS, 'posix', 'start-worker.sh')}</string>`);
  tpl = tpl.replace(/<key>AIPAGER_CONFIG<\/key>\s*<string>[^<]*<\/string>/, `<key>AIPAGER_CONFIG</key>\n    <string>${configPath}</string>\n    <key>AIPAGER_APP_DIR</key>\n    <string>${APP_ROOT}</string>`);
  tpl = tpl.replace(/<string>([^<]*\/\.volta\/bin:[^<]*)<\/string>/, (m, p) => `<string>${path.dirname(process.execPath)}:${p}</string>`);
  return tpl;
}

async function install(configPath, opts = {}, out = console.log) {
  const o = osName();
  if (o === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const unit = path.join(dir, 'aipager-worker.service');
    fs.writeFileSync(unit, linuxUnit(configPath));
    out(`已寫入 ${unit}`);
    const linger = await platform.run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { timeoutMs: 5000 });
    if (!/Linger=yes/.test(linger.stdout)) out(`請執行（讓登出與重開機後仍執行）：\n  sudo loginctl enable-linger ${os.userInfo().username}`);
    if (opts.dryRun) return { unit };
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'aipager-worker']]) {
      const r = await platform.run('systemctl', args, { timeoutMs: 30000 });
      out(`systemctl ${args.join(' ')} → ${r.ok ? 'ok' : 'failed: ' + (r.stderr || r.stdout).trim()}`);
    }
    out('查看：journalctl --user -u aipager-worker -f');
    return { unit };
  }
  if (o === 'macos') {
    const user = opts.user || os.userInfo().username;
    const daemon = opts.mode === 'daemon';
    const plist = macPlist(configPath, user).replace('<key>RunAtLoad</key>', daemon ? `<key>UserName</key>\n  <string>${user}</string>\n  <key>RunAtLoad</key>` : '<key>RunAtLoad</key>');
    const target = daemon ? '/Library/LaunchDaemons/com.aipager.worker.plist' : path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.aipager.worker.plist');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs', 'AIPager'), { recursive: true });
    fs.writeFileSync(target, plist);
    out(`已寫入 ${target}`);
    if (daemon) out('LaunchDaemon 在未登入時讀不到 Keychain：請確認 node.json 的 claude_auth.mode 為 "oauth_token"（claude setup-token）');
    if (opts.dryRun) return { target };
    const domain = daemon ? 'system' : `gui/${process.getuid()}`;
    await platform.run('launchctl', ['bootout', `${domain}/com.aipager.worker`], { timeoutMs: 10000 });
    const r = await platform.run('launchctl', ['bootstrap', domain, target], { timeoutMs: 10000 });
    out(`launchctl bootstrap ${domain} → ${r.ok ? 'ok' : 'failed: ' + (r.stderr || r.stdout).trim()}`);
    out('要隨時能接任務（插電時不睡眠）：sudo pmset -c sleep 0');
    return { target };
  }
  const ps1 = path.join(SCRIPTS, 'windows', 'register-worker-task.ps1');
  out(`執行 ${ps1}（需要系統管理員，會詢問 Windows 密碼）`);
  if (opts.dryRun) return { ps1 };
  const r = await platform.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-AppDir', APP_ROOT], { timeoutMs: 300000 });
  out(r.stdout + r.stderr);
  return { ps1, ok: r.ok };
}

async function uninstall(out = console.log) {
  const o = osName();
  if (o === 'linux') {
    await platform.run('systemctl', ['--user', 'disable', '--now', 'aipager-worker'], { timeoutMs: 30000 });
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'aipager-worker.service'), { force: true });
    await platform.run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 30000 });
  } else if (o === 'macos') {
    await platform.run('launchctl', ['bootout', `gui/${process.getuid()}/com.aipager.worker`], { timeoutMs: 10000 });
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.aipager.worker.plist'), { force: true });
  } else {
    await platform.run('schtasks', ['/Delete', '/TN', 'AIPager Worker', '/F'], { timeoutMs: 30000 });
  }
  out('已移除 Worker 服務設定');
}

async function status(out = console.log) {
  const o = osName();
  const r = o === 'linux' ? await platform.run('systemctl', ['--user', 'status', 'aipager-worker', '--no-pager'], { timeoutMs: 10000 })
    : o === 'macos' ? await platform.run('launchctl', ['print', `gui/${process.getuid()}/com.aipager.worker`], { timeoutMs: 10000 })
      : await platform.run('schtasks', ['/Query', '/TN', 'AIPager Worker', '/V', '/FO', 'LIST'], { timeoutMs: 10000 });
  out((r.stdout || r.stderr || '').trim() || '(no output)');
  return r.ok;
}

module.exports = { install, uninstall, status, linuxUnit, macPlist };
