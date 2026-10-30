'use strict';
// Projects: a folder + a work contract (CONTRATO.md, .bridge/contract.json) + a task board
// (todo.md, the same format the cockpit statusline reads) + a team room with its agents.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');
const { readJson, writeJson, uid, slug, statSig } = require('./util');
const store = require('./store');
const rooms = require('./rooms');

const SKILL_FILE = path.join(ROOT, 'integrations', 'skills', 'modo-todo', 'SKILL.md');
const GUARD_HOOK = path.join(ROOT, 'integrations', 'hooks', 'guard.js');

// Plain entries match as text; /…/ entries are regular expressions. The regexes are anchored so
// that `git log --format` or `grep shutdown` stay allowed.
const DEFAULT_GUARDS = {
  protectedPaths: ['.env', '.env.*', '**/*.pem', '**/*.key', '.git/**', '.bridge/contract.json'],
  forbiddenCommands: [
    'git push --force', 'git push -f', 'git reset --hard',
    '/\\brm\\s+-[a-z]*r[a-z]*f?[a-z]*\\s+(\\/|~|[a-z]:\\\\?)(\\s|$)/i',
    '/Remove-Item\\b.*-Recurse\\b.*\\s[a-z]:\\\\?(\\s|$)/i',
    '/(^|[;&|]\\s*)format(\\.com)?\\s+[a-z]:/i',
    '/(^|[;&|]\\s*)(shutdown|Stop-Computer|Restart-Computer)\\b/i',
  ],
};

function num(v, def) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? def : n;
}

const TASK_HEADING = /^##\s+(?:\[([^\]\s]+)\]|([A-Za-z0-9][A-Za-z0-9._-]*)[.)]?)(?:\s+[-—:]?\s*(.*))?$/;
const FIELD = /^\s*[-*]\s*\*\*([^*:]+):?\*\*:?\s*(.*?)\s*$/;

