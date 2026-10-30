// Team: the role library (supervisor, architect, developers, QA…) used by rooms, projects and sessions.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useStore } from '../api.js';
import { Btn, Icon, IconBtn, Empty, Modal, Field, Avatar, TagInput, ROLE_COLORS, openModal, closeModal, attempt, confirmDialog, useMenu } from '../ui.js';
import { MODELS, PERMISSIONS, newSession, newRoom } from '../dialogs.js';

const EMOJIS = ['🧭', '🏛️', '🛠️', '🔍', '🛡️', '📝', '🎨', '📊', '⚙️', '🚀', '🧪', '🗄️', '📱', '🌐', '🤝', '🧠'];

export function editRole(role) { openModal(() => html`<${RoleEditor} role=${role} />`); }

function RoleEditor({ role }) {
  const isNew = !role || !role.id;
  const base = role || {};
  const [name, setName] = useState(base.name || '');
  const [emoji, setEmoji] = useState(base.emoji || '🤖');
  const [color, setColor] = useState(base.color || ROLE_COLORS[0]);
  const [description, setDescription] = useState(base.description || '');
  const [prompt, setPrompt] = useState(base.prompt || '');
  const [model, setModel] = useState(base.model || '');
  const [permissionMode, setPermissionMode] = useState(base.permissionMode || 'acceptEdits');
  const [allowedTools, setAllowedTools] = useState(base.allowedTools || []);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const body = { name: name.trim(), emoji, color, description, prompt, model, permissionMode, allowedTools };
    const ok = await attempt(() => (isNew ? api.post('/api/roles', body) : api.put('/api/roles/' + base.id, body)), isNew ? 'Rol creado' : 'Rol guardado');
    setBusy(false);
    if (ok) closeModal();
  };

  return html`<${Modal} wide title=${isNew ? 'Nuevo rol' : 'Editar ' + base.name} subtitle="Los cambios aplican a los agentes que se creen desde ahora y al próximo turno de los existentes."
    footer=${html`<span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="check" busy=${busy} onClick=${save}>${isNew ? 'Crear rol' : 'Guardar'}<//>`}>
    <div class="row" style="gap:14px;align-items:flex-start">
      <${Avatar} size="lg" emoji=${emoji} color=${color} />
      <div class="col grow" style="gap:10px">
        <div class="grid-2">
          <${Field} label="Nombre"><input class="input" autofocus value=${name} placeholder="p. ej. Diseñador UX" onInput=${(e) => setName(e.target.value)} /><//>
          <${Field} label="Descripción corta"><input class="input" value=${description} placeholder="Qué aporta al equipo" onInput=${(e) => setDescription(e.target.value)} /><//>
        </div>
        <div class="row wrap" style="gap:14px">
          <div class="swatches">${EMOJIS.map((em) => html`<button type="button" class=${em === emoji ? 'on' : ''} style="background:var(--surface-3);font-size:13px" onClick=${() => setEmoji(em)}>${em}</button>`)}</div>
          <div class="swatches">${ROLE_COLORS.map((c) => html`<button type="button" class=${c === color ? 'on' : ''} style=${{ background: c }} aria-label=${'Color ' + c} onClick=${() => setColor(c)}></button>`)}</div>
        </div>
      </div>
    </div>
    <${Field} label="Instrucciones del rol" hint="Se agregan al system prompt del agente. Bridge añade aparte las reglas de la sala y el contrato.">
      <textarea class="textarea code" rows="10" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder="Eres … Tu trabajo es … Nunca …"></textarea>
    <//>
    <div class="grid-2">
      <${Field} label="Modelo"><select class="select" value=${model} onChange=${(e) => setModel(e.target.value)}>${MODELS.map((m) => html`<option value=${m.value}>${m.label}</option>`)}</select><//>
      <${Field} label="Permisos en salas"><select class="select" value=${permissionMode} onChange=${(e) => setPermissionMode(e.target.value)}>${PERMISSIONS.map((p) => html`<option value=${p.value}>${p.label}</option>`)}</select><//>
    </div>
    <${Field} label="Herramientas permitidas sin preguntar" hint="Formato de Claude Code, p. ej. Bash(npm test) o Bash(git diff *). Vacío = las del modo de permisos.">
      <${TagInput} values=${allowedTools} onChange=${setAllowedTools} placeholder="Bash(npm test)" />
    <//>
  <//>`;
}

export function Team() {
  const roles = useStore((s) => s.roles);
  const rooms = useStore((s) => s.rooms);
  const [openMenu, menu] = useMenu();
  const usage = (id) => rooms.reduce((a, r) => a + r.members.filter((m) => m.roleId === id).length, 0);

  return html`<div class="page">
    <div class="page-head">
      <div><h2>Equipo</h2><p>Los roles de tus agentes. Úsalos en salas y proyectos, o abre una sesión con un rol puesto.</p></div>
      <div class="actions"><${Btn} icon="rooms" onClick=${() => newRoom()}>Armar una sala<//><${Btn} kind="primary" icon="plus" onClick=${() => editRole(null)}>Nuevo rol<//></div>
    </div>
    ${roles.length ? html`<div class="cards">${roles.map((r) => html`<div class="card role-card" style=${{ '--role': r.color }}>
      <div class="row">
        <${Avatar} emoji=${r.emoji} color=${r.color} />
        <div class="grow"><h3>${r.name}</h3><div class="muted" style="font-size:12px">${usage(r.id)} agentes en salas</div></div>
        <${IconBtn} icon="more" title="Acciones" onClick=${(e) => openMenu(e, [
          { label: 'Editar', icon: 'pencil', run: () => editRole(r) },
          { label: 'Duplicar', icon: 'copy', run: () => editRole(Object.assign({}, r, { id: null, name: r.name + ' (copia)' })) },
          { label: 'Abrir sesión con este rol', icon: 'sparkles', run: () => newSession({ roleId: r.id, name: r.name.toLowerCase() }) },
          '-',
          { label: 'Eliminar', icon: 'trash', danger: true, run: async () => { if (await confirmDialog({ title: 'Eliminar el rol ' + r.name, text: 'Los agentes que ya existen conservan sus instrucciones actuales hasta su próximo turno.', confirm: 'Eliminar', danger: true })) attempt(() => api.del('/api/roles/' + r.id), 'Rol eliminado'); } },
        ])} />
      </div>
      <p>${r.description}</p>
      <div class="row wrap">
        <span class="chip">${r.model ? r.model : 'modelo por defecto'}</span>
        <span class="chip">${(PERMISSIONS.find((p) => p.value === r.permissionMode) || {}).label || r.permissionMode}</span>
        ${r.allowedTools && r.allowedTools.length ? html`<span class="chip mono">${r.allowedTools.length} herramientas</span>` : null}
      </div>
      <div class="row" style="margin-top:auto">
        <${Btn} size="sm" icon="pencil" onClick=${() => editRole(r)}>Editar<//>
        <${Btn} size="sm" icon="sparkles" onClick=${() => newSession({ roleId: r.id, name: r.name.toLowerCase() })}>Desplegar<//>
      </div>
    </div>`)}</div>` : html`<${Empty} icon="team" title="Sin roles" action=${html`<${Btn} kind="primary" icon="plus" onClick=${() => editRole(null)}>Crear rol<//>`}>Crea el primero.<//>`}
    ${menu}
  </div>`;
}
