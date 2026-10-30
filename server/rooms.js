'use strict';
// Rooms: group chats where the human, headless agents and live Claude sessions talk.
// Agents are driven by the hub (agents.js). Live sessions get messages through their inbox,
// which the Bridge hooks and MCP tools read; a session living in an embedded terminal is
// also nudged by typing into it when idle.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { readJson, writeJson, uid, uuid, slug, clip } = require('./util');
const store = require('./store');
const agents = require('./agents');
const terminals = require('./terminals');
const { withIcon } = require('./roles');

const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const INBOX_DIR = path.join(DATA_DIR, 'inbox');
const UNREAD_DIR = path.join(DATA_DIR, 'unread');
const MAX_CATCHUP = 30;
const SILENT = /^\(?\s*sin comentarios\s*\)?\.?$/i;

const rooms = new Map(); // id -> { meta, messages }
const activity = new Map(); // roomId:memberId -> { state, text, at }
const pending = new Set();
let sessionLookup = () => null;

const emit = (type, data) => store.bus.emit('event', { type, data });

// A number from user input, keeping an explicit 0 (unlike `Number(x) || def`).
function num(v, def) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? def : n;
}

// ---------- persistence ----------
function metaFile(id) { return path.join(ROOMS_DIR, id + '.json'); }
function logFile(id) { return path.join(ROOMS_DIR, id + '.jsonl'); }

