#!/usr/bin/env node
'use strict';
// Agentic Bridge MCP server (stdio). Gives any Claude Code or Antigravity session tools to see
// the other sessions on this machine, across accounts, and to talk to them through the hub.
// stdout carries JSON-RPC only; diagnostics go to stderr.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DATA_DIR = process.env.BRIDGE_DATA_DIR || path.join(os.homedir(), '.agentic-bridge');
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const HUB_DOWN = 'Agentic Bridge no está abierto. Ábrelo con "Iniciar Agentic Bridge.cmd" (o `npm start` en su carpeta) y vuelve a intentarlo.';

function hub() {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hub.json'), 'utf8'));
    const token = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
    return { base: 'http://127.0.0.1:' + port, token };
  } catch (e) { return null; }
}

async function call(method, route, body) {
  const h = hub();
  if (!h) throw new Error(HUB_DOWN);
  let res;
  try {
    res = await fetch(h.base + route, {
      method,
      headers: { 'x-bridge-token': h.token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { throw new Error(HUB_DOWN); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'El hub respondió ' + res.status);
  return data;
}

// ---------- identity ----------
// Sessions started by the hub carry their id in BRIDGE_*; Claude Code itself passes
// CLAUDE_CODE_SESSION_ID to its children. As a last resort, walk up the process tree to the
// claude process, whose pid the hub knows from the session registry.
function ancestors() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
        { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(walk(err ? '' : out)));
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5000 }, (err, out) => resolve(walk(err ? '' : out)));
    }
  });
}

function walk(table) {
  const parent = new Map();
  for (const line of String(table).split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parent.set(pid, ppid);
  }
  const chain = [];
  let p = process.ppid;
  for (let i = 0; i < 10 && p && !chain.includes(p); i++) { chain.push(p); p = parent.get(p); }
  return chain.length ? chain : [process.ppid];
}

let fromPromise = null;
function from() {
  if (!fromPromise) {
    fromPromise = (async () => {
      if (process.env.BRIDGE_AGENT_ID) return { agent: process.env.BRIDGE_AGENT_ID };
      if (process.env.BRIDGE_SESSION_ID) return { sid: process.env.BRIDGE_SESSION_ID };
      if (process.env.CLAUDE_CODE_SESSION_ID) return { sid: process.env.CLAUDE_CODE_SESSION_ID };
      return { pids: (await ancestors()).join(',') };
    })();
  }
  return fromPromise;
}

function qs(o) { return Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); }

async function whoami() {
  const who = await call('GET', '/api/bridge/whoami?' + qs(await from()));
  return who && who.kind !== 'unknown' ? who : null;
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'bridge_whoami',
    description: 'Dice quién eres en Agentic Bridge: tu nombre de sesión, cuenta y las salas donde estás.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_sessions',
    description: 'Lista las sesiones de Claude Code y Antigravity abiertas en este equipo, de todas las cuentas, con su estado y tarea actual. Úsalo para saber a quién escribir.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_rooms',
    description: 'Lista las salas de chat de Agentic Bridge (equipos de agentes y humanos) y si perteneces a cada una.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_read',
    description: 'Lee mensajes. Sin "room", devuelve y marca como leídos los mensajes nuevos dirigidos a ti. Con "room" (nombre o id de sala), devuelve sus últimos mensajes.',
    inputSchema: { type: 'object', properties: { room: { type: 'string', description: 'Nombre o id de la sala (opcional)' }, limit: { type: 'number', description: 'Cuántos mensajes (por defecto 20)' } } },
  },
  {
    name: 'bridge_send',
    description: 'Envía un mensaje. "to" puede ser "#sala" (nombre de sala), "@sesion" (nombre de otra sesión) o "@humano". Dentro de una sala, menciona con @handle a quien deba actuar.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '"#sala", "@sesion" o "@humano"' },
        text: { type: 'string', description: 'El mensaje (markdown)' },
        as: { type: 'string', description: 'Nombre con el que firmar, si el tuyo no es claro (opcional)' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'bridge_join',
    description: 'Te une a una sala para recibir sus mensajes en tu buzón.',
    inputSchema: { type: 'object', properties: { room: { type: 'string' } }, required: ['room'] },
  },
  {
    name: 'bridge_vault_save',
    description: 'Guarda una nota en el Baúl de Agentic Bridge, la memoria compartida por el humano y todas las sesiones de todas las cuentas: decisiones, comandos útiles, hallazgos, fragmentos de código.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título corto' },
        text: { type: 'string', description: 'Contenido (markdown)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Etiquetas opcionales' },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'bridge_vault_search',
    description: 'Busca en el Baúl de Agentic Bridge notas guardadas por el humano u otras sesiones. Sin "query" devuelve las más recientes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'bridge_board_read',
    description: 'Lee la pizarra (Excalidraw) de un proyecto o una pizarra libre de Agentic Bridge: columnas, tarjetas y notas en texto. Sin "board" usa el proyecto de tu sala o de tu carpeta.',
    inputSchema: { type: 'object', properties: { board: { type: 'string', description: 'Nombre del proyecto o de la pizarra (opcional)' } } },
  },
  {
    name: 'bridge_board_note',
    description: 'Pega una nota adhesiva en la pizarra de un proyecto para que el humano y el equipo la vean: hallazgos, riesgos, decisiones, preguntas. Sin "board" usa el proyecto de tu sala o de tu carpeta.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Texto de la nota (corto)' }, board: { type: 'string', description: 'Nombre del proyecto o de la pizarra (opcional)' } },
      required: ['text'],
    },
  },
];

