'use strict';
// Agentic Bridge hub: HTTP API + WebSocket events + static web app, bound to 127.0.0.1 only.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const { PORT, TOKEN, WEB_DIR, ROOT, DATA_DIR, HOME, LAUNCH_CONFIG_DIR } = require('./config');
const store = require('./store');
const sessions = require('./sessions');
const rooms = require('./rooms');
const terminals = require('./terminals');
const files = require('./files');
const projects = require('./projects');
const connect = require('./connect');
const agents = require('./agents');
const claude = require('./claude');
const vault = require('./vault');
const { uid, clip } = require('./util');

const VERSION = require('../package.json').version;
const ORIGINS = new Set(['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT]);
const HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;
const VENDOR = {
  'htm-preact.js': 'htm/preact/standalone.module.js',
  'marked.js': 'marked/lib/marked.esm.js',
  'purify.js': 'dompurify/dist/purify.es.mjs',
  'hljs.js': '@highlightjs/cdn-assets/es/highlight.min.js',
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

// ---------- defaults ----------
if (!store.prefs.get().humanName) {
  const accts = sessions.accounts();
  const mine = accts.find((a) => LAUNCH_CONFIG_DIR && path.resolve(a.configPath) === path.resolve(LAUNCH_CONFIG_DIR)) || accts[0];
  store.prefs.set(Object.assign({ deliverOnStop: true }, store.prefs.get(), { humanName: (mine && mine.displayName) || 'Usuario' }));
}

// ---------- live session snapshot ----------
let snap = { accounts: [], sessions: [] };
let snapSig = '';

function signature(list) {
  return JSON.stringify(list.map((s) => Object.assign({}, s, { updatedAt: 0, crew: s.crew && Object.assign({}, s.crew, { updatedAt: 0, stale: 0 }) })));
}

function refresh(force) {
  const next = sessions.snapshot();
  for (const s of next.sessions) {
    const t = terminals.bySession(s.id);
    s.terminalId = t ? t.id : null;
    s.unread = rooms.inboxCount(s.id);
  }
  snap = next;
  const sig = signature(next.sessions);
  if (force || sig !== snapSig) {
    snapSig = sig;
    broadcast({ type: 'sessions', data: snap.sessions });
  }
}
rooms.setSessionLookup((id) => snap.sessions.find((s) => s.id === id) || null);

let boardSigs = new Map();
function refreshBoards() {
  for (const { id, sig } of projects.boardSignatures()) {
    if (boardSigs.get(id) === sig) continue;
    const first = !boardSigs.has(id);
    boardSigs.set(id, sig);
    if (!first) broadcast({ type: 'project', data: projects.detail(id) });
  }
}

// ---------- websocket fan-out ----------
const clients = new Set();
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of clients) { try { ws.send(raw); } catch (e) {} }
}
store.bus.on('event', (ev) => {
  if (ev.type === 'projects') broadcast({ type: 'projects', data: projects.list() });
  else broadcast(ev);
});

// ---------- http helpers ----------
function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra || {}));
  res.end(body);
}
const json = (res, code, data) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(data));
const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(fail(413, 'Demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const buf = await readBody(req, 4 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw fail(400, 'JSON inválido'); }
}

function findSession(id) { return snap.sessions.find((s) => s.id === id) || null; }

function accountPath(configDir) {
  if (!configDir) return null;
  const a = snap.accounts.find((x) => x.configDir === configDir || x.configPath === configDir);
  if (!a) throw fail(400, 'Cuenta desconocida: ' + configDir);
  return a.configPath;
}

function rolePrompt(roleId) {
  const r = roleId && store.roles.get().find((x) => x.id === roleId);
  return r ? r.prompt : null;
}

function memberSpecs(list) {
  return (list || []).map((m) => (m.kind === 'session'
    ? { kind: 'session', sessionId: m.sessionId, name: m.name || (findSession(m.sessionId) || {}).name }
    : { kind: 'agent', roleId: m.roleId, name: m.name, configPath: accountPath(m.configDir), cwd: m.cwd, model: m.model, permissionMode: m.permissionMode }));
}

// One tiny Haiku turn in an account just to read its subscription windows.
function probeUsage(configPath, configDir) {
  return new Promise((resolve) => {
    const proc = spawn(claude.claudeBin(), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { env: claude.childEnv(configPath), windowsHide: true });
    let buf = '';
    let found = false;
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 60000);
    proc.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const o = JSON.parse(line);
          if (o.type === 'rate_limit_event' && o.rate_limit_info) { sessions.recordUsage(configDir, o.rate_limit_info, 'probe'); found = true; }
        } catch (e) {}
      }
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end('Responde solo: ok');
    proc.on('close', () => { clearTimeout(timer); resolve(found); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// ---------- uploads ----------
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
function findUpload(id) {
  const safe = String(id).replace(/[^\w-]/g, '');
  const name = fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(safe + '__'));
  return name ? path.join(UPLOAD_DIR, name) : null;
}

// ---------- identity for MCP / hooks ----------
function identify(q) {
  if (q.agent) {
    for (const r of rooms.list()) {
      const m = r.members.find((x) => x.id === q.agent);
      if (m) return { kind: 'agent', id: m.id, name: m.name, roomId: r.id, sessionId: m.sessionUuid };
    }
  }
  let sid = q.sid && findSession(q.sid) ? q.sid : null;
  if (!sid && q.pids) sid = sessions.sessionForPids(String(q.pids).split(',').map(Number).filter(Boolean));
  if (!sid && q.sid) sid = q.sid; // a session the snapshot has not seen yet
  if (!sid) return null;
  const s = findSession(sid);
  // Not in the registry yet (or not a Claude session): use the name a room knows it by.
  let name = s ? s.name : null;
  if (!name) {
    for (const r of rooms.list()) {
      const m = r.members.find((x) => x.sessionId === sid);
      if (m) { name = m.name; break; }
    }
  }
  return { kind: 'session', id: sid, sessionId: sid, name: name || sid.slice(0, 8), account: s ? s.account : null, cwd: s ? s.cwd : null };
}

function authorFor(who) {
  if (who.kind === 'agent') {
    const r = rooms.raw(who.roomId);
    const m = r && r.meta.members.find((x) => x.id === who.id);
    return { kind: 'agent', id: who.id, name: who.name, emoji: m && m.emoji, color: m && m.color, roleId: m && m.roleId };
  }
  return { kind: 'session', id: who.sessionId, name: who.name };
}

function resolveSessionRef(ref) {
  const r = String(ref || '').replace(/^@/, '').toLowerCase();
  const alive = snap.sessions.filter((s) => s.alive);
  return alive.find((s) => s.id === ref) || alive.find((s) => [s.name, s.alias, s.registryName].some((n) => n && n.toLowerCase() === r))
    || alive.find((s) => [s.name, s.alias, s.registryName].some((n) => n && n.toLowerCase().replace(/\s+/g, '-') === r)) || null;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/state', () => ({
  me: { home: HOME, port: PORT, version: VERSION, platform: process.platform, pty: terminals.available(), dataDir: DATA_DIR, root: ROOT },
  prefs: store.prefs.get(),
  integration: connect.status(),
  accounts: snap.accounts,
  sessions: snap.sessions,
  rooms: rooms.list(),
  projects: projects.list(),
  roles: store.roles.get(),
  terminals: terminals.list(),
  usage: store.usage.get(),
  vault: vault.list(),
}));

