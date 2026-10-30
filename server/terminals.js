'use strict';
// Terminals embedded in the editor (node-pty). A Claude terminal is a real interactive session:
// the cockpit statusline renders inside it, and the hub can type into it to deliver messages.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { uid, uuid } = require('./util');
const { bus } = require('./store');
const { claudeArgv, childEnv } = require('./claude');
const shells = require('./shells');
const antigravity = require('./antigravity');

let pty = null;
try { pty = require('node-pty'); } catch (e) { pty = null; }

const MAX_BUFFER = 512 * 1024;
const terms = new Map();

function publicView(t) {
  return {
    id: t.id, kind: t.kind, shell: t.shell, name: t.name, cwd: t.cwd, configDir: t.configDir, sessionId: t.sessionId,
    conversationId: t.conversationId || null, roleId: t.roleId, pid: t.proc ? t.proc.pid : null, alive: t.alive,
    exitCode: t.exitCode, createdAt: t.createdAt, env: t.envNames || [],
  };
}

function list() { return [...terms.values()].map(publicView); }

function broadcastList() { bus.emit('event', { type: 'terminals', data: list() }); }

function systemPromptFile(name, text) {
  const file = path.join(DATA_DIR, 'agents', 'term-' + name.replace(/[^\w.-]/g, '_') + '.md');
  fs.writeFileSync(file, text);
  return file;
}

/**
 * kind 'claude': opts { name, configPath, cwd, rolePrompt, roleId, model, permissionMode, resumeId, prompt }
 * kind 'agy':    opts { name, cwd, model, mode, skipPermissions, conversationId }
 * kind 'shell':  opts { name, cwd, shell, command, configPath }
 * Any kind:      opts.env — extra variables (credentials) for the process; only their names are kept.
 */
function create(kind, opts) {
  if (!pty) throw new Error('node-pty no está disponible en este equipo; usa "Abrir en Windows Terminal".');
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : require('os').homedir();
  const id = uid('t');
  const extraEnv = opts.env || {};
  let file;
  let args;
  let sessionId = null;
  let conversationId = null;
  let shellId = null;
  let label = opts.name;
  let env;
  if (kind === 'claude') {
    sessionId = opts.resumeId || uuid();
    args = opts.resumeId ? ['--resume', opts.resumeId] : ['--session-id', sessionId, '-n', opts.name];
    if (opts.rolePrompt) args.push('--append-system-prompt-file', systemPromptFile(opts.name, opts.rolePrompt));
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    // An opening prompt starts the interactive session already working on it.
    if (opts.prompt && !opts.resumeId) args.push('--', String(opts.prompt));
    [file, args] = claudeArgv(args);
    env = childEnv(opts.configPath, Object.assign({}, extraEnv, { BRIDGE_SESSION_ID: sessionId, BRIDGE_TERMINAL_ID: id }));
    label = label || 'claude';
  } else if (kind === 'agy') {
    file = antigravity.agyBin();
    if (!file) throw new Error('No encontré el CLI de Antigravity (agy). Instálalo y vuelve a intentar.');
    args = [];
    if (opts.conversationId) { args.push('--conversation', opts.conversationId); conversationId = opts.conversationId; }
    if (opts.model) args.push('--model', opts.model);
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
    if (opts.prompt && !opts.conversationId) args.push('-i', String(opts.prompt));
    // Antigravity has no session id up front; Bridge knows this terminal by a synthetic one
    // (its MCP server reads it), and links the real conversation when its presence lock appears.
    sessionId = 'agy-' + id;
    env = childEnv(null, Object.assign({}, extraEnv, { BRIDGE_SESSION_ID: sessionId, BRIDGE_TERMINAL_ID: id }));
    label = label || 'antigravity';
  } else {
    const sh = shells.find(opts.shell);
    shellId = sh.id;
    file = sh.file;
    args = sh.args.slice();
    env = childEnv(opts.configPath || null, Object.assign({}, sh.env || {}, extraEnv));
    if (!opts.configPath && process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    label = label || sh.label;
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 32, cwd, env, useConpty: true,
  });
  const t = {
    id, kind, shell: shellId, name: label, cwd,
    configDir: opts.configPath ? path.basename(opts.configPath) : null, sessionId, conversationId, roleId: opts.roleId || null,
    proc, alive: true, exitCode: null, createdAt: Date.now(), buffer: '', clients: new Set(),
    lastInputAt: 0, draft: false, envNames: Object.keys(extraEnv),
  };
  // A command to run once the shell is ready (sign-in flows such as `gh auth login`).
  if (opts.command) setTimeout(() => { if (t.alive) proc.write(String(opts.command) + '\r'); }, kind === 'shell' && shellId === 'gitbash' ? 900 : 600);
  proc.onData((data) => {
    t.buffer += data;
    if (t.buffer.length > MAX_BUFFER) t.buffer = t.buffer.slice(-MAX_BUFFER);
    for (const ws of t.clients) { try { ws.send(JSON.stringify({ type: 'data', data })); } catch (e) {} }
  });
  proc.onExit(({ exitCode }) => {
    t.alive = false;
    t.exitCode = exitCode;
    for (const ws of t.clients) { try { ws.send(JSON.stringify({ type: 'exit', exitCode })); } catch (e) {} }
    broadcastList();
  });
  terms.set(id, t);
  broadcastList();
  return publicView(t);
}