function fmtTime(iso) { const d = new Date(iso); return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

async function runTool(name, args) {
  args = args || {};
  if (name === 'bridge_whoami') {
    const who = await whoami();
    if (!who) return 'No pude asociarte a una sesión registrada. Aun así puedes usar bridge_send con el parámetro "as" para firmar.';
    const rooms = await call('GET', '/api/bridge/rooms?' + qs({ sid: who.sessionId }));
    const mine = rooms.filter((r) => r.joined).map((r) => '#' + r.name);
    return 'Eres "' + who.name + '" (' + (who.kind === 'agent' ? 'agente de sala' : 'sesión') + (who.account ? ', cuenta ' + who.account : '') + ').\nSalas: ' + (mine.length ? mine.join(', ') : 'ninguna todavía');
  }
  if (name === 'bridge_sessions') {
    const list = await call('GET', '/api/bridge/sessions');
    if (!list.length) return 'No hay otras sesiones abiertas.';
    return list.map((s) => '- @' + s.name + ' · ' + (s.source === 'antigravity' ? 'Antigravity' : s.account || 'cuenta ?') + ' · ' + (s.status === 'busy' ? 'trabajando' : s.status === 'idle' ? 'en espera' : s.status) + (s.task ? ' · tarea ' + s.task : '') + (s.cwd ? '\n  ' + s.cwd : '')).join('\n');
  }
  if (name === 'bridge_rooms') {
    const who = await whoami();
    const list = await call('GET', '/api/bridge/rooms?' + qs({ sid: who && who.sessionId }));
    if (!list.length) return 'No hay salas todavía. El humano puede crearlas en Agentic Bridge.';
    return list.map((r) => '- #' + r.name + (r.joined ? ' (estás dentro)' : '') + (r.topic ? ' — ' + r.topic : '') + '\n  miembros: ' + r.members.join(', ')).join('\n');
  }
  if (name === 'bridge_read') {
    if (args.room) {
      const out = await call('GET', '/api/bridge/rooms/' + encodeURIComponent(String(args.room).replace(/^#/, '')) + '/messages?limit=' + (Number(args.limit) || 20));
      if (!out.messages.length) return 'La sala #' + out.room + ' no tiene mensajes.';
      return '#' + out.room + '\n\n' + out.messages.map((m) => '— ' + m.from + ' · ' + fmtTime(m.at) + '\n' + m.text + (m.attachments.length ? '\nAdjuntos: ' + m.attachments.join(', ') : '')).join('\n\n');
    }
    const who = await whoami();
    if (!who) return 'No pude identificar tu sesión, así que no tengo un buzón para ti. Usa bridge_read con "room".';
    if (who.kind === 'agent') return 'Eres un agente de sala: tus mensajes nuevos te llegan en cada turno. Usa bridge_read con "room" para ver otra sala.';
    const out = await call('GET', '/api/bridge/inbox/' + encodeURIComponent(who.sessionId) + '?consume=1');
    if (!out.messages.length) return 'No tienes mensajes nuevos.';
    return out.messages.map((m) => '— #' + m.room + ' · ' + m.from + ' · ' + fmtTime(new Date(m.at).toISOString()) + '\n' + m.text + (m.attachments && m.attachments.length ? '\nAdjuntos: ' + m.attachments.join(', ') : '')).join('\n\n');
  }
  if (name === 'bridge_send') {
    const out = await call('POST', '/api/bridge/send', { from: await from(), to: args.to, text: args.text, as: args.as });
    return 'Enviado a #' + out.room + '.';
  }
  if (name === 'bridge_join') {
    const out = await call('POST', '/api/bridge/join', { from: await from(), room: args.room });
    return 'Te uniste a #' + out.room + '. Sus mensajes llegarán a tu buzón.';
  }
  if (name === 'bridge_vault_save') {
    const out = await call('POST', '/api/bridge/vault', { from: await from(), title: args.title, text: args.text, tags: args.tags });
    return 'Guardado en el Baúl: "' + out.title + '".';
  }
  if (name === 'bridge_vault_search') {
    const list = await call('GET', '/api/bridge/vault?' + qs({ q: args.query, limit: args.limit }));
    if (!list.length) return args.query ? 'Nada en el Baúl coincide con "' + args.query + '".' : 'El Baúl está vacío.';
    return list.map((n) => '## ' + n.title + (n.tags.length ? '  #' + n.tags.join(' #') : '') + '\n_' + (n.author || '?') + ' · ' + n.updatedAt.slice(0, 16).replace('T', ' ') + '_\n\n' + n.text + (n.attachments.length ? '\n\nAdjuntos: ' + n.attachments.join(', ') : '')).join('\n\n---\n\n');
  }
  if (name === 'bridge_board_read') {
    const b = await call('GET', '/api/bridge/board?' + qs(Object.assign({ board: args.board }, await from())));
    const parts = ['Pizarra "' + b.name + '"'];
    if (b.frames.length) parts.push('Columnas: ' + b.frames.join(' · '));
    parts.push(b.texts.length ? b.texts.map((t) => '- ' + t.replace(/\n/g, ' / ')).join('\n') : '(sin textos)');
    if (b.pending.length) parts.push('Notas recién llegadas:\n' + b.pending.map((t) => '- ' + t).join('\n'));
    return parts.join('\n\n');
  }
  if (name === 'bridge_board_note') {
    const out = await call('POST', '/api/bridge/board/note', { from: await from(), board: args.board, text: args.text });
    return 'Nota pegada en la pizarra (' + out.board + '). Aparece en cuanto alguien la tenga abierta.';
  }
  throw new Error('Herramienta desconocida: ' + name);
}

// ---------- JSON-RPC over stdio ----------
function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}

async function onMessage(msg) {
  if (!msg || msg.id === undefined || msg.id === null) return; // notification
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    return reply(id, {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'agentic-bridge', version: '0.1.0' },
      instructions: 'Agentic Bridge conecta todas las sesiones de Claude Code y Antigravity de este equipo, de cualquier cuenta. Usa bridge_sessions para ver quién está, bridge_send para escribir a una sala (#sala) o sesión (@nombre) y bridge_read para leer tu buzón.',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await runTool(params && params.name, params && params.arguments);
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return reply(id, null, { code: -32601, message: 'Método no soportado: ' + method });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    onMessage(msg).catch((e) => process.stderr.write('[agentic-bridge] ' + e.message + '\n'));
  }
});
process.stdin.on('end', () => process.exit(0));
