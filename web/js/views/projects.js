// Projects: folder + work contract + live task board (todo.md) + team room.
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { Whiteboard } from '../whiteboard.js';
import { terminalMenu } from './terminals.js';
import { api, useStore, loadProject, getState } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Markdown, Modal, Field, Seg, Bar, Avatar, TagInput, Switch, memberIcon, Drawer,
  openModal, closeModal, toast, attempt, useMenu, confirmDialog, shortPath, money, ago, useNow,
} from '../ui.js';
import { navigate } from '../router.js';
import { FolderPicker, AccountSelect, TeamPicker, newSession } from '../dialogs.js';

// Same defaults as server/projects.js. /…/ entries are anchored regexes so ordinary commands
// (git log --format, grep shutdown, rm -rf build) stay allowed.
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
const DEFAULT_RULES = [
  'Cambios pequeños y verificables; nada de reescrituras sin acuerdo en la sala',
  'Pruebas antes de marcar una tarea como done',
  'No tocar código fuera de tu tarea sin avisar en la sala',
  'Toda decisión de arquitectura queda como ADR en docs/adr/',
];
const DEFAULT_DOD = ['Criterios de aceptación verificados', 'Pruebas en verde', 'todo.md actualizado', 'Resumen publicado en la sala del equipo'];
const COLS = [
  { key: 'todo', label: 'Por hacer', dot: 'off' },
  { key: 'doing', label: 'En curso', dot: 'busy' },
  { key: 'blocked', label: 'Bloqueadas', dot: 'bad' },
  { key: 'done', label: 'Hechas', dot: 'idle' },
];

export function newProject() { openModal(() => html`<${ProjectWizard} />`); }