// vault
route('GET', '/api/vault', (req, p, url) => vault.search(url.searchParams.get('q'), 500));
route('POST', '/api/vault', async (req) => vault.save(await jsonBody(req), { kind: 'human', name: store.prefs.get().humanName || 'Tú' }));
route('PUT', '/api/vault/:id', async (req, p) => vault.save(Object.assign(await jsonBody(req), { id: p.id })));
route('DELETE', '/api/vault/:id', (req, p) => ({ ok: vault.remove(p.id) }));

route('PATCH', '/api/prefs', async (req) => store.prefs.set(Object.assign({}, store.prefs.get(), await jsonBody(req))));

// sessions
route('GET', '/api/sessions', () => snap);
route('GET', '/api/sessions/:id/transcript', (req, p, url) => sessions.transcript(p.id, Math.min(1000, Number(url.searchParams.get('limit')) || 300)));
route('PATCH', '/api/sessions/:id', async (req, p) => {
  const body = await jsonBody(req);
  const alias = String(body.alias || '').trim().slice(0, 60);
  store.aliases.update((a) => { const n = Object.assign({}, a); if (alias) n[p.id] = alias; else delete n[p.id]; return n; });
  const t = terminals.bySession(p.id);
  const s = findSession(p.id);
  // Sessions living in our terminals can be renamed natively too, when idle.
  if (alias && t && s && s.status === 'idle' && body.native) terminals.typeInto(p.id, '/rename ' + alias);
  refresh(true);
  return { ok: true };
});
route('POST', '/api/sessions', async (req) => {
  const b = await jsonBody(req);
  const configPath = accountPath(b.configDir);
  const name = String(b.name || 'sesion').trim().slice(0, 60);
  const cwd = b.cwd ? files.resolve(b.cwd) : HOME;
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  const prompt = rolePrompt(b.roleId);
  const permissionMode = ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(b.permissionMode) ? b.permissionMode : null;
  if (b.where === 'external') {
    let sysFile = null;
    if (prompt) { sysFile = path.join(DATA_DIR, 'agents', 'ext-' + uid() + '.md'); fs.writeFileSync(sysFile, prompt); }
    claude.launchExternal({ name, configPath, cwd, resumeId: b.resumeId, systemPromptFile: sysFile, model: b.model, permissionMode });
    return { ok: true, external: true };
  }
  const term = terminals.create('claude', { name, configPath, cwd, rolePrompt: prompt, roleId: b.roleId, model: b.model, permissionMode, resumeId: b.resumeId, cols: b.cols, rows: b.rows });
  if (!b.resumeId && name) store.aliases.update((a) => Object.assign({}, a, { [term.sessionId]: name }));
  return { ok: true, terminal: term };
});
route('POST', '/api/sessions/:id/message', async (req, p) => {
  const b = await jsonBody(req);
  const s = findSession(p.id);
  if (!s) throw fail(404, 'Sesión no encontrada');
  const room = rooms.directRoom(null, { id: s.id, name: s.name });
  rooms.postAsHuman(room.meta.id, String(b.text || ''), b.attachments || []);
  return { ok: true, roomId: room.meta.id };
});

