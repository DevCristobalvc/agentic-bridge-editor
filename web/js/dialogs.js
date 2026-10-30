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
  const favorites = useStore((s) => s.prefs.favorites) || [];
  const home = useStore((s) => s.me && s.me.home);

  useEffect(() => {
    if (!open) return;
    api.get('/api/fs/list?path=' + encodeURIComponent(value || home || '')).then((d) => { setDir(d); setError(null); })
      .catch(() => api.get('/api/fs/list?path=' + encodeURIComponent(home)).then(setDir));
  }, [open]);

  const go = (p) => api.get('/api/fs/list?path=' + encodeURIComponent(p)).then((d) => { setDir(d); setError(null); }).catch((e) => setError(e.message));
  const quick = [];
  const seen = new Set();
  for (const f of favorites) if (!seen.has(f.path)) { seen.add(f.path); quick.push({ label: f.label, path: f.path, icon: 'star' }); }
  for (const p of projects) if (!seen.has(p.path)) { seen.add(p.path); quick.push({ label: p.name, path: p.path, icon: 'kanban' }); }
  for (const s of sessions) if (s.alive && s.cwd && !seen.has(s.cwd)) { seen.add(s.cwd); quick.push({ label: shortPath(s.cwd), path: s.cwd, icon: 'terminal' }); }

  return html`<div class="col" style="gap:8px">
    <div class="row">
      <div class="with-icon grow"><${Icon} name="folder" /><input class="input mono" style="font-size:12.5px" value=${value} placeholder="Carpeta de trabajo" onInput=${(e) => onChange(e.target.value)} /></div>
      <${Btn} icon="folder-open" onClick=${() => setOpen(!open)}>${open ? 'Cerrar' : 'Explorar'}<//>
    </div>
    ${quick.length && !open ? html`<div class="row wrap">${quick.slice(0, 8).map((q) => html`<button type="button" class="chip" style="cursor:pointer" onClick=${() => onChange(q.path)}><${Icon} name=${q.icon} />${q.label}</button>`)}</div>` : null}
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

// ---------- credentials as environment variables ----------
export function SecretPicker({ value, onChange }) {
  const secrets = useStore((s) => s.secrets);
  if (!secrets.length) return html`<div class="muted" style="font-size:12.5px">No tienes credenciales guardadas. <a href="#/accounts">Agrégalas en Cuentas</a> y podrás pasarlas a cualquier terminal.</div>`;
  return html`<div class="row wrap" style="gap:6px">${secrets.map((x) => {
    const on = value.includes(x.id);
    return html`<button type="button" class=${'tag-check' + (on ? ' on' : '')} title=${x.service || x.name} onClick=${() => onChange(on ? value.filter((v) => v !== x.id) : value.concat([x.id]))}>
      <${Icon} name=${on ? 'check' : 'key'} /><span class="mono">${x.name}</span></button>`;
  })}</div>`;
}

// ---------- new session (Claude Code or Antigravity) ----------
export function newSession(preset) { openModal(() => html`<${NewSession} preset=${preset || {}} />`); }

let agyInfo = null;
function useAgy() {
  const [info, setInfo] = useState(agyInfo);
  useEffect(() => { if (!agyInfo) api.get('/api/agy').then((d) => { agyInfo = d; setInfo(d); }).catch(() => setInfo({ installed: false, models: [] })); }, []);
  return info;
}

const AGY_MODES = [
  { value: 'accept-edits', label: 'Acepta ediciones' },
  { value: '', label: 'Pregunta antes de actuar' },
  { value: 'plan', label: 'Solo planifica' },
  { value: 'auto', label: 'Automático' },
];

function NewSession({ preset }) {
  const roles = useStore((s) => s.roles);
  const me = useStore((s) => s.me);
  const agyState = useStore((s) => s.antigravity);
  const agy = useAgy();
  const [defAccount, setLastAccount] = useDefaultAccount();
  const [agent, setAgent] = useLocal('sessionAgent', 'claude');
  const [name, setName] = useState(preset.name || '');
  const [configDir, setConfigDir] = useState(preset.configDir || defAccount);
  const [cwd, setCwd] = useState(preset.cwd || (me && me.home) || '');
  const [roleId, setRoleId] = useState(preset.roleId || '');
  const [model, setModel] = useState('');
  const [agyModel, setAgyModel] = useState('');
  const [permissionMode, setPermissionMode] = useLocal('sessionPermission', 'acceptEdits');
  const [agyMode, setAgyMode] = useLocal('agyMode', 'accept-edits');
  const [where, setWhere] = useState(me && me.pty ? 'pty' : 'external');
  const [secretIds, setSecretIds] = useState([]);
  const [prompt, setPrompt] = useState(preset.prompt || '');
  const [busy, setBusy] = useState(false);
  const agyInstalled = !!(agyState && agyState.installed);
  const kind = preset.agent || (agent === 'agy' && agyInstalled ? 'agy' : 'claude');

  const submit = async (e) => {
    e && e.preventDefault();
    setBusy(true);
    let res;
    if (kind === 'agy') {
      res = await attempt(() => api.post('/api/agy/sessions', { name: name.trim() || 'antigravity', cwd, model: agyModel, mode: agyMode, secretIds, prompt: prompt.trim() || undefined }));
    } else {
      const role = roles.find((r) => r.id === roleId);
      res = await attempt(() => api.post('/api/sessions', { name: name.trim() || (role ? role.name.toLowerCase() : 'sesion'), configDir, cwd, roleId: roleId || null, model, permissionMode, where, secretIds, prompt: prompt.trim() || undefined }));
      if (res) setLastAccount(configDir);
    }
    setBusy(false);
    if (!res) return;
    closeModal();
    if (res.terminal) { toast(kind === 'agy' ? 'Sesión de Antigravity abierta' : 'Sesión creada en una terminal integrada'); navigate('/terminals/' + res.terminal.id); }
    else toast('Sesión abierta en Windows Terminal');
  };

  const pick = (v) => { if (!preset.agent) setAgent(v); };
  return html`<${Modal} title="Nueva sesión" subtitle="Un agente de verdad en tu carpeta, con su terminal, que Bridge puede ver y despertar."
    footer=${html`<span class="left">${kind === 'agy' ? 'Antigravity CLI en una terminal integrada.' : where === 'pty' ? 'Vive dentro del editor mientras Bridge esté abierto.' : 'Se abre en una pestaña nueva de Windows Terminal.'}</span>
      <${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="play" busy=${busy} onClick=${submit}>Crear sesión<//>`}>
    <form onSubmit=${submit} class="col" style="gap:14px">
      <div class="agent-switch" role="radiogroup" aria-label="Agente">
        <button type="button" role="radio" aria-checked=${kind === 'claude'} class=${kind === 'claude' ? 'on' : ''} onClick=${() => pick('claude')}>
          <span class="ic"><${Icon} name="sparkles" /></span><span><b>Claude Code</b><small>En cualquiera de tus cuentas</small></span></button>
        <button type="button" role="radio" aria-checked=${kind === 'agy'} class=${kind === 'agy' ? 'on' : ''} disabled=${!agyInstalled} onClick=${() => pick('agy')} title=${agyInstalled ? '' : 'No encontré el CLI de Antigravity (agy)'}>
          <span class="ic"><${Icon} name="orbit" /></span><span><b>Antigravity</b><small>${agyInstalled ? (agyState.model || 'agy CLI') : 'No instalado'}</small></span></button>
      </div>
      <div class="grid-2">
        <${Field} label="Nombre" hint=${kind === 'agy' ? 'Nombre de la pestaña en Bridge.' : 'Así la verán los demás agentes (@nombre).'}>
          <input class="input" autofocus value=${name} placeholder="p. ej. back-api" onInput=${(e) => setName(e.target.value)} />
        <//>
        ${kind === 'claude'
          ? html`<${Field} label="Cuenta"><${AccountSelect} value=${configDir} onChange=${setConfigDir} /><//>`
          : html`<${Field} label="Modelo"><select class="select" value=${agyModel} onChange=${(e) => setAgyModel(e.target.value)}>
              <option value="">El de tus ajustes${agyState && agyState.model ? ' (' + agyState.model + ')' : ''}</option>
              ${((agy && agy.models) || []).map((m) => html`<option value=${m.value}>${m.label}</option>`)}
            </select><//>`}
      </div>
      <${Field} label="Carpeta de trabajo"><${FolderPicker} value=${cwd} onChange=${setCwd} /><//>
      ${kind === 'claude' ? html`
        <div class="grid-2">
          <${Field} label="Rol" hint="Se agrega al system prompt de la sesión.">
            <select class="select" value=${roleId} onChange=${(e) => setRoleId(e.target.value)}>
              <option value="">Sin rol</option>
              ${roles.map((r) => html`<option value=${r.id}>${r.name}</option>`)}
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
        </div>` : html`
        <${Field} label="Permisos">
          <select class="select" value=${agyMode} onChange=${(e) => setAgyMode(e.target.value)}>${AGY_MODES.map((m) => html`<option value=${m.value}>${m.label}</option>`)}</select>
        <//>`}
      ${kind === 'agy' || where === 'pty' ? html`<${Field} label="Credenciales como variables de entorno" hint="Se descifran solo para esta terminal; nunca pasan por las salas ni por el MCP.">
        <${SecretPicker} value=${secretIds} onChange=${setSecretIds} />
      <//>` : null}
      ${kind === 'agy' || where === 'pty' ? html`<${Field} label="Primera instrucción (opcional)" hint="La sesión arranca trabajando en esto.">
        <textarea class="textarea" rows="2" value=${prompt} placeholder="p. ej. Revisa el README y propón mejoras" onInput=${(e) => setPrompt(e.target.value)}></textarea>
      <//>` : null}
      ${kind === 'claude' ? html`<div class="hint muted" style="font-size:12px">La primera vez en una carpeta, Claude pregunta si confías en ella: respóndelo en la terminal.</div>` : null}
    </form>
  <//>`;
}