function slugify(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function ProjectWizard() {
  const me = useStore((s) => s.me);
  const accounts = useStore((s) => s.accounts);
  const firstAccount = (accounts.find((a) => a.email) || accounts[0] || {}).configDir || '';
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [path, setPath] = useState('');
  const [objective, setObjective] = useState('');
  const [configDir, setConfigDir] = useState(firstAccount);
  const [team, setTeam] = useState([
    { roleId: 'supervisor', count: 1, configDir: firstAccount },
    { roleId: 'arquitecto', count: 1, configDir: firstAccount },
    { roleId: 'desarrollador', count: 2, configDir: firstAccount },
    { roleId: 'qa', count: 1, configDir: firstAccount },
  ]);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [scopeIn, setScopeIn] = useState([]);
  const [scopeOut, setScopeOut] = useState([]);
  const [protectedPaths, setProtectedPaths] = useState(DEFAULT_GUARDS.protectedPaths);
  const [forbidden, setForbidden] = useState(DEFAULT_GUARDS.forbiddenCommands);
  const [budgetUsd, setBudgetUsd] = useState(25);
  const [maxAutoTurns, setMaxAutoTurns] = useState(8);
  const [maxParallel, setMaxParallel] = useState(3);
  const [dod, setDod] = useState(DEFAULT_DOD);
  const [planNow, setPlanNow] = useState(true);
  const [busy, setBusy] = useState(false);

  const desktop = me ? me.home.replace(/[\\/]+$/, '') + '\\Desktop\\' : '';
  const effectivePath = pathTouched ? path : desktop + (slugify(name) || 'proyecto');
  const agents = team.reduce((a, t) => a + t.count, 0);

  const next = () => {
    if (step === 0 && !name.trim()) { toast('El proyecto necesita un nombre', 'bad'); return; }
    if (step === 1 && !agents) { toast('Elige al menos un agente', 'bad'); return; }
    setStep(step + 1);
  };
  const create = async () => {
    setBusy(true);
    const p = await attempt(() => api.post('/api/projects', {
      name: name.trim(), path: effectivePath, description: objective,
      team: team.map((t) => Object.assign({}, t, { configDir: t.configDir || configDir })),
      contract: {
        objective, scope: { in: scopeIn, out: scopeOut }, rules,
        guards: { protectedPaths, forbiddenCommands: forbidden },
        limits: { budgetUsd, maxAutoTurns, maxParallelAgents: maxParallel },
        definitionOfDone: dod,
      },
    }));
    if (p && planNow) await attempt(() => api.post('/api/projects/' + p.id + '/plan', { objective }));
    setBusy(false);
    if (!p) return;
    closeModal();
    toast(planNow ? 'Proyecto creado: el Supervisor ya está armando el tablero' : 'Proyecto creado');
    navigate('/projects/' + p.id);
  };

  const titles = ['El proyecto', 'El equipo', 'El contrato'];
  const subtitles = [
    'Dónde vive y qué se quiere lograr.',
    'Agentes con rol que trabajarán en la sala del proyecto. Cada uno es una sesión de Claude con memoria.',
    'Reglas, guardas y límites. Quedan en CONTRATO.md y el hook de guardas los hace cumplir.',
  ];
  return html`<${Modal} wide title=${'Nuevo proyecto · ' + titles[step]} subtitle=${subtitles[step]} steps=${3} step=${step}
    footer=${html`<span class="left">Paso ${step + 1} de 3${step === 1 ? ' · ' + agents + ' agentes' : ''}</span>
      ${step ? html`<${Btn} kind="ghost" icon="arrow-left" onClick=${() => setStep(step - 1)}>Atrás<//>` : html`<${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//>`}
      ${step < 2 ? html`<${Btn} kind="primary" onClick=${next}>Siguiente<//>` : html`<${Btn} kind="primary" icon="scroll" busy=${busy} onClick=${create}>Crear proyecto<//>`}`}>
    ${step === 0 ? html`
      <${Field} label="Nombre"><input class="input" autofocus value=${name} placeholder="p. ej. Portal de clientes" onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="Carpeta" hint="Si no existe, se crea. Si ya tiene código, el equipo trabaja sobre él.">
        <${FolderPicker} value=${effectivePath} onChange=${(v) => { setPathTouched(true); setPath(v); }} />
      <//>
      <${Field} label="Objetivo" hint="Una o dos frases medibles. El Supervisor lo convierte en tareas.">
        <textarea class="textarea" rows="4" value=${objective} placeholder="p. ej. Un portal donde los clientes ven sus facturas y descargan PDFs, con login por correo." onInput=${(e) => setObjective(e.target.value)}></textarea>
      <//>` : null}
    ${step === 1 ? html`
      <${TeamPicker} team=${team} setTeam=${setTeam} configDir=${configDir} />
      <${Field} label="Cuenta del equipo" hint="Puedes repartir agentes entre cuentas para distribuir el uso de cada suscripción.">
        <${AccountSelect} value=${configDir} onChange=${(v) => { setConfigDir(v); setTeam(team.map((t) => Object.assign({}, t, { configDir: v }))); }} />
      <//>` : null}
    ${step === 2 ? html`
      <div class="grid-2">
        <${Field} label="Incluye"><${TagInput} values=${scopeIn} onChange=${setScopeIn} placeholder="Enter para agregar" /><//>
        <${Field} label="No incluye"><${TagInput} values=${scopeOut} onChange=${setScopeOut} placeholder="Enter para agregar" /><//>
      </div>
      <${Field} label="Reglas de trabajo"><${TagInput} values=${rules} onChange=${setRules} placeholder="Nueva regla" /><//>
      <div class="grid-2">
        <${Field} label="Rutas protegidas" hint="Globs relativos al proyecto. Nadie las edita."><${TagInput} values=${protectedPaths} onChange=${setProtectedPaths} placeholder="p. ej. infra/**" /><//>
        <${Field} label="Comandos prohibidos" hint="Fragmento de texto o /regex/."><${TagInput} values=${forbidden} onChange=${setForbidden} placeholder="p. ej. npm publish" /><//>
      </div>
      <div class="grid-3">
        <${Field} label="Presupuesto US$" hint="0 = sin tope"><input class="input" type="number" min="0" step="1" value=${budgetUsd} onInput=${(e) => setBudgetUsd(Number(e.target.value))} /><//>
        <${Field} label="Turnos automáticos" hint="Entre agentes, por mensaje tuyo"><input class="input" type="number" min="0" max="50" value=${maxAutoTurns} onInput=${(e) => setMaxAutoTurns(Number(e.target.value))} /><//>
        <${Field} label="Agentes en paralelo"><input class="input" type="number" min="1" max="10" value=${maxParallel} onInput=${(e) => setMaxParallel(Number(e.target.value))} /><//>
      </div>
      <${Field} label="Definición de hecho"><${TagInput} values=${dod} onChange=${setDod} placeholder="Nuevo criterio" /><//>
      <div class="callout"><${Icon} name="wand" /><div class="grow"><h4>Modo todo.md</h4><p>Al crear el proyecto, el Supervisor lee el contrato y convierte el objetivo en tareas dentro de todo.md, con dueño y criterios. No tienes que crear tareas una por una.</p></div>
        <div class="actions"><${Switch} checked=${planNow} onChange=${setPlanNow} label="Planificar ahora" /></div></div>
    ` : null}
  <//>`;
}

function importProject() { openModal(() => html`<${ImportDialog} />`); }

function ImportDialog() {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const go = async () => {
    const p = await attempt(() => api.post('/api/projects/import', { path, name: name.trim() || undefined }), 'Proyecto importado');
    if (p) { closeModal(); navigate('/projects/' + p.id); }
  };
  return html`<${Modal} title="Importar una carpeta" subtitle="Por ejemplo, una donde ya corriste /modo-todo desde una terminal. Bridge lee su CONTRATO.md y su todo.md."
    footer=${html`<span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="download" onClick=${go}>Importar<//>`}>
    <${Field} label="Carpeta"><${FolderPicker} value=${path} onChange=${setPath} /><//>
    <${Field} label="Nombre (opcional)"><input class="input" value=${name} placeholder="Se usa el nombre de la carpeta" onInput=${(e) => setName(e.target.value)} /><//>
  <//>`;
}

function planDialog(p) { openModal(() => html`<${PlanDialog} p=${p} />`); }

function PlanDialog({ p }) {
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await attempt(() => api.post('/api/projects/' + p.id + '/plan', { objective }), 'Modo todo.md activado');
    setBusy(false);
    if (ok) { closeModal(); navigate('/rooms/' + p.roomId); }
  };
  return html`<${Modal} title="Activar modo todo.md" subtitle="El coordinador del equipo lee CONTRATO.md, completa lo que falte y escribe el plan completo en todo.md."
    footer=${html`<span class="left">Lo verás trabajar en la sala del proyecto.</span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="wand" busy=${busy} onClick=${go}>Planificar<//>`}>
    <${Field} label="Objetivo o ajuste (opcional)" hint="Déjalo vacío para usar el objetivo del contrato.">
      <textarea class="textarea" rows="4" autofocus value=${objective} placeholder="p. ej. Ahora agrega exportación a Excel y pruebas end-to-end." onInput=${(e) => setObjective(e.target.value)}></textarea>
    <//>
  <//>`;
}

