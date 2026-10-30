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

// Open a session in a new Windows Terminal tab (or a plain console when wt is missing).
function launchExternal({ name, configPath, cwd, resumeId, systemPromptFile, model, permissionMode }) {
  const args = resumeId ? ['--resume', resumeId] : ['-n', name];
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  if (model) args.push('--model', model);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  const env = childEnv(configPath);
  const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  const opts = { cwd, env, detached: true, stdio: 'ignore' };
  if (process.platform === 'win32' && fs.existsSync(wt)) {
    spawn(wt, ['-w', '0', 'new-tab', '--title', name || 'claude', '-d', cwd, claudeBin(), ...args], opts).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', claudeBin(), ...args], opts).unref();
  } else {
    throw new Error('Abrir terminal externa solo está implementado en Windows.');
  }
}

module.exports = { claudeBin, childEnv, isDefaultConfig, launchExternal };