// ---------- new terminal (PowerShell, Git Bash, CMD, WSL) ----------
export function newTerminal(preset) { openModal(() => html`<${NewTerminal} preset=${preset || {}} />`); }

function NewTerminal({ preset }) {
  const shells = useStore((s) => s.shells);
  const me = useStore((s) => s.me);
  const [shell, setShell] = useLocal('lastShell', 'powershell');
  const [cwd, setCwd] = useState(preset.cwd || (me && me.home) || '');
  const [name, setName] = useState('');
  const [secretIds, setSecretIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const chosen = shells.find((x) => x.id === (preset.shell || shell)) || shells[0];
  const submit = async (e) => {
    e && e.preventDefault();
    setBusy(true);
    const t = await attempt(() => api.post('/api/terminals', { shell: chosen && chosen.id, cwd, name: name.trim() || undefined, secretIds }));
    setBusy(false);
    if (t) { closeModal(); navigate('/terminals/' + t.id); }
  };
  return html`<${Modal} title="Nueva terminal" subtitle="Una consola dentro del editor, en la carpeta que elijas."
    footer=${html`<span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="terminal" busy=${busy} onClick=${submit}>Abrir<//>`}>
    <form onSubmit=${submit} class="col" style="gap:14px">
      <${Field} label="Consola"><div class="row wrap" style="gap:6px">${shells.map((x) => html`<button type="button" class=${'tag-check' + (chosen && chosen.id === x.id ? ' on' : '')} onClick=${() => setShell(x.id)}><${Icon} name=${x.icon} />${x.label}</button>`)}</div><//>
      <${Field} label="Nombre (opcional)"><input class="input" value=${name} placeholder=${chosen ? chosen.label : ''} onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="Carpeta"><${FolderPicker} value=${cwd} onChange=${setCwd} /><//>
      <${Field} label="Credenciales como variables de entorno"><${SecretPicker} value=${secretIds} onChange=${setSecretIds} /><//>
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
        <${Avatar} icon=${r.icon} emoji=${r.emoji} color=${r.color} size="sm" />
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
  const live = sessions.filter((s) => s.alive);

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
  const live = sessions.filter((s) => s.alive && !room.members.some((m) => m.sessionId === s.id));

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
        <${Field} label="Rol"><select class="select" value=${roleId} onChange=${(e) => setRoleId(e.target.value)}>${roles.map((r) => html`<option value=${r.id}>${r.name}</option>`)}</select><//>
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
  const [notify, setNotify] = useLocal('notify', false);
  const [busy, setBusy] = useState(false);

  const toggleNotify = async (v) => {
    if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { toast('El navegador no dio permiso para avisos', 'bad'); return; }
    }
    setNotify(v);
  };
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
    <${Field} label="Entrega mientras la sesión trabaja" hint="Los mensajes llegan entre una herramienta y la siguiente, sin esperar a que la sesión termine su turno. Usa un hook PostToolUse documentado (no lee claves ni toca nada interno de Claude Code) y se instala en cada cuenta conectada; agrega un instante a cada herramienta.">
      <${Switch} checked=${!!prefs.deliverMidTurn} onChange=${(v) => attempt(() => api.patch('/api/prefs', { deliverMidTurn: v }), v ? 'Entrega inmediata activada en tus cuentas' : 'Entrega inmediata desactivada')} label="Activada" />
    <//>
    <${Field} label="Avisos de escritorio" hint="Cuando estás en otra ventana: un agente responde en una sala o te menciona, o una sesión termina su turno.">
      <${Switch} checked=${notify} onChange=${toggleNotify} label="Activados" />
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
      <div class="row wrap" style="justify-content:flex-end">${mark(a.integration.mcp, 'MCP')}${mark(a.integration.inbox, 'Buzón')}${mark(a.integration.guard, 'Guardas')}${mark(a.integration.skill, 'Skill')}${a.integration.midTurn ? mark(true, 'Entrega inmediata') : null}</div>
    </div>`)}
    ${integration.antigravity.present ? html`<div class="list-row" style="cursor:default">
      <div class="grow"><div class="t">Antigravity</div><div class="s mono">~/.gemini/config/mcp_config.json</div></div>
      ${mark(integration.antigravity.mcp, 'MCP')}
    </div>` : null}
  </div>`;
}