// ---------- detail ----------
const setStatus = (p, taskId, status) => attempt(() => api.patch('/api/projects/' + p.id + '/tasks/' + encodeURIComponent(taskId), { status }).then(() => loadProject(p.id)));

function workOn(p, t, agent) {
  newSession({
    cwd: p.path, name: slugify(t.id + '-' + (t.title || 'tarea')).slice(0, 40), agent,
    prompt: 'Trabaja en la tarea ' + t.id + ' de todo.md («' + (t.title || '') + '»). Lee CONTRATO.md y el bloque de la tarea, cumple sus criterios de aceptación y actualiza su **Status:** en todo.md (in-progress al empezar, done al terminar).',
  });
}

function TaskDrawer({ p, taskId }) {
  const live = useStore((s) => s.projectDetails[p.id]);
  const t = ((live || p).board || { tasks: [] }).tasks.find((x) => x.id === taskId);
  const [text, setText] = useState(null);
  const [owner, setOwner] = useState(t ? t.owner : '');
  useEffect(() => { api.get('/api/projects/' + p.id + '/tasks/' + encodeURIComponent(taskId)).then((r) => setText(r.text)).catch(() => setText('')); }, [taskId, t && t.status, t && t.owner]);
  if (!t) return html`<${Drawer}><div class="drawer-body"><${Empty} icon="kanban" title="La tarea ya no está en todo.md" /></div><//>`;
  const room = getState().rooms.find((r) => r.id === p.roomId);
  const ask = async () => {
    const handle = String(t.owner || '').replace(/^@/, '');
    const r = await attempt(() => api.post('/api/rooms/' + p.roomId + '/messages', { text: (handle ? '@' + handle + ' ' : '') + 'Por favor avanza con la tarea **' + t.id + '. ' + t.title + '** de todo.md y cuéntanos aquí cuando esté lista.' }), 'Pedido enviado a la sala');
    if (r) { closeModal(); navigate('/rooms/' + p.roomId); }
  };
  return html`<${Drawer}>
    <div class="drawer-head">
      <div class="grow" style="min-width:0"><div class="mono accent" style="font-size:12px">${t.id}</div><h3 style="margin:2px 0 0;font:650 17px var(--font-display)">${t.title || '(sin título)'}</h3></div>
      <${IconBtn} icon="x" title="Cerrar" onClick=${closeModal} />
    </div>
    <div class="drawer-body col" style="gap:16px">
      <${Field} label="Estado (se escribe en todo.md)">
        <${Seg} value=${t.status} onChange=${(v) => setStatus(p, t.id, v)} options=${COLS.map((c) => ({ value: c.key, label: c.label }))} />
      <//>
      <${Field} label="Responsable">
        <div class="row"><input class="input" value=${owner} placeholder="@handle" onInput=${(e) => setOwner(e.target.value)} />
          <${Btn} onClick=${() => attempt(() => api.patch('/api/projects/' + p.id + '/tasks/' + encodeURIComponent(t.id), { owner }).then(() => loadProject(p.id)), 'Responsable actualizado')}>Guardar<//></div>
        ${room ? html`<div class="row wrap" style="gap:6px;margin-top:4px">${room.members.filter((m) => m.kind === 'agent').map((m) => html`<button type="button" class="chip" style="cursor:pointer" onClick=${() => setOwner('@' + m.handle)}>@${m.handle}</button>`)}</div>` : null}
      <//>
      <div class="row wrap">
        <${Btn} kind="primary" icon="sparkles" onClick=${() => { closeModal(); workOn(p, t, 'claude'); }}>Trabajar en esta tarea<//>
        ${getState().antigravity && getState().antigravity.installed ? html`<${Btn} icon="orbit" onClick=${() => { closeModal(); workOn(p, t, 'agy'); }}>Con Antigravity<//>` : null}
        ${p.roomId ? html`<${Btn} icon="rooms" onClick=${ask}>Pedirlo en la sala<//>` : null}
      </div>
      <div class="card pad task-doc">${text == null ? html`<span class="spinner"></span>` : html`<${Markdown} text=${text.replace(/^##\s+/, '### ')} />`}</div>
      <div class="dim" style="font-size:12px">Fuente: <a href=${'#/files?path=' + encodeURIComponent(p.board.file)} onClick=${closeModal}>${shortPath(p.board.file)}</a></div>
    </div>
  <//>`;
}

