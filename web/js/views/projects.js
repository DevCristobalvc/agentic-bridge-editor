// Projects: folder + work contract + live task board (todo.md) + team room.
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { api, useStore, loadProject, getState } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Markdown, Modal, Field, Seg, Bar, Avatar, TagInput, Switch,
  openModal, closeModal, toast, attempt, useMenu, confirmDialog, shortPath, money,
} from '../ui.js';
import { navigate } from '../router.js';
import { FolderPicker, AccountSelect, TeamPicker, newSession } from '../dialogs.js';

const DEFAULT_GUARDS = {
  protectedPaths: ['.env', '.env.*', '**/*.pem', '**/*.key', '.git/**', '.bridge/contract.json'],
  forbiddenCommands: ['rm -rf /', 'git push --force', 'git push -f', 'git reset --hard', 'Remove-Item -Recurse -Force C:\\', 'format ', 'shutdown'],
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
function Board({ p }) {
  const board = p.board;
  if (!board || !board.tasks.length) {
    return html`<${Empty} icon="kanban" title="El tablero está vacío" action=${html`<${Btn} kind="primary" icon="wand" onClick=${() => planDialog(p)}>Activar modo todo.md<//>`}>
      El tablero se lee en vivo desde <span class="mono">todo.md</span>. Activa el modo todo.md y el coordinador lo llena.<//>`;
  }
  const todoPath = board.file;
  return html`<div class="kanban">${COLS.map((c) => {
    const tasks = board.tasks.filter((t) => t.status === c.key);
    return html`<div class="k-col">
      <div class="k-head"><span class=${'dot ' + c.dot}></span>${c.label}<span class="n">${tasks.length}</span></div>
      <div class="k-body">${tasks.map((t) => html`<div class="task">
        <div class="row"><span class="id">${t.id}</span><span class="grow"></span>${t.owner ? html`<span class="chip">${t.owner}</span>` : null}</div>
        <div class="tt">${t.title || '(sin título)'}</div>
        ${t.description ? html`<div class="ds">${t.description}</div>` : null}
        ${t.checks ? html`<div class="ft"><${Bar} value=${(100 * t.checked) / t.checks} tone="ok" width="60px" />${t.checked}/${t.checks} criterios</div>` : null}
      </div>`)}${!tasks.length ? html`<div class="dim" style="font-size:12px;padding:6px">—</div>` : null}</div>
    </div>`;
  })}</div>
  <div class="row" style="margin-top:10px"><span class="dim" style="font-size:12px">Fuente: <a href=${'#/files?path=' + encodeURIComponent(todoPath)}>${shortPath(todoPath)}</a> · se actualiza solo</span></div>`;
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
      <div class="row"><${Avatar} emoji=${m.emoji} color=${m.color} /><div class="grow"><h3>${m.name}</h3><div class="muted mono" style="font-size:12px">@${m.handle}</div></div>${room.leadId === m.id ? html`<span class="chip warn"><${Icon} name="crown" />coordina</span>` : null}</div>
      <p>${role.description || ''}</p>
      <div class="row wrap"><span class="chip mono">${m.configDir || 'cuenta por defecto'}</span><span class="chip">${m.model || 'modelo por defecto'}</span><span class="chip">${m.permissionMode}</span></div>
    </div>`;
  })}${!agents.length ? html`<${Empty} icon="bot" title="Sin agentes">Agrégalos desde la sala del proyecto.<//>` : null}</div>`;
}

function ProjectDetail({ id }) {
  const p = useStore((s) => s.projectDetails[id]);
  const [tab, setTab] = useState('board');
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
        <${Btn} icon="folder-open" onClick=${() => navigate('/files?path=' + encodeURIComponent(p.path))}>Archivos<//>
        <${IconBtn} icon="more" title="Más" onClick=${(e) => openMenu(e, [
          { label: 'Sesión de Claude aquí', icon: 'sparkles', run: () => newSession({ cwd: p.path, name: slugify(p.name) }) },
          { label: 'Abrir en VS Code', icon: 'code', run: () => attempt(() => api.post('/api/fs/open', { path: p.path, app: 'vscode' })) },
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
      ${[['board', 'Tablero', 'kanban', t.all], ['contract', 'Contrato', 'scroll'], ['guards', 'Guardas y límites', 'shield'], ['team', 'Equipo', 'team']].map(([k, label, icon, n]) => html`<button type="button" class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}><${Icon} name=${icon} />${label}${n != null ? html`<span class="n">${n}</span>` : null}</button>`)}
    </div>
    ${tab === 'board' ? html`<${Board} p=${p} />` : null}
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
  if (route.param) return html`<${ProjectDetail} id=${route.param} />`;
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
          <div class="stack-avatars">${agents.slice(0, 6).map((m) => html`<${Avatar} size="sm" emoji=${m.emoji} color=${m.color} />`)}</div>
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
