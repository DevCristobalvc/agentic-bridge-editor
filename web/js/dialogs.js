// Dialogs shared by several views: new session, new room, add member, folder picker, settings.
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { api, getState, setState, useStore } from './api.js';
import { Btn, Icon, IconBtn, Modal, Field, Seg, Switch, Avatar, closeModal, openModal, toast, attempt, useLocal, shortPath } from './ui.js';
import { navigate } from './router.js';

const MODELS = [
  { value: '', label: 'Por defecto de la cuenta' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const PERMISSIONS = [
  { value: 'acceptEdits', label: 'Acepta ediciones (recomendado)' },
  { value: 'default', label: 'Pregunta todo (solo lectura en salas)' },
  { value: 'plan', label: 'Solo planifica' },
  { value: 'bypassPermissions', label: 'Sin preguntas (riesgo alto)' },
];
export { MODELS, PERMISSIONS };

export function AccountSelect({ value, onChange }) {
  const accounts = useStore((s) => s.accounts);
  return html`<select class="select" value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${accounts.map((a) => html`<option value=${a.configDir}>${(a.email || 'sin sesión iniciada') + ' · ' + a.configDir}</option>`)}
  </select>`;
}

function useDefaultAccount() {
  const accounts = useStore((s) => s.accounts);
  const [last, setLast] = useLocal('lastAccount', null);
  const valid = accounts.find((a) => a.configDir === last && a.email) || accounts.find((a) => a.email) || accounts[0];
  return [valid ? valid.configDir : '', setLast];
}

// ---------- folder picker ----------
export function FolderPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(null);
  const [error, setError] = useState(null);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const home = useStore((s) => s.me && s.me.home);

  useEffect(() => {
    if (!open) return;
    api.get('/api/fs/list?path=' + encodeURIComponent(value || home || '')).then((d) => { setDir(d); setError(null); })
      .catch(() => api.get('/api/fs/list?path=' + encodeURIComponent(home)).then(setDir));
  }, [open]);

  const go = (p) => api.get('/api/fs/list?path=' + encodeURIComponent(p)).then((d) => { setDir(d); setError(null); }).catch((e) => setError(e.message));
  const quick = [];
  const seen = new Set();
  for (const p of projects) if (!seen.has(p.path)) { seen.add(p.path); quick.push({ label: p.name, path: p.path, icon: 'kanban' }); }
  for (const s of sessions) if (s.alive && s.cwd && !seen.has(s.cwd)) { seen.add(s.cwd); quick.push({ label: shortPath(s.cwd), path: s.cwd, icon: 'terminal' }); }

  return html`<div class="col" style="gap:8px">
    <div class="row">
      <div class="with-icon grow"><${Icon} name="folder" /><input class="input mono" style="font-size:12.5px" value=${value} placeholder="Carpeta de trabajo" onInput=${(e) => onChange(e.target.value)} /></div>
      <${Btn} icon="folder-open" onClick=${() => setOpen(!open)}>${open ? 'Cerrar' : 'Explorar'}<//>
    </div>
    ${quick.length && !open ? html`<div class="row wrap">${quick.slice(0, 6).map((q) => html`<button type="button" class="chip" style="cursor:pointer" onClick=${() => onChange(q.path)}><${Icon} name=${q.icon} />${q.label}</button>`)}</div>` : null}
    ${open && dir ? html`<div class="card" style="max-height:260px;display:flex;flex-direction:column">
      <div class="row" style="padding:8px 10px;border-bottom:1px solid var(--line)">
        <${IconBtn} icon="arrow-up" size="sm" title="Subir" disabled=${!dir.parent} onClick=${() => go(dir.parent)} />
        <span class="mono ellipsis grow" style="font-size:12px">${dir.path}</span>
        <${Btn} size="sm" kind="primary" icon="check" onClick=${() => { onChange(dir.path); setOpen(false); }}>Usar esta<//>
      </div>
      <div style="overflow:auto;padding:4px">
        ${error ? html`<div class="bad" style="padding:8px">${error}</div>` : null}
        ${dir.entries.filter((e) => e.type === 'dir' && !e.hidden).map((e) => html`<div class="tree-row" onClick=${() => go(e.path)} onDblClick=${() => { onChange(e.path); setOpen(false); }}><${Icon} name="folder" cls="fi" /><span class="nm">${e.name}</span></div>`)}
      </div>
    </div>` : null}
  </div>`;
}

// ---------- new session ----------
export function newSession(preset) { openModal(() => html`<${NewSession} preset=${preset || {}} />`); }

function NewSession({ preset }) {
  const roles = useStore((s) => s.roles);
  const me = useStore((s) => s.me);
  const [defAccount, setLastAccount] = useDefaultAccount();
  const [name, setName] = useState(preset.name || '');
  const [configDir, setConfigDir] = useState(preset.configDir || defAccount);
  const [cwd, setCwd] = useState(preset.cwd || (me && me.home) || '');
  const [roleId, setRoleId] = useState(preset.roleId || '');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useLocal('sessionPermission', 'acceptEdits');
  const [where, setWhere] = useState(me && me.pty ? 'pty' : 'external');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e && e.preventDefault();
    setBusy(true);
    const role = roles.find((r) => r.id === roleId);
    const res = await attempt(() => api.post('/api/sessions', { name: name.trim() || (role ? role.name.toLowerCase() : 'sesion'), configDir, cwd, roleId: roleId || null, model, permissionMode, where }));
    setBusy(false);
    if (!res) return;
    setLastAccount(configDir);
    closeModal();
    if (res.terminal) { toast('Sesión creada en una terminal integrada'); navigate('/terminals/' + res.terminal.id); }
    else toast('Sesión abierta en Windows Terminal');
  };

  return html`<${Modal} title="Nueva sesión" subtitle="Una sesión de Claude Code real, con tu cockpit, en la cuenta que elijas."
    footer=${html`<span class="left">${where === 'pty' ? 'Vive dentro del editor mientras Bridge esté abierto.' : 'Se abre en una pestaña nueva de Windows Terminal.'}</span>
      <${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="play" busy=${busy} onClick=${submit}>Crear sesión<//>`}>
    <form onSubmit=${submit} class="col" style="gap:14px">
      <div class="grid-2">
        <${Field} label="Nombre" hint="Así la verán los demás agentes (@nombre).">
          <input class="input" autofocus value=${name} placeholder="p. ej. back-api" onInput=${(e) => setName(e.target.value)} />
        <//>
        <${Field} label="Cuenta"><${AccountSelect} value=${configDir} onChange=${setConfigDir} /><//>
      </div>
      <${Field} label="Carpeta de trabajo"><${FolderPicker} value=${cwd} onChange=${setCwd} /><//>
      <div class="grid-2">
        <${Field} label="Rol" hint="Se agrega al system prompt de la sesión.">
          <select class="select" value=${roleId} onChange=${(e) => setRoleId(e.target.value)}>
            <option value="">Sin rol</option>
            ${roles.map((r) => html`<option value=${r.id}>${r.emoji} ${r.name}</option>`)}
          </select>
        <//>
        <${Field} label="Modelo">
          <select class="select" value=${model} onChange=${(e) => setModel(e.target.value)}>${MODELS.map((m) => html`<option value=${m.value}>${m.label}</option>`)}</select>
        <//>
      </div>
      <div class="grid-2">
        <${Field} label="Permisos" hint="Las guardas del contrato aplican en cualquier modo.">
          <select class="select" value=${permissionMode} onChange=${(e) => setPermissionMode(e.target.value)}>
            <option value="default">Pregunta antes de actuar</option>
            <option value="acceptEdits">Acepta ediciones</option>
            <option value="plan">Solo planifica</option>
            <option value="bypassPermissions">Sin preguntas</option>
          </select>
        <//>
        <${Field} label="Dónde se abre">
          <${Seg} value=${where} onChange=${setWhere} options=${[
            { value: 'pty', label: 'Integrada', icon: 'terminal' },
            { value: 'external', label: 'Windows Terminal', icon: 'external' },
          ].filter((o) => o.value !== 'pty' || (me && me.pty))} />
        <//>
      </div>
      <div class="hint muted" style="font-size:12px">La primera vez en una carpeta, Claude pregunta si confías en ella: respóndelo en la terminal.</div>
    </form>
  <//>`;
}

// ---------- team builder (rooms & projects) ----------
export function TeamPicker({ team, setTeam, configDir }) {
  const roles = useStore((s) => s.roles);
  const count = (id) => (team.find((t) => t.roleId === id) || {}).count || 0;
  const setCount = (id, n) => {
    const rest = team.filter((t) => t.roleId !== id);
    setTeam(n > 0 ? rest.concat([{ roleId: id, count: n, configDir: (team.find((t) => t.roleId === id) || {}).configDir || configDir }]) : rest);
  };
  return html`<div class="wizard-roles">
    ${roles.map((r) => {
      const n = count(r.id);
      return html`<div class=${'role-pick' + (n ? ' on' : '')}>
        <${Avatar} emoji=${r.emoji} color=${r.color} size="sm" />
        <div class="grow"><div class="n">${r.name}</div><div class="s ellipsis" title=${r.description}>${r.description}</div></div>
        <div class="stepper">
          <button type="button" onClick=${() => setCount(r.id, Math.max(0, n - 1))} aria-label="Menos">−</button>
          <span>${n}</span>
          <button type="button" onClick=${() => setCount(r.id, Math.min(6, n + 1))} aria-label="Más">+</button>
        </div>
      </div>`;
    })}
  </div>`;
}

export function teamToMembers(team, cwd) {
  const roles = getState().roles;
  const out = [];
  for (const t of team) {
    const r = roles.find((x) => x.id === t.roleId);
    if (!r) continue;
    for (let i = 1; i <= t.count; i++) out.push({ kind: 'agent', roleId: r.id, name: t.count > 1 ? r.name + ' ' + i : r.name, configDir: t.configDir, cwd });
  }
  return out;
}

// ---------- new room ----------
export function newRoom(preset) { openModal(() => html`<${NewRoom} preset=${preset || {}} />`, 'modal'); }

function NewRoom({ preset }) {
  const sessions = useStore((s) => s.sessions);
  const me = useStore((s) => s.me);
  const [defAccount] = useDefaultAccount();
  const [name, setName] = useState(preset.name || '');
  const [topic, setTopic] = useState('');
  const [mode, setMode] = useState('lead');
  const [configDir, setConfigDir] = useState(defAccount);
  const [cwd, setCwd] = useState(preset.cwd || (me && me.home) || '');
  const [team, setTeam] = useState(preset.team || [{ roleId: 'supervisor', count: 1, configDir: defAccount }]);
  const [picked, setPicked] = useState(preset.sessionIds || []);
  const [busy, setBusy] = useState(false);
  const live = sessions.filter((s) => s.alive && s.source === 'claude');

  const submit = async () => {
    if (!name.trim()) { toast('Ponle un nombre a la sala', 'bad'); return; }
    setBusy(true);
    const members = teamToMembers(team.map((t) => Object.assign({}, t, { configDir: t.configDir || configDir })), cwd)
      .concat(picked.map((id) => ({ kind: 'session', sessionId: id, name: (sessions.find((s) => s.id === id) || {}).name })));
    const room = await attempt(() => api.post('/api/rooms', { name: name.trim(), topic, mode, members }));
    setBusy(false);
    if (!room) return;
    closeModal();
    navigate('/rooms/' + room.id);
  };

  return html`<${Modal} wide title="Nueva sala" subtitle="Un chat donde tú, agentes con rol y tus sesiones en vivo trabajan juntos."
    footer=${html`<span class="left">${teamToMembers(team, cwd).length} agentes · ${picked.length} sesiones</span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="rooms" busy=${busy} onClick=${submit}>Crear sala<//>`}>
    <div class="grid-2">
      <${Field} label="Nombre"><input class="input" autofocus value=${name} placeholder="p. ej. lanzamiento-v2" onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="Tema (opcional)"><input class="input" value=${topic} placeholder="De qué se trata" onInput=${(e) => setTopic(e.target.value)} /><//>
    </div>
    <${Field} label="Quién responde cuando escribes sin mencionar a nadie">
      <${Seg} value=${mode} onChange=${setMode} options=${[
        { value: 'lead', label: 'El coordinador', icon: 'crown' },
        { value: 'mentions', label: 'Solo mencionados', icon: 'at' },
        { value: 'all', label: 'Todos los agentes', icon: 'team' },
      ]} />
    <//>
    <${Field} label="Agentes con rol" hint="Cada agente es una sesión de Claude con memoria propia que responde en la sala."><${TeamPicker} team=${team} setTeam=${setTeam} configDir=${configDir} /><//>
    <div class="grid-2">
      <${Field} label="Cuenta de los agentes"><${AccountSelect} value=${configDir} onChange=${(v) => { setConfigDir(v); setTeam(team.map((t) => Object.assign({}, t, { configDir: v }))); }} /><//>
      <${Field} label="Carpeta de trabajo de los agentes"><${FolderPicker} value=${cwd} onChange=${setCwd} /><//>
    </div>
    ${live.length ? html`<${Field} label="Sesiones en vivo que se unen" hint="Les llegan los mensajes a su buzón (hook y herramientas bridge_*).">
      <div class="row wrap">${live.map((s) => {
        const on = picked.includes(s.id);
        return html`<button type="button" class=${'chip' + (on ? ' accent' : '')} style="cursor:pointer;height:28px" onClick=${() => setPicked(on ? picked.filter((x) => x !== s.id) : picked.concat([s.id]))}>
          ${on ? html`<${Icon} name="check" />` : html`<span class=${'dot ' + (s.status === 'busy' ? 'busy' : 'idle')}></span>`}${s.name}</button>`;
      })}</div>
    <//>` : null}
  <//>`;
}

// ---------- add member ----------
export function addMember(room) { openModal(() => html`<${AddMember} room=${room} />`); }

function AddMember({ room }) {
  const roles = useStore((s) => s.roles);
  const sessions = useStore((s) => s.sessions);
  const [defAccount] = useDefaultAccount();
  const [tab, setTab] = useState('agent');
  const [roleId, setRoleId] = useState(roles[0] ? roles[0].id : '');
  const [name, setName] = useState('');
  const [configDir, setConfigDir] = useState(defAccount);
  const firstAgent = room.members.find((m) => m.kind === 'agent');
  const [cwd, setCwd] = useState(firstAgent ? firstAgent.cwd : (getState().me || {}).home);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const live = sessions.filter((s) => s.alive && s.source === 'claude' && !room.members.some((m) => m.sessionId === s.id));

  const addAgent = async () => {
    const role = roles.find((r) => r.id === roleId);
    const r = await attempt(() => api.post('/api/rooms/' + room.id + '/members', { kind: 'agent', roleId, name: name.trim() || (role && role.name), configDir, cwd, model, permissionMode: permissionMode || undefined }), 'Agente agregado');
    if (r) closeModal();
  };
  const addSession = async (s) => {
    const r = await attempt(() => api.post('/api/rooms/' + room.id + '/members', { kind: 'session', sessionId: s.id, name: s.name }), s.name + ' se unió a la sala');
    if (r) closeModal();
  };

  return html`<${Modal} title=${'Agregar a ' + room.name} footer=${tab === 'agent' ? html`<span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="plus" onClick=${addAgent}>Agregar agente<//>` : null}>
    <${Seg} value=${tab} onChange=${setTab} options=${[{ value: 'agent', label: 'Agente con rol', icon: 'bot' }, { value: 'session', label: 'Sesión en vivo', icon: 'sessions', count: live.length }]} />
    ${tab === 'agent' ? html`
      <div class="grid-2">
        <${Field} label="Rol"><select class="select" value=${roleId} onChange=${(e) => setRoleId(e.target.value)}>${roles.map((r) => html`<option value=${r.id}>${r.emoji} ${r.name}</option>`)}</select><//>
        <${Field} label="Nombre (opcional)"><input class="input" value=${name} placeholder="Se usa el del rol" onInput=${(e) => setName(e.target.value)} /><//>
      </div>
      <div class="grid-2">
        <${Field} label="Cuenta"><${AccountSelect} value=${configDir} onChange=${setConfigDir} /><//>
        <${Field} label="Modelo"><select class="select" value=${model} onChange=${(e) => setModel(e.target.value)}>${MODELS.map((m) => html`<option value=${m.value}>${m.label}</option>`)}</select><//>
      </div>
      <${Field} label="Permisos" hint="Las guardas del contrato se aplican en cualquier modo."><select class="select" value=${permissionMode} onChange=${(e) => setPermissionMode(e.target.value)}><option value="">Los del rol</option>${PERMISSIONS.map((p) => html`<option value=${p.value}>${p.label}</option>`)}</select><//>
      <${Field} label="Carpeta de trabajo"><${FolderPicker} value=${cwd} onChange=${setCwd} /><//>
    ` : html`<div class="card">
      ${live.length ? live.map((s) => html`<div class="list-row" onClick=${() => addSession(s)}>
        <span class=${'dot ' + (s.status === 'busy' ? 'busy' : 'idle')}></span>
        <div class="grow"><div class="t">${s.name}</div><div class="s ellipsis">${s.account || ''} · ${shortPath(s.cwd)}</div></div>
        <${Icon} name="plus" />
      </div>`) : html`<div class="empty" style="padding:24px">No hay más sesiones vivas para agregar.</div>`}
    </div>`}
  <//>`;
}

// ---------- settings ----------
export function openSettings() { openModal(() => html`<${Settings} />`); }

function Settings() {
  const prefs = useStore((s) => s.prefs);
  const me = useStore((s) => s.me);
  const integration = useStore((s) => s.integration);
  const [humanName, setHumanName] = useState(prefs.humanName || '');
  const [theme, setTheme] = useLocal('theme', 'dark');
  const [busy, setBusy] = useState(false);

  const applyTheme = (t) => {
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  const save = async (patch) => { await attempt(() => api.patch('/api/prefs', patch)); };
  const connect = async () => {
    setBusy(true);
    const r = await attempt(() => api.post('/api/integration/connect'), 'Cuentas conectadas a Bridge');
    setBusy(false);
    if (r) setState({ integration: r.status });
  };

  return html`<${Modal} title="Ajustes" footer=${html`<span class="left mono">v${me && me.version} · ${me && me.dataDir}</span><${Btn} kind="primary" onClick=${closeModal}>Listo<//>`}>
    <${Field} label="Tu nombre" hint="Así te nombran los agentes en las salas.">
      <div class="row"><input class="input" value=${humanName} onInput=${(e) => setHumanName(e.target.value)} /><${Btn} onClick=${() => save({ humanName: humanName.trim() || 'Usuario' })}>Guardar<//></div>
    <//>
    <${Field} label="Tema">
      <${Seg} value=${theme} onChange=${applyTheme} options=${[{ value: 'dark', label: 'Oscuro', icon: 'moon' }, { value: 'light', label: 'Claro', icon: 'sun' }, { value: 'system', label: 'Sistema', icon: 'monitor' }]} />
    <//>
    <${Field} label="Entrega al terminar un turno" hint="Si llegan mensajes mientras una sesión trabaja, el hook Stop le pide responderlos antes de detenerse.">
      <${Switch} checked=${prefs.deliverOnStop !== false} onChange=${(v) => save({ deliverOnStop: v })} label="Activada" />
    <//>
    <${Field} label="Cuentas conectadas a Bridge" hint="Instala en cada cuenta el servidor MCP, los hooks de buzón y guardas, y la skill /modo-todo. Se puede repetir sin duplicar nada.">
      <${IntegrationList} integration=${integration} />
      <div><${Btn} icon="plug" kind="primary" busy=${busy} onClick=${connect}>Conectar todas<//></div>
    <//>
  <//>`;
}

export function IntegrationList({ integration }) {
  if (!integration) return null;
  const mark = (ok, label) => html`<span class=${'chip ' + (ok ? 'ok' : '')}>${ok ? html`<${Icon} name="check" />` : null}${label}</span>`;
  return html`<div class="card">
    ${integration.accounts.map((a) => html`<div class="list-row" style="cursor:default">
      <div class="grow"><div class="t">${a.email || 'sin sesión iniciada'}</div><div class="s mono">${a.configDir}</div></div>
      <div class="row wrap" style="justify-content:flex-end">${mark(a.integration.mcp, 'MCP')}${mark(a.integration.inbox, 'Buzón')}${mark(a.integration.guard, 'Guardas')}${mark(a.integration.skill, 'Skill')}</div>
    </div>`)}
    ${integration.antigravity.present ? html`<div class="list-row" style="cursor:default">
      <div class="grow"><div class="t">Antigravity</div><div class="s mono">~/.gemini/config/mcp_config.json</div></div>
      ${mark(integration.antigravity.mcp, 'MCP')}
    </div>` : null}
  </div>`;
}