function openTask(p, taskId) { openModal(() => html`<${TaskDrawer} p=${p} taskId=${taskId} />`); }

function AddTask({ p, status }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const save = async () => {
    if (!title.trim()) { setOpen(false); return; }
    const r = await attempt(() => api.post('/api/projects/' + p.id + '/tasks', { title: title.trim(), status }).then((x) => loadProject(p.id).then(() => x)));
    if (r) { toast('Tarea ' + r.taskId + ' agregada a todo.md'); setTitle(''); setOpen(false); }
  };
  if (!open) return html`<button type="button" class="k-add" onClick=${() => setOpen(true)}><${Icon} name="plus" />Agregar tarea</button>`;
  return html`<div class="k-new">
    <textarea class="textarea" rows="2" autofocus value=${title} placeholder="Título de la tarea" onInput=${(e) => setTitle(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } else if (e.key === 'Escape') setOpen(false); }}></textarea>
    <div class="row"><${Btn} size="sm" kind="primary" onClick=${save}>Agregar<//><${Btn} size="sm" kind="ghost" onClick=${() => setOpen(false)}>Cancelar<//></div>
  </div>`;
}

function Tasks({ p }) {
  const board = p.board;
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  if (!board || !board.tasks.length) {
    return html`<${Empty} icon="kanban" title="El tablero está vacío" action=${html`<div class="row"><${Btn} kind="primary" icon="wand" onClick=${() => planDialog(p)}>Activar modo todo.md<//><${AddTask} p=${p} status="todo" /></div>`}>
      El tablero se lee en vivo desde <span class="mono">todo.md</span>. Activa el modo todo.md y el coordinador lo llena, o agrega tareas tú.<//>`;
  }
  const drop = (status) => {
    setOver(null);
    if (drag && drag.status !== status) setStatus(p, drag.id, status);
    setDrag(null);
  };
  return html`<div class="kanban">${COLS.map((c) => {
    const tasks = board.tasks.filter((t) => t.status === c.key);
    return html`<div class=${'k-col' + (over === c.key ? ' drop' : '')}
        onDragOver=${(e) => { if (drag) { e.preventDefault(); setOver(c.key); } }} onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }} onDrop=${(e) => { e.preventDefault(); drop(c.key); }}>
      <div class="k-head"><span class=${'dot ' + c.dot}></span>${c.label}<span class="n">${tasks.length}</span></div>
      <div class="k-body">${tasks.map((t) => html`<div class=${'task' + (drag && drag.id === t.id ? ' dragging' : '')} draggable="true"
          onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); setDrag(t); }} onDragEnd=${() => { setDrag(null); setOver(null); }}
          onClick=${() => openTask(p, t.id)}>
        <div class="row"><span class="id">${t.id}</span><span class="grow"></span>${t.owner ? html`<span class="chip">${t.owner}</span>` : null}</div>
        <div class="tt">${t.title || '(sin título)'}</div>
        ${t.description ? html`<div class="ds">${t.description}</div>` : null}
        ${t.checks ? html`<div class="ft"><${Bar} value=${(100 * t.checked) / t.checks} tone="ok" width="60px" />${t.checked}/${t.checks} criterios</div>` : null}
      </div>`)}
      ${c.key === 'todo' ? html`<${AddTask} p=${p} status="todo" />` : !tasks.length ? html`<div class="dim" style="font-size:12px;padding:6px">Arrastra tarjetas aquí</div>` : null}</div>
    </div>`;
  })}</div>
  <div class="row" style="margin-top:10px"><span class="dim" style="font-size:12px">Fuente: <a href=${'#/files?path=' + encodeURIComponent(board.file)}>${shortPath(board.file)}</a> · arrastra para cambiar el estado · clic para ver el detalle</span></div>`;
}

