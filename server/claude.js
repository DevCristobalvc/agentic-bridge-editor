'use strict';
// Locating the claude binary and building the environment for a child bound to one account.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { HOME } = require('./config');

let cachedBin = null;
function claudeBin() {
  if (cachedBin) return cachedBin;
  const candidates = [path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')];
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch (e) {}
  cachedBin = candidates.find((c) => /\.(exe|cmd)$/i.test(c) || process.platform !== 'win32' ? fs.existsSync(c) : false)
    || 'claude';
  return cachedBin;
}

// What to spawn for `claude …`. The native installer gives an .exe. An npm install gives a .cmd
// shim, which Node cannot spawn without a shell, and a shell would parse names and prompts.
// So read the shim and run the program it wraps directly.
let cachedCommand = null;
function claudeCommand() {
  if (cachedCommand) return cachedCommand;
  const bin = claudeBin();
  if (!/\.cmd$/i.test(bin)) return (cachedCommand = { file: bin, prefix: [] });
  let target = null;
  try {
    const m = /"%dp0%\\([^"]+\.(?:c?js|mjs|exe))"/i.exec(fs.readFileSync(bin, 'utf8'));
    if (m) target = path.join(path.dirname(bin), m[1]);
  } catch (e) {}
  if (!target || !fs.existsSync(target)) throw new Error('No pude ejecutar ' + bin + ' sin una shell. Instala Claude Code con el instalador nativo (claude.exe).');
  cachedCommand = /\.exe$/i.test(target) ? { file: target, prefix: [] } : { file: process.execPath, prefix: [target] };
  return cachedCommand;
}

// spawn-style [file, args] for a claude invocation.
function claudeArgv(args) {
  const c = claudeCommand();
  return [c.file, c.prefix.concat(args)];
}

// The default ~/.claude must run with CLAUDE_CONFIG_DIR unset: its login lives in ~/.claude.json.
function isDefaultConfig(configPath) {
  return !configPath || path.resolve(configPath) === path.join(HOME, '.claude');
}

// A hub launched from inside a Claude session inherits that session's markers
// (CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ID, messaging socket…). Passed on, they make
// every child think it is a sub-session: no transcript, no registry entry. Strip them all.
function childEnv(configPath, extra) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_CONFIG_DIR' || /^BRIDGE_/.test(k)) delete env[k];
  }
  Object.assign(env, extra || {});
  if (!isDefaultConfig(configPath)) env.CLAUDE_CONFIG_DIR = configPath;
  return env;
}

// The arguments of an interactive session opened outside the editor. New sessions get their id
// up front, so Bridge can show their mirror before they register.
function externalArgs({ name, sessionId, resumeId, systemPromptFile, model, permissionMode, prompt }) {
  const args = resumeId ? ['--resume', resumeId] : ['--session-id', sessionId, '-n', name];
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  if (model) args.push('--model', model);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (prompt && !resumeId) args.push('--', String(prompt));
  return args;
}

// C:\Users\me\x -> /c/Users/me/x, the form Git Bash expects.
function msysPath(p) {
  const abs = path.resolve(p);
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(abs);
  return m ? '/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/') : abs.replace(/\\/g, '/');
}

// Open a session in its own Git Bash window (mintty), the way you would by hand: Claude runs in
// a login shell, and when it exits the window stays open as a normal Git Bash.
function launchGitBash(opts) {
  if (process.platform !== 'win32') throw new Error('Git Bash solo existe en Windows.');
  const bash = require('./shells').gitBash();
  if (!bash) throw new Error('No encontré Git Bash (Git for Windows).');
  const gitRoot = path.dirname(path.dirname(bash));
  const mintty = path.join(gitRoot, 'usr', 'bin', 'mintty.exe');
  if (!fs.existsSync(mintty)) throw new Error('No encontré mintty.exe en ' + gitRoot);
  const c = claudeCommand();
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  // Every value goes in single quotes: names, prompts and folders never reach the shell as code.
  const script = [
    '# Agentic Bridge: ' + String(opts.name || 'claude').replace(/[\r\n]/g, ' '),
    'cd ' + q(msysPath(opts.cwd)) + ' || exit 1',
    isDefaultConfig(opts.configPath) ? 'unset CLAUDE_CONFIG_DIR' : 'export CLAUDE_CONFIG_DIR=' + q(path.resolve(opts.configPath).replace(/\\/g, '/')),
    [q(msysPath(c.file))].concat(c.prefix.map(q), externalArgs(opts).map(q)).join(' '),
    'exec bash --login -i',
    '',
  ].join('\n');
  const { DATA_DIR } = require('./config');
  const file = path.join(DATA_DIR, 'agents', 'gitbash-' + Date.now().toString(36) + '.sh');
  fs.writeFileSync(file, script);
  const env = Object.assign(childEnv(opts.configPath), { CHERE_INVOKING: '1', MSYSTEM: process.env.MSYSTEM || 'MINGW64' });
  const icon = path.join(gitRoot, 'git-bash.exe');
  const args = ['-t', String(opts.name || 'claude').slice(0, 60)];
  if (fs.existsSync(icon)) args.push('-i', icon);
  args.push('/usr/bin/bash', '--login', msysPath(file));
  spawn(mintty, args, { cwd: opts.cwd, env, detached: true, stdio: 'ignore' }).unref();
  // The script is read when bash starts; remove it a bit later.
  setTimeout(() => fs.rm(file, { force: true }, () => {}), 60000).unref();
}

// Open a session in a new Windows Terminal tab (or a plain console when wt is missing).
function launchExternal(opts) {
  const { name, configPath, cwd } = opts;
  const args = externalArgs(opts);
  const env = childEnv(configPath);
  const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  const [file, argv] = claudeArgv(args);
  if (process.platform !== 'win32') throw new Error('Abrir terminal externa solo está implementado en Windows.');
  if (!fs.existsSync(wt)) throw new Error('No encontré Windows Terminal; usa la terminal integrada.');
  // wt receives the program and its arguments as separate argv entries: no shell in between.
  // wt itself still splits its command line on ";" (even inside quotes) into more commands,
  // so every semicolon is escaped as "\;" (a literal semicolon for wt).
  const wtArg = (a) => String(a).replace(/;/g, '\\;');
  spawn(wt, ['-w', '0', 'new-tab', '--title', name || 'claude', '-d', cwd, file, ...argv].map(wtArg), { cwd, env, detached: true, stdio: 'ignore' }).unref();
}

module.exports = { claudeBin, claudeArgv, childEnv, isDefaultConfig, launchExternal, launchGitBash };