function attach(id, ws) {
  const t = terms.get(id);
  if (!t) { ws.close(4404, 'no existe'); return; }
  t.clients.add(ws);
  ws.send(JSON.stringify({ type: 'replay', data: t.buffer, alive: t.alive, exitCode: t.exitCode }));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!t.alive) return;
    if (m.type === 'input' && typeof m.data === 'string') {
      t.proc.write(m.data);
      // Remember whether the person left something half-typed at the prompt: Enter, Ctrl+C
      // and Esc leave it clean, anything else leaves a draft.
      t.lastInputAt = Date.now();
      t.draft = !/[\r\x03\x1b]$/.test(m.data);
    }
    else if (m.type === 'resize' && m.cols > 0 && m.rows > 0) {
      try { t.proc.resize(Math.min(500, m.cols | 0), Math.min(200, m.rows | 0)); } catch (e) {}
    }
  });
  ws.on('close', () => t.clients.delete(ws));
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return false;
  if (t.alive) { try { t.proc.kill(); } catch (e) {} }
  terms.delete(id);
  broadcastList();
  return true;
}

function bySession(sessionId) {
  for (const t of terms.values()) if (t.sessionId === sessionId && t.alive) return t;
  return null;
}

// Type a prompt into an idle Claude terminal and submit it — unless the person is mid-sentence
// there; then the inbox hook delivers on their next prompt instead.
function typeInto(sessionId, text) {
  const t = bySession(sessionId) || byConversation(sessionId);
  if (!t) return false;
  if (t.draft || (t.lastInputAt && Date.now() - t.lastInputAt < 8000)) return false;
  t.proc.write(text.replace(/\r?\n/g, ' '));
  setTimeout(() => { if (t.alive) t.proc.write('\r'); }, 180);
  return true;
}

function killAll() { for (const t of terms.values()) { try { t.proc.kill(); } catch (e) {} } }

function rename(id, name) {
  const t = terms.get(id);
  if (!t) return null;
  t.name = String(name || t.name).slice(0, 60);
  broadcastList();
  return publicView(t);
}

// Link Antigravity terminals to the conversation their agy opened: the first live presence
// lock created after the terminal started, not already claimed by another terminal.
function claimAgyConversations(liveIds, birthOf) {
  const claimed = new Set([...terms.values()].map((t) => t.conversationId).filter(Boolean));
  let changed = false;
  for (const t of terms.values()) {
    if (t.kind !== 'agy' || t.conversationId || !t.alive) continue;
    const hit = liveIds.filter((id) => !claimed.has(id) && birthOf(id) >= t.createdAt - 3000).sort((a, b) => birthOf(a) - birthOf(b))[0];
    if (hit) { t.conversationId = hit; claimed.add(hit); changed = true; }
  }
  if (changed) broadcastList();
}

function byConversation(conversationId) {
  for (const t of terms.values()) if (t.conversationId === conversationId && t.alive) return t;
  return null;
}

function get(id) { const t = terms.get(id); return t ? publicView(t) : null; }

module.exports = { available: () => !!pty, list, get, create, attach, kill, rename, bySession, byConversation, typeInto, killAll, claimAgyConversations };