function Conversations({ p }) {
  const [list, setList] = useState(null);
  const now = useNow(60000);
  useEffect(() => { api.get('/api/history?all=1&cwd=' + encodeURIComponent(p.path)).then((d) => setList(d.conversations)).catch(() => setList([])); }, [p.id]);
  if (!list) return html`<div class="row muted"><span class="spinner"></span>Buscando conversaciones en esta carpeta…</div>`;
  if (!list.length) return html`<${Empty} icon="history" title="Sin conversaciones todavía">Las sesiones de Claude o Antigravity que trabajen en <span class="mono">${shortPath(p.path)}</span> aparecerán aquí.<//>`;
  const cost = list.reduce((a, c) => a + (c.cost || 0), 0);
  return html`<div class="col" style="gap:12px">
    <div class="muted" style="font-size:12.5px">${list.length} conversaciones · ${money(cost)} equivalente API en total</div>
    <div class="card">${list.map((c) => html`<div class="list-row" onClick=${() => navigate('/history/' + encodeURIComponent(c.id))}>
      <${Icon} name=${c.source === 'antigravity' ? 'orbit' : 'sparkles'} />
      <div class="grow"><div class="t ellipsis">${c.title}</div><div class="s ellipsis">${c.source === 'antigravity' ? 'Antigravity' : c.account} · ${c.prompts != null ? c.prompts + ' mensajes · ' : ''}${c.cost ? money(c.cost) + ' · ' : ''}${shortPath(c.cwd)}</div></div>
      <span class="dim" style="font-size:12px">${ago(c.lastAt, now)}</span>
    </div>`)}</div>
  </div>`;
}