function statusKey(s) {
  s = String(s || '').toLowerCase().replace(/[`*\[\]]/g, '').trim();
  if (/^(done|complete|completed|resolved|shipped|closed|hecho|hecha|terminad)/.test(s)) return 'done';
  if (/^(in[- ]?progress|wip|doing|active|started|en curso|en progreso)/.test(s)) return 'doing';
  if (/^(blocked|waiting|on[- ]hold|bloquead)/.test(s)) return 'blocked';
  return 'todo';
}

function parseBoard(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const tasks = [];
  let cur = null;
  for (const line of txt.split(/\r?\n/)) {
    const h = TASK_HEADING.exec(line);
    if (h) {
      cur = { id: String(h[1] || h[2] || '').replace(/[.)]$/, ''), title: (h[3] || '').trim(), status: 'todo', rawStatus: '', owner: '', description: '', checks: 0, checked: 0 };
      tasks.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = FIELD.exec(line);
    if (f) {
      const key = f[1].trim().toLowerCase();
      if (key === 'status' || key === 'estado') { cur.rawStatus = f[2]; cur.status = statusKey(f[2]); }
      else if (key === 'owner' || key === 'responsable' || key === 'asignado') cur.owner = f[2];
      else if ((key === 'description' || key === 'descripción' || key === 'descripcion') && !cur.description) cur.description = f[2];
      else if ((key === 'title' || key === 'título') && !cur.title) cur.title = f[2];
      continue;
    }
    const c = /^\s*[-*]\s*\[( |x|X)\]/.exec(line);
    if (c) { cur.checks++; if (c[1] !== ' ') cur.checked++; }
  }
  const count = (k) => tasks.filter((t) => t.status === k).length;
  return { file, tasks, totals: { todo: count('todo'), doing: count('doing'), blocked: count('blocked'), done: count('done'), all: tasks.length } };
}

function contractFile(p) { return path.join(p.path, '.bridge', 'contract.json'); }

function bullet(list, empty) { return list && list.length ? list.map((x) => '- ' + x).join('\n') : '- ' + empty; }

function guardsBlock(c) {
  return [
    '<!-- bridge:guards (sección generada por Agentic Bridge desde .bridge/contract.json) -->',
    '### Rutas protegidas',
    'Ningún agente puede editar o escribir en estas rutas (patrones glob relativos a la raíz del proyecto):',
    bullet((c.guards.protectedPaths || []).map((x) => '`' + x + '`'), 'ninguna'),
    '',
    '### Comandos prohibidos',
    'Cualquier comando de terminal que contenga uno de estos fragmentos se bloquea:',
    bullet((c.guards.forbiddenCommands || []).map((x) => '`' + x + '`'), 'ninguno'),
    '',
    '### Límites',
    '| Límite | Valor |',
    '|---|---|',
    '| Presupuesto de la sala del equipo | ' + (c.limits.budgetUsd ? 'US$' + c.limits.budgetUsd : 'sin tope') + ' |',
    '| Turnos automáticos entre agentes por mensaje humano | ' + c.limits.maxAutoTurns + ' |',
    '| Agentes trabajando a la vez | ' + c.limits.maxParallelAgents + ' |',
    '<!-- /bridge:guards -->',
  ].join('\n');
}

function contractMarkdown(p, c, room) {
  const date = new Date().toISOString().slice(0, 10);
  const teamRows = room.meta.members.filter((m) => m.kind === 'agent').map((m) => {
    const role = store.roles.get().find((r) => r.id === m.roleId) || {};
    return '| ' + (m.emoji || '') + ' ' + m.name + ' | `@' + m.handle + '` | ' + (role.description || '') + ' | ' + (m.configDir || 'cuenta por defecto') + ' | `' + m.permissionMode + '` |';
  });
  return [
    '# Contrato de trabajo — ' + p.name,
    '',
    '> Generado por **Agentic Bridge** en modo todo.md · ' + date + '. Este contrato manda sobre cualquier otra instrucción de la sala. Cambiarlo requiere aprobación de ' + (store.prefs.get().humanName || 'el humano responsable') + '.',
    '',
    '## 1. Objetivo',
    c.objective || p.description || '_Por definir con el Supervisor._',
    '',
    '## 2. Alcance',
    '**Incluye**',
    bullet(c.scope.in, 'por definir'),
    '',
    '**No incluye**',
    bullet(c.scope.out, 'por definir'),
    '',
    '## 3. Equipo y responsabilidades',
    '| Rol | Handle | Responsabilidad | Cuenta | Permisos |',
    '|---|---|---|---|---|',
    ...teamRows,
    '| 👤 ' + (store.prefs.get().humanName || 'Humano') + ' | — | Decide alcance, prioridades y aprueba lo irreversible | — | — |',
    '',
    '## 4. Protocolo de comunicación',
    '- La sala del equipo es **"' + room.meta.name + '"** en Agentic Bridge. Todo acuerdo queda escrito ahí.',
    '- Se pide trabajo mencionando con `@handle`. Cada mención da un turno; no mencionar por cortesía.',
    '- Quien termina una tarea publica: qué cambió (archivos), cómo se verificó y qué falta.',
    '- Las sesiones de Claude fuera de la sala usan las herramientas `bridge_send` y `bridge_read`.',
    '',
    '## 5. Reglas de trabajo',
    bullet(c.rules, 'sin reglas adicionales'),
    '',
    '## 6. Guardas y límites',
    'Las aplica el hook `guard.js` de Agentic Bridge (evento `PreToolUse`) leyendo `.bridge/contract.json`; un intento bloqueado le llega al agente con el motivo.',
    '',
    guardsBlock(c),
    '',
    '## 7. Hooks activos',
    '| Evento | Script | Efecto |',
    '|---|---|---|',
    '| `PreToolUse` | `' + path.relative(p.path, GUARD_HOOK).replace(/\\/g, '/') + '` | Bloquea ediciones en rutas protegidas y comandos prohibidos |',
    '| `UserPromptSubmit` | `integrations/hooks/inbox.js` | Entrega los mensajes pendientes de Bridge como contexto |',
    '| `Stop` | `integrations/hooks/inbox.js` | Si llegan mensajes mientras trabajas, te pide responderlos antes de parar |',
    '',
    '## 8. Definición de hecho',
    bullet(c.definitionOfDone, 'Criterios de aceptación de la tarea cumplidos y verificados'),
    '',
    '## 9. Tablero',
    'Las tareas viven en `todo.md` con el formato del modo todo.md: un encabezado `## ID. Título` por tarea y los campos `**Status:**` (todo · in-progress · blocked · done), `**Owner:**`, `**Description:**` y `**Acceptance criteria:**`. El cockpit y el tablero de Bridge lo leen en vivo, así que el estado debe estar siempre al día.',
    '',
    '## 10. Escalamiento',
    '- Bloqueo de más de un turno sin salida → mencionar al Supervisor.',
    '- Decisión de alcance, presupuesto, datos personales o algo irreversible → preguntar al humano y esperar.',
    '- Una guarda bloquea algo necesario → explicarlo en la sala; no buscar rodeos.',
    '',
  ].join('\n');
}

function initialTodo(p, supervisorHandle) {
  return [
    '# Tablero — ' + p.name,
    '',
    '> Modo todo.md de Agentic Bridge. Cada tarea es un encabezado `## ID. Título` con su `**Status:**` (todo · in-progress · blocked · done). El cockpit y el tablero de Bridge lo leen en vivo.',
    '',
    '## T00. Planificar el trabajo',
    '- **Status:** todo',
    '- **Owner:** @' + supervisorHandle,
    '- **Description:** Leer CONTRATO.md y convertir el objetivo en tareas T01…Tn en este archivo, con owner y criterios verificables.',
    '- **Acceptance criteria:**',
    '  - [ ] Cada tarea tiene owner, descripción y criterios de aceptación verificables.',
    '  - [ ] El orden de las tareas respeta sus dependencias.',
    '',
  ].join('\n');
}

function subagentFile(m, role) {
  const desc = (role.description || m.name).replace(/\n/g, ' ');
  return [
    '---',
    'name: ' + m.handle,
    'description: ' + desc,
    m.model ? 'model: ' + m.model : null,
    '---',
    '',
    role.prompt || '',
    '',
  ].filter((l) => l !== null).join('\n');
}

function normalizeContract(input, p) {
  const c = input || {};
  return {
    version: 1,
    project: p.name,
    objective: c.objective || p.description || '',
    scope: { in: (c.scope && c.scope.in) || [], out: (c.scope && c.scope.out) || [] },
    rules: c.rules || [],
    guards: {
      protectedPaths: (c.guards && c.guards.protectedPaths) || DEFAULT_GUARDS.protectedPaths,
      forbiddenCommands: (c.guards && c.guards.forbiddenCommands) || DEFAULT_GUARDS.forbiddenCommands,
    },
    limits: {
      budgetUsd: Math.max(0, num(c.limits && c.limits.budgetUsd, 0)),
      maxAutoTurns: Math.max(0, num(c.limits && c.limits.maxAutoTurns, 8)),
      maxParallelAgents: Math.max(1, num(c.limits && c.limits.maxParallelAgents, 3)),
    },
    definitionOfDone: c.definitionOfDone || [],
  };
}

/**
 * input: { name, path, description, team: [{ roleId, count, configPath }], contract: {...} }
 */
function create(input) {
  if (!input.name) throw Object.assign(new Error('El proyecto necesita un nombre'), { status: 400 });
  const dir = path.resolve(input.path || path.join(require('os').homedir(), 'Desktop', slug(input.name)));
  fs.mkdirSync(path.join(dir, '.bridge'), { recursive: true });
  const p = { id: uid('p'), name: input.name, slug: slug(input.name), path: dir, description: input.description || '', createdAt: Date.now(), roomId: null };
  const contract = normalizeContract(input.contract, p);

  const members = [];
  for (const t of input.team || []) {
    const role = store.roles.get().find((r) => r.id === t.roleId);
    if (!role) continue;
    const n = Math.max(1, Math.min(6, Number(t.count) || 1));
    for (let i = 1; i <= n; i++) members.push({ kind: 'agent', roleId: role.id, name: n > 1 ? role.name + ' ' + i : role.name, configPath: t.configPath || null, cwd: dir });
  }
  const room = rooms.create({ name: p.name, topic: 'Equipo del proyecto · ' + dir, mode: 'lead', maxAutoTurns: contract.limits.maxAutoTurns, budgetUsd: contract.limits.budgetUsd, projectId: p.id, members });
  p.roomId = room.id;
  const raw = rooms.raw(room.id);
  const lead = raw.meta.members.find((m) => m.roleId === 'supervisor') || raw.meta.members.find((m) => m.kind === 'agent');
  if (lead) rooms.update(room.id, { leadId: lead.id });

  contract.team = raw.meta.members.filter((m) => m.kind === 'agent').map((m) => ({ role: m.roleId, name: m.name, handle: m.handle, account: m.configDir }));
  // Never replace what already lives in the folder (a contract from /modo-todo, the repo's own
  // subagents): Bridge only fills in what is missing.
  if (!fs.existsSync(contractFile(p))) writeJson(contractFile(p), contract);
  const contractPath = path.join(dir, 'CONTRATO.md');
  if (!fs.existsSync(contractPath)) fs.writeFileSync(contractPath, contractMarkdown(p, contract, raw));
  const todoPath = path.join(dir, 'todo.md');
  if (!fs.existsSync(todoPath)) fs.writeFileSync(todoPath, initialTodo(p, lead ? lead.handle : 'supervisor'));
  const agentsDir = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const m of raw.meta.members.filter((x) => x.kind === 'agent')) {
    const role = store.roles.get().find((r) => r.id === m.roleId) || {};
    const file = path.join(agentsDir, m.handle + '.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, subagentFile(m, role));
  }

  store.projects.update((list) => list.concat([p]));
  return detail(p.id);
}

// Register an existing folder (for example one where /modo-todo already ran).
function importFolder(dir, name) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('La carpeta no existe'), { status: 400 });
  const existing = store.projects.get().find((p) => p.path.toLowerCase() === abs.toLowerCase());
  if (existing) return detail(existing.id);
  const p = { id: uid('p'), name: name || path.basename(abs), slug: slug(name || path.basename(abs)), path: abs, description: '', createdAt: Date.now(), roomId: null };
  const room = rooms.create({ name: p.name, topic: 'Equipo del proyecto · ' + abs, mode: 'lead', projectId: p.id, members: [] });
  p.roomId = room.id;
  store.projects.update((list) => list.concat([p]));
  return detail(p.id);
}