// accounts & integration
route('GET', '/api/integration', () => connect.status());
route('POST', '/api/integration/connect', async () => {
  const r = await connect.connectAll();
  broadcast({ type: 'integration', data: r.status });
  return r;
});
route('POST', '/api/accounts/:dir/usage', async (req, p) => {
  const configPath = accountPath(decodeURIComponent(p.dir));
  const ok = await probeUsage(configPath, decodeURIComponent(p.dir));
  return { ok, usage: store.usage.get() };
});

// rooms
route('GET', '/api/rooms', () => rooms.list());
route('POST', '/api/rooms', async (req) => {
  const b = await jsonBody(req);
  return rooms.create({ name: b.name, topic: b.topic, mode: b.mode, maxAutoTurns: b.maxAutoTurns, budgetUsd: b.budgetUsd, members: memberSpecs(b.members) });
});
route('GET', '/api/rooms/:id', (req, p) => rooms.get(p.id) || Promise.reject(fail(404, 'Sala no encontrada')));
route('PATCH', '/api/rooms/:id', async (req, p) => rooms.update(p.id, await jsonBody(req)));
route('DELETE', '/api/rooms/:id', (req, p) => ({ ok: rooms.remove(p.id) }));
route('POST', '/api/rooms/:id/members', async (req, p) => rooms.addMember(p.id, memberSpecs([await jsonBody(req)])[0]));
route('PATCH', '/api/rooms/:id/members/:mid', async (req, p) => rooms.updateMember(p.id, p.mid, await jsonBody(req)));
route('DELETE', '/api/rooms/:id/members/:mid', (req, p) => rooms.removeMember(p.id, p.mid));
route('POST', '/api/rooms/:id/messages', async (req, p) => {
  const b = await jsonBody(req);
  if (!String(b.text || '').trim() && !(b.attachments || []).length) throw fail(400, 'Mensaje vacío');
  return rooms.postAsHuman(p.id, String(b.text || ''), b.attachments || []);
});
route('POST', '/api/rooms/:id/stop', (req, p) => ({ ok: rooms.stop(p.id) }));