function GuardsForm({ p }) {
  const c = p.contract || { guards: DEFAULT_GUARDS, limits: { budgetUsd: 0, maxAutoTurns: 8, maxParallelAgents: 3 }, rules: [], definitionOfDone: [] };
  const [protectedPaths, setProtectedPaths] = useState(c.guards.protectedPaths || []);
  const [forbidden, setForbidden] = useState(c.guards.forbiddenCommands || []);
  const [rules, setRules] = useState(c.rules || []);
  const [budgetUsd, setBudgetUsd] = useState(c.limits.budgetUsd || 0);
  const [maxAutoTurns, setMaxAutoTurns] = useState(c.limits.maxAutoTurns || 8);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await attempt(() => api.put('/api/projects/' + p.id + '/contract', {
      rules, guards: { protectedPaths, forbiddenCommands: forbidden }, limits: Object.assign({}, c.limits, { budgetUsd, maxAutoTurns }),
    }).then(() => loadProject(p.id)), 'Contrato actualizado: guardas activas al instante');
    setBusy(false);
  };
  return html`<div class="col" style="gap:14px;max-width:880px">
    <div class="callout"><${Icon} name="shield" /><div class="grow"><h4>Guardas que se cumplen, no solo se escriben</h4><p>El hook <span class="mono">guard.js</span> lee <span class="mono">.bridge/contract.json</span> antes de cada edición o comando de cualquier sesión conectada, en cualquier cuenta, y bloquea lo que el contrato prohíbe.</p></div></div>
    <div class="grid-2">
      <${Field} label="Rutas protegidas"><${TagInput} values=${protectedPaths} onChange=${setProtectedPaths} placeholder="glob, p. ej. infra/**" /><//>
      <${Field} label="Comandos prohibidos"><${TagInput} values=${forbidden} onChange=${setForbidden} placeholder="texto o /regex/" /><//>
    </div>
    <${Field} label="Reglas de trabajo"><${TagInput} values=${rules} onChange=${setRules} placeholder="Nueva regla" /><//>
    <div class="grid-2">
      <${Field} label="Presupuesto de la sala (US$)" hint="0 = sin tope"><input class="input" type="number" min="0" value=${budgetUsd} onInput=${(e) => setBudgetUsd(Number(e.target.value))} /><//>
      <${Field} label="Turnos automáticos entre agentes"><input class="input" type="number" min="0" max="50" value=${maxAutoTurns} onInput=${(e) => setMaxAutoTurns(Number(e.target.value))} /><//>
    </div>
    <div><${Btn} kind="primary" icon="check" busy=${busy} onClick=${save}>Guardar contrato<//></div>
  </div>`;
}

function TeamTab({ p }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === p.roomId));
  if (!room) return html`<div class="muted">Este proyecto no tiene sala.</div>`;
  const agents = room.members.filter((m) => m.kind === 'agent');
  return html`<div class="cards">${agents.map((m) => {
    const role = getState().roles.find((r) => r.id === m.roleId) || {};
    return html`<div class="card role-card" style=${{ '--role': m.color }}>
      <div class="row"><${Avatar} icon=${memberIcon(m)} color=${m.color} /><div class="grow"><h3>${m.name}</h3><div class="muted mono" style="font-size:12px">@${m.handle}</div></div>${room.leadId === m.id ? html`<span class="chip accent"><${Icon} name="crown" />coordina</span>` : null}</div>
      <p>${role.description || ''}</p>
      <div class="row wrap"><span class="chip mono">${m.configDir || 'cuenta por defecto'}</span><span class="chip">${m.model || 'modelo por defecto'}</span><span class="chip">${m.permissionMode}</span></div>
    </div>`;
  })}${!agents.length ? html`<${Empty} icon="bot" title="Sin agentes">Agrégalos desde la sala del proyecto.<//>` : null}</div>`;
}