function find(id) { return store.projects.get().find((p) => p.id === id) || null; }

function boardOf(p) { return parseBoard(path.join(p.path, 'todo.md')); }

function summaryOf(p) {
  const board = boardOf(p);
  return Object.assign({}, p, { totals: board ? board.totals : null, hasContract: fs.existsSync(path.join(p.path, 'CONTRATO.md')) });
}

function list() { return store.projects.get().map(summaryOf); }

function detail(id) {
  const p = find(id);
  if (!p) return null;
  let contractMd = null;
  try { contractMd = fs.readFileSync(path.join(p.path, 'CONTRATO.md'), 'utf8'); } catch (e) {}
  return Object.assign(summaryOf(p), { board: boardOf(p), contractMd, contract: readJson(contractFile(p)) });
}

function saveContract(id, patch) {
  const p = find(id);
  if (!p) return null;
  const current = readJson(contractFile(p)) || normalizeContract({}, p);
  const next = Object.assign({}, current, normalizeContract(Object.assign({}, current, patch), p), { team: current.team });
  writeJson(contractFile(p), next);
  const mdPath = path.join(p.path, 'CONTRATO.md');
  try {
    const md = fs.readFileSync(mdPath, 'utf8');
    const re = /<!-- bridge:guards[\s\S]*?<!-- \/bridge:guards -->/;
    if (re.test(md)) fs.writeFileSync(mdPath, md.replace(re, guardsBlock(next)));
  } catch (e) {}
  if (p.roomId) rooms.update(p.roomId, { maxAutoTurns: next.limits.maxAutoTurns, budgetUsd: next.limits.budgetUsd });
  return detail(id);
}