// uploads (images pasted in chat, dropped files)
route('POST', '/api/uploads', async (req) => {
  const buf = await readBody(req, 30 * 1024 * 1024);
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'archivo')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80) || 'archivo';
  const id = uid('u');
  const file = path.join(UPLOAD_DIR, id + '__' + name);
  fs.writeFileSync(file, buf);
  return { id, name, type: String(req.headers['content-type'] || 'application/octet-stream'), size: buf.length, path: file, url: '/api/uploads/' + id };
});
route('GET', '/api/uploads/:id', (req, p, url, res) => {
  const file = findUpload(p.id);
  if (!file) throw fail(404, 'No existe');
  const { stream, mime } = files.rawStream(file);
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400' });
  stream.pipe(res);
  return undefined;
});

// files
route('GET', '/api/fs/roots', () => files.roots(
  projects.list().map((pr) => ({ label: pr.name, path: pr.path, icon: 'folder-kanban' }))
    .concat(snap.sessions.filter((s) => s.alive && s.cwd).map((s) => ({ label: s.name, path: s.cwd, icon: 'terminal' }))),
));
route('GET', '/api/fs/list', (req, p, url) => files.list(url.searchParams.get('path')));
route('GET', '/api/fs/read', (req, p, url) => files.read(url.searchParams.get('path')));
route('GET', '/api/fs/raw', (req, p, url, res) => {
  const { stream, mime, size } = files.rawStream(url.searchParams.get('path'));
  const headers = { 'Content-Type': mime, 'Content-Length': size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  // SVGs and other documents must not run scripts; the PDF viewer needs its own rules.
  if (mime !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
  res.writeHead(200, headers);
  stream.pipe(res);
  return undefined;
});
route('PUT', '/api/fs/write', async (req) => {
  const b = await jsonBody(req);
  if (typeof b.content !== 'string') throw fail(400, 'Falta el contenido');
  return files.write(b.path, b.content);
});
route('POST', '/api/fs/open', async (req) => { const b = await jsonBody(req); files.open(b.path, b.app); return { ok: true }; });

// projects
route('GET', '/api/projects', () => projects.list());
route('POST', '/api/projects', async (req) => {
  const b = await jsonBody(req);
  const team = (b.team || []).map((t) => Object.assign({}, t, { configPath: accountPath(t.configDir) }));
  const out = projects.create(Object.assign({}, b, { team }));
  broadcast({ type: 'projects', data: projects.list() });
  return out;
});
route('POST', '/api/projects/import', async (req) => {
  const b = await jsonBody(req);
  const out = projects.importFolder(files.resolve(b.path), b.name);
  broadcast({ type: 'projects', data: projects.list() });
  return out;
});
route('GET', '/api/projects/:id', (req, p) => projects.detail(p.id) || Promise.reject(fail(404, 'Proyecto no encontrado')));
route('PUT', '/api/projects/:id/contract', async (req, p) => projects.saveContract(p.id, await jsonBody(req)));
route('POST', '/api/projects/:id/plan', async (req, p) => { const b = await jsonBody(req); return projects.plan(p.id, b.objective); });
route('DELETE', '/api/projects/:id', (req, p) => { projects.remove(p.id); broadcast({ type: 'projects', data: projects.list() }); return { ok: true }; });

// roles
route('GET', '/api/roles', () => store.roles.get());
route('POST', '/api/roles', async (req) => {
  const b = await jsonBody(req);
  const role = Object.assign({ emoji: '🤖', color: '#a78bfa', description: '', prompt: '', model: '', permissionMode: 'acceptEdits', allowedTools: [] }, b, { id: uid('role') });
  store.roles.update((list) => list.concat([role]));
  return role;
});
route('PUT', '/api/roles/:id', async (req, p) => {
  const b = await jsonBody(req);
  let out = null;
  store.roles.update((list) => list.map((r) => (r.id === p.id ? (out = Object.assign({}, r, b, { id: r.id })) : r)));
  if (!out) throw fail(404, 'Rol no encontrado');
  return out;
});
route('DELETE', '/api/roles/:id', (req, p) => { store.roles.update((list) => list.filter((r) => r.id !== p.id)); return { ok: true }; });

// terminals
route('GET', '/api/terminals', () => terminals.list());
route('POST', '/api/terminals', async (req) => {
  const b = await jsonBody(req);
  return terminals.create('shell', { name: b.name || 'PowerShell', cwd: b.cwd ? files.resolve(b.cwd) : HOME, cols: b.cols, rows: b.rows });
});
route('DELETE', '/api/terminals/:id', (req, p) => ({ ok: terminals.kill(p.id) }));

// bridge: used by the MCP server and the hooks of every connected session
route('GET', '/api/bridge/whoami', (req, p, url) => identify(Object.fromEntries(url.searchParams)) || { kind: 'unknown' });
route('GET', '/api/bridge/sessions', () => snap.sessions.filter((s) => s.alive).map((s) => ({
  name: s.name, id: s.id, account: s.account, source: s.source, status: s.status, cwd: s.cwd,
  task: s.crew && s.crew.task ? s.crew.task + ' ' + s.crew.done + '/' + s.crew.total : null,
})));
route('GET', '/api/bridge/rooms', (req, p, url) => {
  const sid = url.searchParams.get('sid');
  return rooms.list().map((r) => ({ id: r.id, name: r.name, topic: r.topic, members: r.members.map((m) => '@' + m.handle), joined: !!sid && r.members.some((m) => m.sessionId === sid), last: r.last }));
});
route('GET', '/api/bridge/rooms/:ref/messages', (req, p, url) => {
  const room = rooms.findRoom(decodeURIComponent(p.ref));
  if (!room) throw fail(404, 'Sala no encontrada: ' + decodeURIComponent(p.ref));
  const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20);
  return { room: room.meta.name, messages: room.messages.slice(-limit).map((m) => ({ from: m.author.name, kind: m.author.kind, at: new Date(m.at).toISOString(), text: m.text, attachments: (m.attachments || []).map((a) => a.path) })) };
});
route('GET', '/api/bridge/inbox/:sid', (req, p, url) => {
  const event = url.searchParams.get('event');
  if (event === 'stop' && store.prefs.get().deliverOnStop === false) return { messages: [] };
  return { messages: url.searchParams.get('consume') === '1' ? rooms.consumeInbox(p.sid) : rooms.peekInbox(p.sid) };
});
route('POST', '/api/bridge/send', async (req) => {
  const b = await jsonBody(req);
  const who = identify(b.from || {});
  if (!who) throw fail(400, 'No pude identificar tu sesión. Pasa tu nombre en "as".');
  if (b.as && who.kind === 'session') who.name = String(b.as).slice(0, 60);
  const text = String(b.text || '').trim();
  if (!text) throw fail(400, 'Mensaje vacío');
  const to = String(b.to || '').trim();
  const author = authorFor(who);
  let room = to.startsWith('@') ? null : rooms.findRoom(to);
  if (!room && who.kind === 'agent' && !to) room = rooms.raw(who.roomId);
  if (!room) {
    const ref = to.replace(/^@/, '').toLowerCase();
    const me = who.kind === 'session' ? { id: who.sessionId, name: who.name } : null;
    if (['humano', 'human', 'usuario', 'user', String(store.prefs.get().humanName || '').toLowerCase()].includes(ref)) {
      if (!me) throw fail(400, 'Usa tu sala para hablar con el humano.');
      room = rooms.directRoom(null, me);
    } else {
      const target = resolveSessionRef(to);
      if (!target) throw fail(404, 'No encontré la sala o sesión "' + to + '". Usa bridge_rooms o bridge_sessions para ver los nombres.');
      if (me && target.id === me.id) throw fail(400, 'Ese destino eres tú.');
      room = rooms.directRoom(me, { id: target.id, name: target.name });
    }
  }
  if (who.kind === 'session' && !room.meta.members.some((m) => m.sessionId === who.sessionId)) {
    rooms.addMember(room.meta.id, { kind: 'session', sessionId: who.sessionId, name: who.name });
  }
  const msg = rooms.post(room.meta.id, author, text, []);
  return { ok: true, room: room.meta.name, roomId: room.meta.id, messageId: msg.id };
});
route('POST', '/api/bridge/vault', async (req) => {
  const b = await jsonBody(req);
  const who = identify(b.from || {});
  const author = who ? { kind: who.kind, name: who.name } : { kind: 'session', name: String(b.as || 'sesión').slice(0, 60) };
  const note = vault.save({ title: b.title, text: b.text, tags: b.tags }, author);
  return { ok: true, id: note.id, title: note.title };
});
route('GET', '/api/bridge/vault', (req, p, url) => vault.search(url.searchParams.get('q'), Math.min(50, Number(url.searchParams.get('limit')) || 10))
  .map((n) => ({ id: n.id, title: n.title, tags: n.tags, author: n.author && n.author.name, updatedAt: new Date(n.updatedAt).toISOString(), text: clip(n.text, 4000), attachments: (n.attachments || []).map((a) => a.path) })));
route('POST', '/api/bridge/join', async (req) => {
  const b = await jsonBody(req);
  const who = identify(b.from || {});
  if (!who || who.kind !== 'session') throw fail(400, 'Solo una sesión puede unirse a una sala.');
  const room = rooms.findRoom(b.room);
  if (!room) throw fail(404, 'Sala no encontrada');
  rooms.addMember(room.meta.id, { kind: 'session', sessionId: who.sessionId, name: who.name });
  return { ok: true, room: room.meta.name };
});

// ---------- request handling ----------
function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8').replace('%%TOKEN%%', TOKEN);
    return send(res, 200, TYPES['.html'], html);
  }
  let file = null;
  if (pathname.startsWith('/vendor/')) {
    const rel = VENDOR[pathname.slice(8)];
    if (rel) file = path.join(ROOT, 'node_modules', rel);
  } else {
    const abs = path.resolve(WEB_DIR, '.' + decodeURIComponent(pathname));
    if (abs.startsWith(WEB_DIR + path.sep)) file = abs;
  }
  if (!file) return send(res, 404, 'text/plain', 'not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'text/plain', 'not found');
    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', buf);
  });
}