function ProjectDetail({ id, tab: tabParam }) {
  const p = useStore((s) => s.projectDetails[id]);
  const [lastTab, setLastTab] = useState('board');
  const tab = tabParam || lastTab;
  const setTab = (t) => { setLastTab(t); navigate('/projects/' + id + '?tab=' + t); };
  const [full, setFull] = useState(false);
  const [openMenu, menu] = useMenu();
  useEffect(() => { loadProject(id).catch((e) => toast(e.message, 'bad')); }, [id]);
  if (!p) return html`<div class="page row muted"><span class="spinner"></span> Cargando proyecto…</div>`;
  const t = p.totals || { all: 0, done: 0, doing: 0, blocked: 0 };
  const pct = t.all ? Math.round((100 * t.done) / t.all) : 0;

  return html`<div class="page">
    <div class="page-head">
      <div class="grow">
        <a href="#/projects" class="muted" style="font-size:12.5px">← Proyectos</a>
        <h2 style="margin-top:4px">${p.name}</h2>
        <p class="mono" style="font-size:12.5px">${p.path}</p>
      </div>
      <div class="actions">
        <${Btn} kind="primary" icon="wand" onClick=${() => planDialog(p)}>Modo todo.md<//>
        ${p.roomId ? html`<${Btn} icon="rooms" onClick=${() => navigate('/rooms/' + p.roomId)}>Sala del equipo<//>` : null}
        <${Btn} icon="terminal" onClick=${(e) => openMenu(e, terminalMenu(p.path))}>Abrir aquí<//>
        <${Btn} icon="folder-open" onClick=${() => navigate('/files?path=' + encodeURIComponent(p.path))}>Archivos<//>
        <${IconBtn} icon="more" title="Más" onClick=${(e) => openMenu(e, [
          { label: 'Abrir en VS Code', icon: 'code', run: () => attempt(() => api.post('/api/fs/open', { path: p.path, app: 'vscode' })) },
          { label: 'Agregar a carpetas favoritas', icon: 'star', run: () => attempt(() => api.patch('/api/prefs', { favorites: (getState().prefs.favorites || []).filter((x) => x.path !== p.path).concat([{ path: p.path, label: p.name }]) }), 'Agregada a favoritas') },
          '-',
          { label: 'Quitar de Bridge', icon: 'trash', danger: true, run: async () => { if (await confirmDialog({ title: 'Quitar ' + p.name, text: 'Solo se quita de la lista de Bridge. La carpeta, el contrato y la sala no se borran.', confirm: 'Quitar', danger: true })) { await attempt(() => api.del('/api/projects/' + p.id)); navigate('/projects'); } } },
        ])} />
      </div>
    </div>
    <div class="kpis" style="margin:0 0 18px">
      <div class="kpi"><div class="k">Avance</div><div class="v">${pct}%</div><div style="margin-top:8px"><${Bar} value=${pct} tone="ok" /></div></div>
      <div class="kpi"><div class="k">Tareas</div><div class="v">${t.all}</div><div class="s">${t.done} hechas · ${t.doing} en curso</div></div>
      <div class="kpi"><div class="k">Bloqueadas</div><div class=${'v' + (t.blocked ? ' bad' : '')}>${t.blocked}</div><div class="s">${t.blocked ? 'requieren atención' : 'ninguna'}</div></div>
      <div class="kpi"><div class="k">Contrato</div><div class="v" style="font-size:18px">${p.hasContract ? 'Activo' : 'Falta'}</div><div class="s">${p.contract ? p.contract.guards.protectedPaths.length + ' rutas · ' + p.contract.guards.forbiddenCommands.length + ' comandos vigilados' : 'sin guardas'}</div></div>
    </div>
    <div class="tabs">
      ${[['board', 'Pizarra', 'board'], ['tasks', 'Tareas', 'kanban', t.all], ['history', 'Conversaciones', 'history'], ['contract', 'Contrato', 'scroll'], ['guards', 'Guardas y límites', 'shield'], ['team', 'Equipo', 'team']].map(([k, label, icon, n]) => html`<button type="button" class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}><${Icon} name=${icon} />${label}${n != null ? html`<span class="n">${n}</span>` : null}</button>`)}
    </div>
    ${tab === 'board' ? html`<div class="col" style="gap:8px">
      <div class="row muted" style="font-size:12.5px"><${Icon} name="info" /><span class="grow">Excalidraw completo. Las columnas y tarjetas vienen de todo.md: arrastra una tarjeta a otra columna y su estado se escribe en el archivo; dibuja, anota y diagrama alrededor con libertad.</span>
        <${Btn} size="sm" icon="maximize" onClick=${() => setFull(true)}>Pantalla completa<//></div>
      <${Whiteboard} key=${'p:' + p.id} boardRef=${'p:' + p.id} project=${p} title=${p.name} fullscreen=${full} onExitFull=${() => setFull(false)} />
      ${full ? html`<button type="button" class="btn sm" style="position:fixed;right:16px;bottom:16px;z-index:46" onClick=${() => setFull(false)}><${Icon} name="minimize" />Salir de pantalla completa</button>` : null}
    </div>` : null}
    ${tab === 'tasks' ? html`<${Tasks} p=${p} />` : null}
    ${tab === 'history' ? html`<${Conversations} p=${p} />` : null}
    ${tab === 'contract' ? (p.contractMd ? html`<div class="card pad" style="max-width:940px"><${Markdown} text=${p.contractMd} /></div>`
      : html`<${Empty} icon="scroll" title="Sin CONTRATO.md" action=${html`<${Btn} kind="primary" icon="wand" onClick=${() => planDialog(p)}>Crear con modo todo.md<//>`}>El coordinador puede escribirlo por ti.<//>`) : null}
    ${tab === 'guards' ? html`<${GuardsForm} key=${p.id} p=${p} />` : null}
    ${tab === 'team' ? html`<${TeamTab} p=${p} />` : null}
    ${menu}
  </div>`;
}

export function Projects({ route }) {
  const projects = useStore((s) => s.projects);
  const rooms = useStore((s) => s.rooms);
  if (route.param) return html`<${ProjectDetail} id=${route.param} tab=${route.query.get('tab')} />`;
  return html`<div class="page">
    <div class="page-head">
      <div><h2>Proyectos</h2><p>Cada proyecto tiene un contrato que se cumple, un tablero vivo en todo.md y una sala con su equipo de agentes.</p></div>
      <div class="actions"><${Btn} icon="download" onClick=${importProject}>Importar carpeta<//><${Btn} kind="primary" icon="plus" onClick=${newProject}>Nuevo proyecto<//></div>
    </div>
    ${projects.length ? html`<div class="cards">${projects.map((p) => {
      const t = p.totals || { all: 0, done: 0, blocked: 0, doing: 0 };
      const room = rooms.find((r) => r.id === p.roomId);
      const agents = room ? room.members.filter((m) => m.kind === 'agent') : [];
      return html`<div class="card hover p-card" onClick=${() => navigate('/projects/' + p.id)}>
        <div class="row"><h3 class="grow ellipsis">${p.name}</h3>${p.hasContract ? html`<span class="chip accent"><${Icon} name="shield" />contrato</span>` : null}</div>
        <div class="path">${shortPath(p.path)}</div>
        <div class="progress-line"><${Bar} value=${t.all ? (100 * t.done) / t.all : 0} tone="ok" /><span>${t.done}/${t.all}</span></div>
        <div class="row">
          <div class="stack-avatars">${agents.slice(0, 6).map((m) => html`<${Avatar} size="sm" icon=${memberIcon(m)} color=${m.color} />`)}</div>
          <span class="grow"></span>
          ${t.blocked ? html`<span class="chip bad">${t.blocked} bloqueadas</span>` : null}
          ${t.doing ? html`<span class="chip ok">${t.doing} en curso</span>` : null}
          ${room && room.spentUsd ? html`<span class="chip mono">${money(room.spentUsd)}</span>` : null}
        </div>
      </div>`;
    })}</div>` : html`<${Empty} icon="scroll" title="Tu primer proyecto con contrato"
        action=${html`<div class="row"><${Btn} kind="primary" icon="plus" onClick=${newProject}>Nuevo proyecto<//><${Btn} icon="download" onClick=${importProject}>Importar carpeta<//></div>`}>
        Define objetivo, equipo y reglas una sola vez. El Supervisor arma el plan en todo.md y el equipo lo ejecuta en su sala, con guardas que se cumplen.<//>`}
  </div>`;
}
