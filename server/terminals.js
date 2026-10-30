'use strict';
// Terminals embedded in the editor (node-pty). A Claude terminal is a real interactive session:
// the cockpit statusline renders inside it, and the hub can type into it to deliver messages.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { uid, uuid } = require('./util');
const { bus } = require('./store');
const { claudeArgv, childEnv } = require('./claude');

let pty = null;
try { pty = require('node-pty'); } catch (e) { pty = null; }

const MAX_BUFFER = 512 * 1024;
const terms = new Map();

function publicView(t) {
  return {
    id: t.id, kind: t.kind, name: t.name, cwd: t.cwd, configDir: t.configDir, sessionId: t.sessionId,
    roleId: t.roleId, pid: t.proc ? t.proc.pid : null, alive: t.alive, exitCode: t.exitCode, createdAt: t.createdAt,
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
 * kind 'claude': opts { name, configPath, cwd, rolePrompt, roleId, model, resumeId }
 * kind 'shell':  opts { name, cwd }
 */
function create(kind, opts) {
  if (!pty) throw new Error('node-pty no está disponible en este equipo; usa "Abrir en Windows Terminal".');
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : require('os').homedir();
  const id = uid('t');
  let file;
  let args;
  let sessionId = null;
  let env = Object.assign({}, process.env);
  if (kind === 'claude') {
    sessionId = opts.resumeId || uuid();
    args = opts.resumeId ? ['--resume', opts.resumeId] : ['--session-id', sessionId, '-n', opts.name];
    if (opts.rolePrompt) args.push('--append-system-prompt-file', systemPromptFile(opts.name, opts.rolePrompt));
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    [file, args] = claudeArgv(args);
    env = childEnv(opts.configPath, { BRIDGE_SESSION_ID: sessionId, BRIDGE_TERMINAL_ID: id });
  } else {
    file = 'powershell.exe';
    args = ['-NoLogo'];
    env = childEnv(null);
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 32, cwd, env, useConpty: true,
  });
  const t = {
    id, kind, name: opts.name || (kind === 'claude' ? 'claude' : 'PowerShell'), cwd,
    configDir: opts.configPath ? path.basename(opts.configPath) : null, sessionId, roleId: opts.roleId || null,
    proc, alive: true, exitCode: null, createdAt: Date.now(), buffer: '', clients: new Set(),
    lastInputAt: 0, draft: false,
  };
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
  const t = bySession(sessionId);
  if (!t) return false;
  if (t.draft || (t.lastInputAt && Date.now() - t.lastInputAt < 8000)) return false;
  t.proc.write(text.replace(/\r?\n/g, ' '));
  setTimeout(() => { if (t.alive) t.proc.write('\r'); }, 180);
  return true;
}

function killAll() { for (const t of terms.values()) { try { t.proc.kill(); } catch (e) {} } }

module.exports = { available: () => !!pty, list, create, attach, kill, bySession, typeInto, killAll };