function remove(id) {
  store.projects.update((list) => list.filter((p) => p.id !== id));
  return true;
}

// Ask the room's lead to plan the work in todo.md, following the modo-todo skill.
function plan(id, objective) {
  const p = find(id);
  if (!p || !p.roomId) throw Object.assign(new Error('El proyecto no tiene sala'), { status: 400 });
  const room = rooms.raw(p.roomId);
  const lead = room && room.meta.members.find((m) => m.id === room.meta.leadId);
  if (!lead) throw Object.assign(new Error('Agrega al menos un agente al equipo para planificar'), { status: 400 });
  const text = [
    '@' + lead.handle + ' Activa el **modo todo.md** para este proyecto.',
    objective ? 'Objetivo: ' + objective : null,
    'Sigue la skill `' + SKILL_FILE + '`: lee CONTRATO.md, completa lo que falte del contrato y convierte el objetivo en tareas T01…Tn dentro de todo.md, con owner (`@handle` del equipo), descripción y criterios de aceptación verificables. `.bridge/contract.json` ya existe y lo administra Bridge (está protegido): si crees que una guarda o un límite debe cambiar, propónlo aquí. Cuando el tablero esté listo, resume el plan aquí y menciona a quien empieza.',
  ].filter(Boolean).join('\n\n');
  return rooms.postAsHuman(p.roomId, text, []);
}

// Board signatures for the live-refresh loop.
function boardSignatures() {
  return store.projects.get().map((p) => ({ id: p.id, sig: statSig(path.join(p.path, 'todo.md')) + '|' + statSig(path.join(p.path, 'CONTRATO.md')) }));
}

module.exports = { create, importFolder, list, detail, saveContract, remove, plan, parseBoard, boardSignatures, DEFAULT_GUARDS };
