'use strict';
// Connects every Claude account (and Antigravity) to the Bridge: registers the MCP server,
// merges the inbox and guard hooks into settings.json, and installs the modo-todo skill.
// Idempotent: entries are recognised by the "agentic-bridge" marker in their command.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT, AGY_MCP_FILE } = require('./config');
const { readJson, writeJson } = require('./util');
const { claudeArgv, childEnv } = require('./claude');
const sessions = require('./sessions');
const store = require('./store');

const MCP_NAME = 'agentic-bridge';
const fwd = (p) => p.replace(/\\/g, '/');
const MCP_SCRIPT = path.join(ROOT, 'integrations', 'mcp', 'bridge-mcp.js');
const INBOX_HOOK = 'node "' + fwd(path.join(ROOT, 'integrations', 'hooks', 'inbox.js')) + '"';
const GUARD_HOOK = 'node "' + fwd(path.join(ROOT, 'integrations', 'hooks', 'guard.js')) + '"';
const SKILL_SRC = path.join(ROOT, 'integrations', 'skills', 'modo-todo');
const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';

// Our hook entries are recognised by the script they run, wherever the repo was cloned.
const isOurs = (entry) => /integrations[\\/]+hooks[\\/]+(inbox|guard)\.js/.test(JSON.stringify(entry || {}));

function hookStatus(settings) {
  const h = (settings && settings.hooks) || {};
  const has = (ev) => (h[ev] || []).some(isOurs);
  return { inbox: has('UserPromptSubmit') && has('Stop'), guard: has('PreToolUse'), midTurn: has('PostToolUse') };
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
    return Object.assign({}, a, { integration: { mcp, inbox: hooks.inbox, guard: hooks.guard, midTurn: hooks.midTurn, skill, complete: mcp && hooks.inbox && hooks.guard && skill } });
  });
  const agy = readJson(AGY_MCP_FILE) || {};
  return {
    accounts: accts,
    antigravity: { present: fs.existsSync(path.dirname(AGY_MCP_FILE)), mcp: !!(agy.mcpServers && agy.mcpServers[MCP_NAME]) },
  };
}

// midTurn adds the opt-in PostToolUse delivery: messages reach a session between two of its
// tool calls instead of waiting for the end of the turn. It costs one short process per tool
// call, so it is installed only while the person has it switched on.
function mergeHooks(settings, midTurn) {
  const s = Object.assign({}, settings);
  const hooks = Object.assign({}, s.hooks || {});
  const put = (event, entry) => { hooks[event] = (hooks[event] || []).filter((e) => !isOurs(e)).concat([entry]); };
  put('UserPromptSubmit', { hooks: [{ type: 'command', command: INBOX_HOOK, timeout: 5 }] });
  put('Stop', { hooks: [{ type: 'command', command: INBOX_HOOK, timeout: 5 }] });
  put('PreToolUse', { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_HOOK, timeout: 5 }] });
  if (midTurn) put('PostToolUse', { matcher: '*', hooks: [{ type: 'command', command: INBOX_HOOK, timeout: 3 }] });
  else if (hooks.PostToolUse) {
    hooks.PostToolUse = hooks.PostToolUse.filter((e) => !isOurs(e));
    if (!hooks.PostToolUse.length) delete hooks.PostToolUse;
  }
  s.hooks = hooks;
  return s;
}

function backupSettings(a) {
  const settingsPath = path.join(a.configPath, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  const bdir = path.join(a.configPath, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(settingsPath, path.join(bdir, 'settings.json.bak.' + new Date().toISOString().replace(/[:.]/g, '-')));
}

// Turn mid-turn delivery on or off in every account that is already connected.
function setMidTurn(enabled) {
  const changed = [];
  for (const a of sessions.accounts()) {
    const settingsPath = path.join(a.configPath, 'settings.json');
    const current = readJson(settingsPath) || {};
    const h = hookStatus(current);
    if (!h.inbox || h.midTurn === !!enabled) continue;
    backupSettings(a);
    writeJson(settingsPath, mergeHooks(current, !!enabled));
    changed.push(a.configDir);
  }
  return { changed, status: status() };
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
    let file;
    let argv;
    try { [file, argv] = claudeArgv(args); } catch (e) { resolve({ ok: false, out: e.message }); return; }
    execFile(file, argv, { env, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

async function connectAccount(a) {
  const log = [];
  // settings.json hooks, with a timestamped backup next to the account's other backups.
  const settingsPath = path.join(a.configPath, 'settings.json');
  const current = readJson(settingsPath) || {};
  backupSettings(a);
  writeJson(settingsPath, mergeHooks(current, !!store.prefs.get().deliverMidTurn));
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
  // Fail before touching any settings.json if claude itself cannot be run.
  try { claudeArgv([]); } catch (e) {
    return { results: [{ configDir: 'claude', ok: false, log: [e.message] }], status: status() };
  }
  const results = [];
  for (const a of sessions.accounts()) results.push(await connectAccount(a));
  results.push(Object.assign({ configDir: 'antigravity' }, connectAntigravity()));
  return { results, status: status() };
}

module.exports = { status, connectAll, setMidTurn };