async function handle(req, res) {
  // Answer only requests addressed to this machine by name (blocks DNS rebinding),
  // and only from our own origin when a browser says where it came from.
  if (!HOST_RE.test(req.headers.host || '')) return send(res, 403, 'text/plain', 'forbidden');
  if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return send(res, 403, 'text/plain', 'forbidden origin');
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return serveStatic(req, res, pathname);
  }
  const token = req.headers['x-bridge-token'] || url.searchParams.get('t');
  if (token !== TOKEN) return json(res, 401, { error: 'Token inválido' });
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    try {
      const out = await r.handler(req, Object.assign({}, m.groups), url, res);
      if (out !== undefined) json(res, 200, out);
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
      if (status === 500) console.error('[api]', req.method, pathname, e);
      if (!res.headersSent) json(res, status, { error: e.code === 'ENOENT' ? 'No existe: ' + clip(e.path || '', 200) : e.message });
    }
    return undefined;
  }
  return json(res, 404, { error: 'Ruta desconocida' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: e.message }); });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const okOrigin = !req.headers.origin || ORIGINS.has(req.headers.origin);
  if (!HOST_RE.test(req.headers.host || '') || !okOrigin || url.searchParams.get('t') !== TOKEN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const term = /^\/ws\/term\/([\w-]+)$/.exec(url.pathname);
    if (term) { terminals.attach(term[1], ws); return; }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello', data: { version: VERSION } }));
  });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? 'El puerto ' + PORT + ' ya está en uso: ¿Agentic Bridge ya está abierto? Usa BRIDGE_PORT para otro puerto.' : e.message);
  process.exit(1);
});

rooms.load();
refresh(true);
refreshBoards();
setInterval(() => { try { refresh(false); refreshBoards(); } catch (e) { console.error('[refresh]', e.message); } }, 2500);

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT;
  // Integrations (MCP bridge, hooks) read this to find the hub without hardcoding the port.
  fs.writeFileSync(path.join(DATA_DIR, 'hub.json'), JSON.stringify({ port: PORT, pid: process.pid, root: ROOT }, null, 1));
  console.log('\n  ◆ Agentic Bridge ' + VERSION + ' — el editor web4');
  console.log('  ▸ ' + url + '\n  ▸ datos: ' + DATA_DIR + '\n');
  if (process.argv.includes('--open')) {
    if (process.platform === 'win32') execFile('cmd.exe', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
  }
});

function shutdown() {
  terminals.killAll();
  agents.killAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