function load() {
  let files = [];
  try { files = fs.readdirSync(ROOMS_DIR).filter((f) => f.endsWith('.json')); } catch (e) {}
  for (const f of files) {
    const meta = readJson(path.join(ROOMS_DIR, f));
    if (!meta || !meta.id) continue;
    meta.members = (meta.members || []).map((m) => (m.kind === 'agent' ? withIcon(m) : m));
    let messages = [];
    try {
      messages = fs.readFileSync(logFile(meta.id), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) {}
    rooms.set(meta.id, { meta, messages });
  }
}

const saveTimers = new Map();
function saveMeta(room) {
  clearTimeout(saveTimers.get(room.meta.id));
  saveTimers.set(room.meta.id, setTimeout(() => {
    saveTimers.delete(room.meta.id);
    // A room deleted in the meantime must not be written back to disk.
    if (rooms.has(room.meta.id)) writeJson(metaFile(room.meta.id), room.meta);
  }, 250));
}

// ---------- views ----------
function summary(room) {
  const last = room.messages[room.messages.length - 1] || null;
  return Object.assign({}, room.meta, {
    messageCount: room.messages.length,
    last: last ? { author: last.author, text: clip(last.text, 160), at: last.at } : null,
    activity: memberActivity(room.meta.id),
  });
}

function memberActivity(roomId) {
  const out = {};
  for (const [k, v] of activity) if (k.startsWith(roomId + ':')) out[k.slice(roomId.length + 1)] = v;
  return out;
}

function list() {
  return [...rooms.values()].map(summary).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function get(id, limit = 400) {
  const room = rooms.get(id);
  if (!room) return null;
  return Object.assign(summary(room), { messages: room.messages.slice(-limit) });
}

function touch(room) {
  room.meta.updatedAt = Date.now();
  saveMeta(room);
  emit('room', summary(room));
}

// ---------- members ----------
function humanName() { return store.prefs.get().humanName || 'Usuario'; }

function uniqueHandle(room, base) {
  const taken = new Set(room.meta.members.map((m) => m.handle));
  let h = slug(base);
  for (let i = 2; taken.has(h); i++) h = slug(base) + '-' + i;
  return h;
}

/**
 * spec.kind 'agent':   { roleId, name?, configPath, cwd, model?, permissionMode? }
 * spec.kind 'session': { sessionId, name }
 */
function makeMember(room, spec) {
  if (spec.kind === 'session') {
    return { id: 'm_' + spec.sessionId.slice(0, 12), kind: 'session', sessionId: spec.sessionId, name: spec.name || spec.sessionId.slice(0, 8), handle: uniqueHandle(room, spec.name || 'sesion') };
  }
  const role = store.roles.get().find((r) => r.id === spec.roleId) || {};
  const name = spec.name || role.name || 'Agente';
  return {
    id: uid('a'),
    kind: 'agent',
    name,
    handle: uniqueHandle(room, name),
    roleId: role.id || null,
    icon: role.icon || 'bot',
    color: role.color || '#a78bfa',
    configPath: spec.configPath || null,
    configDir: spec.configPath ? path.basename(spec.configPath) : null,
    cwd: spec.cwd || require('os').homedir(),
    model: spec.model != null ? spec.model : role.model || '',
    permissionMode: spec.permissionMode || role.permissionMode || 'acceptEdits',
    allowedTools: role.allowedTools || [],
    sessionUuid: uuid(),
    started: false,
  };
}

function create({ name, topic, mode, maxAutoTurns, budgetUsd, projectId, members }) {
  const id = uid('r');
  const meta = {
    id, name: name || 'sala', topic: topic || '', mode: mode || 'lead', projectId: projectId || null,
    maxAutoTurns: Math.max(0, num(maxAutoTurns, 6)), autoLeft: Math.max(0, num(maxAutoTurns, 6)),
    budgetUsd: Math.max(0, num(budgetUsd, 0)), spentUsd: 0, leadId: null,
    members: [], cursors: {}, createdAt: Date.now(), updatedAt: Date.now(),
  };
  const room = { meta, messages: [] };
  rooms.set(id, room);
  for (const spec of members || []) meta.members.push(makeMember(room, spec));
  meta.leadId = (meta.members.find((m) => m.kind === 'agent') || {}).id || null;
  writeJson(metaFile(id), meta);
  fs.writeFileSync(logFile(id), '');
  emit('room', summary(room));
  return summary(room);
}

function update(id, patch) {
  const room = rooms.get(id);
  if (!room) return null;
  for (const k of ['name', 'topic', 'mode', 'leadId']) if (patch[k] !== undefined) room.meta[k] = patch[k];
  if (patch.maxAutoTurns !== undefined) room.meta.maxAutoTurns = room.meta.autoLeft = Math.max(0, num(patch.maxAutoTurns, room.meta.maxAutoTurns));
  if (patch.budgetUsd !== undefined) room.meta.budgetUsd = Math.max(0, num(patch.budgetUsd, room.meta.budgetUsd));
  touch(room);
  return summary(room);
}

function updateMember(id, memberId, patch) {
  const room = rooms.get(id);
  const m = room && room.meta.members.find((x) => x.id === memberId);
  if (!m) return null;
  for (const k of ['name', 'model', 'permissionMode', 'cwd']) if (patch[k] !== undefined) m[k] = patch[k];
  if (patch.name) m.handle = uniqueHandle({ meta: { members: room.meta.members.filter((x) => x !== m) } }, patch.name);
  touch(room);
  return summary(room);
}

function addMember(id, spec) {
  const room = rooms.get(id);
  if (!room) return null;
  if (spec.kind === 'session' && room.meta.members.some((m) => m.sessionId === spec.sessionId)) return summary(room);
  const m = makeMember(room, spec);
  room.meta.members.push(m);
  if (!room.meta.leadId && m.kind === 'agent') room.meta.leadId = m.id;
  // A newcomer starts reading from now, not from the room's whole history.
  room.meta.cursors[m.id] = room.messages.length ? room.messages[room.messages.length - 1].seq : 0;
  touch(room);
  return summary(room);
}

function removeMember(id, memberId) {
  const room = rooms.get(id);
  if (!room) return null;
  pending.delete(id + ':' + memberId);
  agents.kill(id + ':' + memberId);
  room.meta.members = room.meta.members.filter((m) => m.id !== memberId);
  if (room.meta.leadId === memberId) room.meta.leadId = (room.meta.members.find((m) => m.kind === 'agent') || {}).id || null;
  touch(room);
  return summary(room);
}

function remove(id) {
  const room = rooms.get(id);
  if (!room) return false;
  stop(id);
  rooms.delete(id);
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  try { fs.rmSync(metaFile(id), { force: true }); fs.rmSync(logFile(id), { force: true }); } catch (e) {}
  emit('room:deleted', { id });
  return true;
}

// ---------- messages ----------
function append(room, author, text, attachments, meta) {
  const last = room.messages[room.messages.length - 1];
  const msg = {
    id: uid('msg'), seq: (last ? last.seq : 0) + 1, at: Date.now(),
    author, text: String(text || ''), attachments: attachments || [], meta: meta || null,
  };
  room.messages.push(msg);
  fs.appendFileSync(logFile(room.meta.id), JSON.stringify(msg) + '\n');
  emit('room:message', { roomId: room.meta.id, message: msg });
  touch(room);
  return msg;
}

function mentionsIn(text, room) {
  const handles = new Set();
  const re = /@([\p{L}\p{N}_-]+)/gu;
  let m;
  while ((m = re.exec(text))) handles.add(slug(m[1]));
  const all = handles.has('todos') || handles.has('all') || handles.has('equipo');
  const ids = room.meta.members.filter((x) => handles.has(x.handle)).map((x) => x.id);
  return { all, ids };
}

function systemNote(room, text) {
  return append(room, { kind: 'system', id: 'system', name: 'Bridge' }, text, [], null);
}

function post(id, author, text, attachments, meta) {
  const room = rooms.get(id);
  if (!room) throw new Error('La sala no existe');
  const msg = append(room, author, text, attachments, meta);
  deliverToSessions(room, msg);
  scheduleAgents(room, msg);
  return msg;
}

function postAsHuman(id, text, attachments) {
  return post(id, { kind: 'human', id: 'human', name: humanName() }, text, attachments);
}

// ---------- live sessions ----------
function inboxFile(sid) { return path.join(INBOX_DIR, sid.replace(/[^\w.-]/g, '_') + '.jsonl'); }
function unreadFile(sid) { return path.join(UNREAD_DIR, sid.replace(/[^\w.-]/g, '_')); }

function inboxCount(sid) {
  try { return fs.readFileSync(inboxFile(sid), 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; }
}

function setUnread(sid) {
  const n = inboxCount(sid);
  try { fs.writeFileSync(unreadFile(sid), String(n)); } catch (e) {}
  emit('unread', { sessionId: sid, count: n });
}

const nudgeTimers = new Map();
function deliverToSessions(room, msg) {
  for (const m of room.meta.members) {
    if (m.kind !== 'session' || m.sessionId === msg.author.id) continue;
    const entry = {
      roomId: room.meta.id, room: room.meta.name, msgId: msg.id, at: msg.at,
      from: msg.author.name, fromKind: msg.author.kind, text: msg.text,
      attachments: (msg.attachments || []).map((a) => a.path),
    };
    fs.appendFileSync(inboxFile(m.sessionId), JSON.stringify(entry) + '\n');
    setUnread(m.sessionId);
    // A session in an embedded terminal can be woken up: type a short prompt when it is idle.
    clearTimeout(nudgeTimers.get(m.sessionId));
    nudgeTimers.set(m.sessionId, setTimeout(() => {
      const s = sessionLookup(m.sessionId);
      if (s && s.status === 'idle' && inboxCount(m.sessionId) > 0) {
        terminals.typeInto(m.sessionId, '[Bridge] Tienes mensajes nuevos de Agentic Bridge. Léelos (vienen en el contexto o con bridge_read) y responde con bridge_send si corresponde.');
      }
    }, 2500));
  }
}

function consumeInbox(sid) {
  const f = inboxFile(sid);
  let items = [];
  try {
    items = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    fs.writeFileSync(f, '');
  } catch (e) {}
  setUnread(sid);
  return items;
}

function peekInbox(sid) {
  try {
    return fs.readFileSync(inboxFile(sid), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Direct line between two parties: reuses or creates a two-member room.
function directRoom(fromSession, toSession) {
  const key = [fromSession && fromSession.id, toSession.id].filter(Boolean).sort().join('|');
  for (const room of rooms.values()) if (room.meta.directKey === key) return room;
  const members = [{ kind: 'session', sessionId: toSession.id, name: toSession.name }];
  if (fromSession) members.push({ kind: 'session', sessionId: fromSession.id, name: fromSession.name });
  const s = create({ name: (fromSession ? fromSession.name : humanName()) + ' ↔ ' + toSession.name, topic: 'Mensajes directos', mode: 'mentions', members });
  const room = rooms.get(s.id);
  room.meta.directKey = key;
  saveMeta(room);
  return room;
}

// ---------- agents ----------
function setActivity(roomId, memberId, state, text) {
  const k = roomId + ':' + memberId;
  if (state === 'idle') activity.delete(k);
  else activity.set(k, { state, text: text || '', at: Date.now() });
  emit('activity', { roomId, memberId, state, text: text || '' });
}

function scheduleAgents(room, msg) {
  const roomAgents = room.meta.members.filter((m) => m.kind === 'agent' && m.id !== msg.author.id);
  if (!roomAgents.length) return;
  const { all, ids } = mentionsIn(msg.text, room);
  let targets = [];
  if (msg.author.kind === 'human') {
    room.meta.autoLeft = room.meta.maxAutoTurns;
    if (all) targets = roomAgents;
    else if (ids.length) targets = roomAgents.filter((a) => ids.includes(a.id));
    else if (room.meta.mode === 'all') targets = roomAgents;
    else if (room.meta.mode === 'lead') targets = roomAgents.filter((a) => a.id === room.meta.leadId).slice(0, 1);
  } else if (msg.author.kind !== 'system') {
    targets = all ? roomAgents : roomAgents.filter((a) => ids.includes(a.id));
    if (!targets.length) return;
    // Only charge turns that will really happen: an agent already queued for a re-run
    // absorbs this mention for free. Never spend more turns than are left.
    const queued = targets.filter((a) => pending.has(room.meta.id + ':' + a.id));
    const fresh = targets.filter((a) => !pending.has(room.meta.id + ':' + a.id));
    if (fresh.length && room.meta.autoLeft <= 0) {
      systemNote(room, 'Se alcanzó el límite de ' + room.meta.maxAutoTurns + ' turnos automáticos entre agentes. Escribe en la sala para que continúen.');
      return;
    }
    const allowed = fresh.slice(0, room.meta.autoLeft);
    room.meta.autoLeft -= allowed.length;
    targets = queued.concat(allowed);
  }
  if (!targets.length) return;
  if (overBudget(room)) return;
  for (const a of targets) enqueue(room, a, msg);
}

function overBudget(room) {
  if (!room.meta.budgetUsd || room.meta.spentUsd < room.meta.budgetUsd) return false;
  systemNote(room, 'Presupuesto de la sala agotado (US$' + room.meta.spentUsd.toFixed(2) + ' de US$' + room.meta.budgetUsd.toFixed(2) + '). Súbelo en los ajustes de la sala para continuar.');
  return true;
}

function isMember(room, memberId) { return room.meta.members.some((m) => m.id === memberId); }

function enqueue(room, agent, trigger) {
  const key = room.meta.id + ':' + agent.id;
  if (agents.isRunning(key)) { pending.add(key); return; }
  runAgent(room, agent, trigger).catch((e) => {
    setActivity(room.meta.id, agent.id, 'idle');
    systemNote(room, agent.name + ' no pudo responder: ' + e.message);
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function authorLabel(a) {
  if (a.kind === 'human') return a.name + ' (humano)';
  if (a.kind === 'system') return 'Bridge (sistema)';
  if (a.kind === 'session') return a.name + ' (sesión de Claude)';
  return a.name + ' (agente)';
}

function systemPromptFor(room, agent) {
  const role = store.roles.get().find((r) => r.id === agent.roleId);
  const members = room.meta.members.map((m) => '- @' + m.handle + ' — ' + m.name + (m.kind === 'agent' ? ' (agente' + (m.id === room.meta.leadId ? ', coordina la sala' : '') + ')' : ' (sesión de Claude en vivo)'));
  return [
    role ? role.prompt : 'Eres un agente de un equipo de desarrollo.',
    '# Agentic Bridge',
    'Estás en la sala "' + room.meta.name + '" de Agentic Bridge, el editor web4 donde humanos y agentes trabajan juntos.' + (room.meta.topic ? ' Tema de la sala: ' + room.meta.topic + '.' : ''),
    'Tu nombre en la sala es "' + agent.name + '" y tu handle es @' + agent.handle + '. El humano es ' + humanName() + ' (no tiene handle; dirígete a él por su nombre).',
    'Miembros:\n' + members.join('\n'),
    'Tu carpeta de trabajo es: ' + agent.cwd,
    [
      'Reglas de la sala:',
      '- Tu respuesta final de cada turno se publica en la sala tal cual. Escríbela para el equipo: breve, concreta y en español.',
      '- Para pedirle algo a otro miembro, menciónalo con @handle. Menciona solo cuando necesites que actúe, porque cada mención le da un turno.',
      '- No repitas lo que otro ya dijo. Si no tienes nada útil que aportar, responde exactamente: (sin comentarios)',
      '- Si un mensaje trae adjuntos, sus rutas están en el texto; ábrelos con Read si los necesitas.',
      '- Tienes herramientas MCP bridge_* para leer otras salas o escribir a otras sesiones si hace falta.',
      room.meta.projectId ? '- El proyecto tiene una pizarra que el humano mira (su kanban sale de todo.md). Deja ahí riesgos, decisiones o preguntas cortas con bridge_board_note; léela con bridge_board_read.' : null,
      room.meta.leadId === agent.id ? '- Coordinas la sala: puedes sumar un agente con bridge_room_create_agent (un rol del equipo) o invitar una sesión abierta con bridge_room_invite. Hazlo solo cuando el trabajo lo pida o el humano lo solicite: cada agente consume turnos y presupuesto.' : null,
    ].filter(Boolean).join('\n'),
  ].join('\n\n');
}

function catchUpPrompt(room, agent, news, trigger) {
  const parts = ['[Agentic Bridge · sala "' + room.meta.name + '"] Mensajes nuevos desde tu último turno:'];
  for (const m of news.slice(-MAX_CATCHUP)) {
    let block = '— ' + authorLabel(m.author) + ' · ' + fmtTime(m.at) + '\n' + clip(m.text, 6000);
    if (m.attachments && m.attachments.length) block += '\nAdjuntos: ' + m.attachments.map((a) => a.path + (a.type && a.type.startsWith('image/') ? ' (imagen)' : '')).join(', ');
    parts.push(block);
  }
  const mentioned = trigger && mentionsIn(trigger.text, room);
  if (mentioned && (mentioned.all || mentioned.ids.includes(agent.id))) parts.push('Te mencionaron directamente: te toca responder.');
  else if (room.meta.leadId === agent.id) parts.push('Coordinas esta sala: responde tú y menciona a quien deba actuar.');
  parts.push('Responde ahora. Tu respuesta final se publicará en la sala.');
  return parts.join('\n\n');
}

async function runAgent(room, agent, trigger) {
  const key = room.meta.id + ':' + agent.id;
  const since = room.meta.cursors[agent.id] || 0;
  const news = room.messages.filter((m) => m.seq > since && m.author.id !== agent.id);
  if (!news.length) return;
  room.meta.cursors[agent.id] = room.messages[room.messages.length - 1].seq;
  saveMeta(room);
  setActivity(room.meta.id, agent.id, 'running', 'pensando…');
  const res = await agents.runTurn({
    key,
    agent,
    roomId: room.meta.id,
    systemPrompt: systemPromptFor(room, agent),
    prompt: catchUpPrompt(room, agent, news, trigger),
    onEvent: (ev) => {
      if (ev.kind === 'start') { agent.started = true; saveMeta(room); }
      else if (ev.kind === 'tool') setActivity(room.meta.id, agent.id, 'running', 'usando ' + ev.name + (ev.text ? ' · ' + ev.text : ''));
      else if (ev.kind === 'text') setActivity(room.meta.id, agent.id, 'running', 'escribiendo…');
    },
  });
  if (!rooms.has(room.meta.id)) return;
  room.meta.spentUsd = (room.meta.spentUsd || 0) + (res.cost || 0);
  setActivity(room.meta.id, agent.id, 'idle');
  // Removed from the room while it worked: its turn is discarded.
  if (!isMember(room, agent.id)) { pending.delete(key); saveMeta(room); return; }
  const meta = { cost: res.cost, tools: res.tools.length, durationMs: res.durationMs };
  if (res.isError) {
    systemNote(room, agent.name + ' no pudo terminar su turno: ' + clip(res.error || 'error desconocido', 400));
  } else {
    const text = (res.text || '').trim();
    if (text && !SILENT.test(text)) {
      post(room.meta.id, { kind: 'agent', id: agent.id, name: agent.name, icon: agent.icon, color: agent.color, roleId: agent.roleId }, text, [], meta);
    } else touch(room);
  }
  if (pending.delete(key) && !overBudget(room)) enqueue(room, agent, null);
}

function stop(id) {
  const room = rooms.get(id);
  if (!room) return false;
  for (const m of room.meta.members) {
    pending.delete(id + ':' + m.id);
    agents.kill(id + ':' + m.id);
  }
  return true;
}

function findRoom(ref) {
  if (!ref) return null;
  const r = String(ref).replace(/^#/, '');
  if (rooms.has(r)) return rooms.get(r);
  const s = slug(r);
  for (const room of rooms.values()) if (slug(room.meta.name) === s) return room;
  return null;
}

function roomsForSession(sid) {
  return [...rooms.values()].filter((r) => r.meta.members.some((m) => m.sessionId === sid)).map(summary);
}

module.exports = {
  load, list, get, create, update, remove, addMember, removeMember, updateMember,
  post, postAsHuman, stop, consumeInbox, peekInbox, inboxCount, directRoom, findRoom, roomsForSession,
  note: (id, text) => { const room = rooms.get(id); return room ? systemNote(room, text) : null; },
  setSessionLookup: (fn) => { sessionLookup = fn; },
  raw: (id) => rooms.get(id) || null,
};
