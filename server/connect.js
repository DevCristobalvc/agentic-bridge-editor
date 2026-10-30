'use strict';
// Connects every Claude account (and Antigravity) to the Bridge: registers the MCP server,
// merges the inbox and guard hooks into settings.json, and installs the modo-todo skill.
// Idempotent: entries are recognised by the "agentic-bridge" marker in their command.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT, AGY_MCP_FILE } = require('./config');
const { readJson, writeJson } = require('./util');
const { claudeBin, childEnv } = require('./claude');
const sessions = require('./sessions');

const MCP_NAME = 'agentic-bridge';
const fwd = (p) => p.replace(/\\/g, '/');
const MCP_SCRIPT = path.join(ROOT, 'integrations', 'mcp', 'bridge-mcp.js');
const INBOX_HOOK = 'node "' + fwd(path.join(ROOT, 'integrations', 'hooks', 'inbox.js')) + '"';
const GUARD_HOOK = 'node "' + fwd(path.join(ROOT, 'integrations', 'hooks', 'guard.js')) + '"';
const SKILL_SRC = path.join(ROOT, 'integrations', 'skills', 'modo-todo');
const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';

const isOurs = (entry) => JSON.stringify(entry || {}).includes('agentic-bridge');

function hookStatus(settings) {
  const h = (settings && settings.hooks) || {};
  const has = (ev) => (h[ev] || []).some(isOurs);
  return { inbox: has('UserPromptSubmit') && has('Stop'), guard: has('PreToolUse') };
}

function mcpStatus(globalConfig) {
  const cfg = readJson(globalConfig) || {};
  return !!(cfg.mcpServers && cfg.mcpServers[MCP_NAME]);
}

function status() {
  const accts = sessions.accounts().map((a) => {
    const settings = readJson(path.join(a.configPath, 'settings.json')) || {};
    const hooks = hookStatus(settings);
    const skill = fs.existsSync(path.join(a.configPath, 'skills', 'modo-todo', 'SKILL.md'));
    const mcp = mcpStatus(a.globalConfig);
    return Object.assign({}, a, { integration: { mcp, inbox: hooks.inbox, guard: hooks.guard, skill, complete: mcp && hooks.inbox && hooks.guard && skill } });
  });
  const agy = readJson(AGY_MCP_FILE) || {};
  return {
    accounts: accts,
    antigravity: { present: fs.existsSync(path.dirname(AGY_MCP_FILE)), mcp: !!(agy.mcpServers && agy.mcpServers[MCP_NAME]) },
  };
}

function mergeHooks(settings) {
  const s = Object.assign({}, settings);
  const hooks = Object.assign({}, s.hooks || {});
  const put = (event, entry) => { hooks[event] = (hooks[event] || []).filter((e) => !isOurs(e)).concat([entry]); };
  put('UserPromptSubmit', { hooks: [{ type: 'command', command: INBOX_HOOK, timeout: 5 }] });
  put('Stop', { hooks: [{ type: 'command', command: INBOX_HOOK, timeout: 5 }] });
  put('PreToolUse', { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_HOOK, timeout: 5 }] });
  s.hooks = hooks;
  return s;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const a = path.join(src, name);
    const b = path.join(dst, name);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(claudeBin(), args, { env, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

async function connectAccount(a) {
  const log = [];
  // settings.json hooks, with a timestamped backup next to the account's other backups.
  const settingsPath = path.join(a.configPath, 'settings.json');
  const current = readJson(settingsPath) || {};
  if (fs.existsSync(settingsPath)) {
    const bdir = path.join(a.configPath, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(settingsPath, path.join(bdir, 'settings.json.bak.' + new Date().toISOString().replace(/[:.]/g, '-')));
  }
  writeJson(settingsPath, mergeHooks(current));
  log.push('hooks inbox y guard en settings.json');

  copyDir(SKILL_SRC, path.join(a.configPath, 'skills', 'modo-todo'));
  log.push('skill modo-todo');

  // MCP through the CLI, which owns the global config file and its concurrent writers.
  const env = childEnv(a.configPath);
  await run(['mcp', 'remove', '-s', 'user', MCP_NAME], env);
  const added = await run(['mcp', 'add', '-s', 'user', MCP_NAME, '--', 'node', fwd(MCP_SCRIPT)], env);
  log.push(added.ok ? 'MCP agentic-bridge' : 'MCP falló: ' + added.out.trim().slice(0, 200));
  return { configDir: a.configDir, ok: added.ok, log };
}

function connectAntigravity() {
  if (!fs.existsSync(path.dirname(AGY_MCP_FILE))) return { ok: false, log: ['Antigravity no está instalado'] };
  const cfg = readJson(AGY_MCP_FILE) || {};
  cfg.mcpServers = Object.assign({}, cfg.mcpServers || {}, { [MCP_NAME]: { command: 'node', args: [fwd(MCP_SCRIPT)] } });
  writeJson(AGY_MCP_FILE, cfg);
  return { ok: true, log: ['MCP agentic-bridge en mcp_config.json'] };
}

async function connectAll() {
  const results = [];
  for (const a of sessions.accounts()) results.push(await connectAccount(a));
  results.push(Object.assign({ configDir: 'antigravity' }, connectAntigravity()));
  return { results, status: status() };
}

module.exports = { status, connectAll };
