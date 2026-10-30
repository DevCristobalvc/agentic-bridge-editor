// Sessions: every Claude Code / Antigravity session across accounts, live.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore, getState } from '../api.js';
import {
  Btn, Icon, IconBtn, Bar, Empty, Markdown, Modal, Drawer, Seg, Field, CopyBtn,
  openModal, closeModal, toast, attempt, useMenu, useNow, ago, money, tokens, shortPath, sessionState, modelLabel, useLocal,
} from '../ui.js';
import { navigate } from '../router.js';
import { newSession } from '../dialogs.js';

function resumeCommand(s) {
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const parts = [];
  if (s.cwd) parts.push('Set-Location -LiteralPath ' + q(s.cwd));
  if (s.configDir && s.configDir !== '.claude') parts.push('$env:CLAUDE_CONFIG_DIR=' + q(String(s.configPath).replace(/\\/g, '/')));
  else parts.push('Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue');
  parts.push('claude --resume ' + s.id);
  return parts.join('; ');
}

async function resumeHere(s) {
  const r = await attempt(() => api.post('/api/sessions', { resumeId: s.id, configDir: s.configDir, cwd: s.cwd, name: s.name, where: 'pty' }));
  if (r && r.terminal) { closeModal(); navigate('/terminals/' + r.terminal.id); }
}

export function messageSession(s) {
  openModal(() => html`<${MessageDialog} s=${s} />`);
}

function MessageDialog({ s }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const r = await attempt(() => api.post('/api/sessions/' + s.id + '/message', { text }));
    setBusy(false);
    if (!r) return;
    closeModal();
    toast('Enviado. Le llega a ' + s.name + ' en su próximo turno.');
  };
  return html`<${Modal} title=${'Mensaje para ' + s.name} subtitle="Llega a su buzón: el hook lo entrega en su próximo turno y el cockpit muestra 📨. Si vive en una terminal integrada y está libre, Bridge la despierta."
    footer=${html`<span class="left">Queda en una sala directa contigo.</span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="send" busy=${busy} onClick=${send}>Enviar<//>`}>
    <textarea class="textarea" autofocus rows="6" value=${text} placeholder="Escribe en markdown…" onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}></textarea>
  <//>`;
}

export function addToRoom(s) {
  openModal(() => html`<${AddToRoom} s=${s} />`);
}

function AddToRoom({ s }) {
  const rooms = useStore((x) => x.rooms).filter((r) => !r.directKey);
  const add = async (r) => {
    const ok = await attempt(() => api.post('/api/rooms/' + r.id + '/members', { kind: 'session', sessionId: s.id, name: s.name }), s.name + ' se unió a ' + r.name);
    if (ok) closeModal();
  };
  return html`<${Modal} title=${'Agregar ' + s.name + ' a una sala'}>
    ${rooms.length ? html`<div class="card">${rooms.map((r) => {
      const inside = r.members.some((m) => m.sessionId === s.id);
      return html`<div class="list-row" onClick=${() => !inside && add(r)} style=${inside ? 'cursor:default;opacity:.6' : ''}>
        <${Icon} name="hash" /><div class="grow"><div class="t">${r.name}</div><div class="s">${r.members.length} miembros</div></div>
        ${inside ? html`<span class="chip">ya está</span>` : html`<${Icon} name="plus" />`}
      </div>`;
    })}</div>` : html`<${Empty} icon="rooms" title="No hay salas">Crea una sala primero.<//>`}
  <//>`;
}

function SessionCard({ s, waiters, now }) {
  const st = sessionState(s);
  const c = s.crew;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(s.name);
  const [openMenu, menu] = useMenu();
  const saveName = async () => {
    setRenaming(false);
    if (draft.trim() === s.name) return;
    await attempt(() => api.patch('/api/sessions/' + s.id, { alias: draft.trim(), native: !!s.terminalId }), 'Nombre actualizado');
  };
  const tok = s.tokens ? s.tokens.in + s.tokens.out + s.tokens.cr + s.tokens.cc : 0;
  const last = s.last && (s.last.assistant || s.last.user);
  const lastWho = s.last && s.last.assistant === last ? (s.source === 'antigravity' ? 'Agente' : 'Claude') : 'Tú';

  return html`<article class=${'card s-card ' + st.cls + (waiters.length ? ' needed' : '')}>
    <div class="top">
      <span class=${'dot ' + st.cls}></span>
      ${renaming
        ? html`<div class="rename"><input class="input" autofocus value=${draft} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(false); }} onBlur=${saveName} /></div>`
        : html`<span class="name ellipsis" title="Doble clic para renombrar" onDblClick=${() => { setDraft(s.name); setRenaming(true); }}>${s.name}</span>`}
      ${s.source === 'antigravity' ? html`<span class="chip accent">Antigravity</span>` : null}
      ${s.terminalId ? html`<span class="chip">integrada</span>` : null}
      ${s.unread ? html`<span class="chip accent" title="Mensajes de Bridge sin leer">📨 ${s.unread}</span>` : null}
      ${!renaming ? html`<span class="when">${st.cls === 'busy' ? st.label : st.label + ' · ' + ago(s.updatedAt, now)}</span>` : null}
    </div>
    ${c && c.title && c.title !== s.name ? html`<div class="ellipsis" style="font-size:13px;color:var(--text-2)" title=${c.title}>${c.title}</div>` : null}
    <div class="meta">
      ${s.cwd ? html`<span class="dir">▸ ${shortPath(s.cwd)}</span>` : null}
      ${c && c.branch ? html`<span class="branch">⎇ ${c.branch}</span>` : null}
      ${s.model ? html`<span>◆ ${modelLabel(s.model)}</span>` : null}
    </div>
    <div class="stats">
      ${s.cost != null ? html`<span><b>${money(s.cost)}</b></span>` : null}
      ${tok ? html`<span><b>${tokens(tok)}</b> tokens</span>` : null}
      ${s.ctxPct != null ? html`<span class="row" style="gap:6px">ctx <${Bar} value=${s.ctxPct} width="56px" /> <b>${Math.round(s.ctxPct)}%</b></span>` : null}
      ${c && c.total ? html`<span class="row" style="gap:6px;margin-left:auto">${c.task ? html`<span class=${c.blocked ? 'bad' : ''}>Task ${c.task}${c.blocked ? '!' : ''}</span>` : null}<${Bar} value=${(100 * c.done) / c.total} tone="ok" width="56px" /><b>${c.done}/${c.total}</b></span>` : null}
    </div>
    ${c && c.waitingOn ? html`<div class="flag waiting">⏳ Esperando: ${c.waitingOn}</div>` : null}
    ${waiters.length ? html`<div class="flag needed">⇄ ${waiters.join(', ')} está esperando a esta sesión</div>` : null}
    ${last ? html`<div class="preview"><b>${lastWho}:</b> ${last.text}</div>` : null}
    <div class="actions">
      ${s.terminalId ? html`<${Btn} size="sm" kind="primary" icon="terminal" onClick=${() => navigate('/terminals/' + s.terminalId)}>Abrir terminal<//>` : null}
      <${Btn} size="sm" icon="eye" onClick=${() => navigate('/sessions/' + s.id)}>Conversación<//>
      ${s.alive && s.source === 'claude' ? html`<${Btn} size="sm" icon="send" onClick=${() => messageSession(s)}>Mensaje<//>` : null}
      ${!s.alive && s.configPath ? html`<${Btn} size="sm" icon="play" onClick=${() => resumeHere(s)}>Retomar aquí<//>` : null}
      <span class="grow"></span>
      <${IconBtn} icon="more" size="sm" title="Más acciones" onClick=${(e) => openMenu(e, [
        { label: 'Renombrar', icon: 'pencil', run: () => { setDraft(s.name); setRenaming(true); } },
        s.alive && s.source === 'claude' ? { label: 'Agregar a una sala', icon: 'rooms', run: () => addToRoom(s) } : null,
        s.cwd ? { label: 'Ver su carpeta', icon: 'folder-open', run: () => navigate('/files?path=' + encodeURIComponent(s.cwd)) } : null,
        '-',
        { label: 'Copiar ID', icon: 'copy', run: () => navigator.clipboard.writeText(s.id).then(() => toast('ID copiado')) },
        s.configPath ? { label: 'Copiar comando para retomar', icon: 'terminal', run: () => navigator.clipboard.writeText(resumeCommand(s)).then(() => toast('Comando copiado')) } : null,
        s.alias ? { label: 'Quitar nombre personalizado', icon: 'x', run: () => attempt(() => api.patch('/api/sessions/' + s.id, { alias: '' })) } : null,
      ])} />
    </div>
    ${menu}
  </article>`;
}

function waitersFor(s, all) {
  const names = [s.name, s.registryName, s.crew && s.crew.title].filter(Boolean).map((n) => n.toLowerCase());
  return all.filter((p) => p !== s && p.alive && p.crew && p.crew.waitingOn)
    .filter((p) => names.some((n) => p.crew.waitingOn.toLowerCase().includes(n))).map((p) => p.name);
}

function Transcript({ id, alive }) {
  const [data, setData] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    let stop = false;
    const load = () => api.get('/api/sessions/' + id + '/transcript?limit=250').then((d) => { if (!stop) setData(d); }).catch(() => {});
    load();
    const t = alive ? setInterval(load, 6000) : null;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [id]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [data && data.entries.length]);
  if (!data) return html`<div class="row muted"><span class="spinner"></span> Leyendo la conversación…</div>`;
  if (!data.entries.length) return html`<${Empty} icon="rooms" title="Sin conversación legible">Esta sesión no tiene mensajes de texto todavía.<//>`;
  return html`<div class="transcript" ref=${box}>
    ${data.truncated ? html`<div class="dim" style="font-size:12px">Mostrando la parte más reciente.</div>` : null}
    ${data.entries.map((e) => (e.role === 'tool'
      ? html`<div class="t-entry tool"><div class="who">${e.name}</div><div class="body ellipsis">${e.text}</div></div>`
      : html`<div class=${'t-entry ' + e.role}><div class="who">${e.role === 'user' ? 'Tú' : 'Claude'}</div><div class="body"><${Markdown} text=${e.text} /></div></div>`))}
  </div>`;
}

function SessionDrawer({ id }) {
  const s = useStore((x) => x.sessions.find((v) => v.id === id));
  const [tab, setTab] = useState('chat');
  const close = () => navigate('/sessions');
  if (!s) return html`<${Drawer} onClose=${close}><div class="drawer-head"><b>Sesión no encontrada</b><span class="grow"></span><${IconBtn} icon="x" title="Cerrar" onClick=${close} /></div><div class="drawer-body muted">Puede que se haya cerrado hace más de un día.</div><//>`;
  const st = sessionState(s);
  const tok = s.tokens || {};
  return html`<${Drawer} onClose=${close}>
    <div class="drawer-head">
      <span class=${'dot ' + st.cls}></span>
      <div class="grow"><b style="font-size:15px">${s.name}</b><div class="muted" style="font-size:12.5px">${st.label} · ${s.source === 'antigravity' ? 'Antigravity' : s.account || 'cuenta desconocida'}</div></div>
      ${s.terminalId ? html`<${Btn} size="sm" kind="primary" icon="terminal" onClick=${() => navigate('/terminals/' + s.terminalId)}>Terminal<//>` : null}
      ${s.alive && s.source === 'claude' ? html`<${Btn} size="sm" icon="send" onClick=${() => messageSession(s)}>Mensaje<//>` : null}
      ${!s.alive && s.configPath ? html`<${Btn} size="sm" icon="play" onClick=${() => resumeHere(s)}>Retomar<//>` : null}
      <${IconBtn} icon="x" title="Cerrar" onClick=${close} />
    </div>
    <div style="padding:10px 18px 0"><${Seg} value=${tab} onChange=${setTab} options=${[{ value: 'chat', label: 'Conversación', icon: 'rooms' }, { value: 'info', label: 'Detalles', icon: 'info' }]} /></div>
    <div class="drawer-body">
      ${tab === 'chat' ? html`<${Transcript} id=${s.id} alive=${s.alive} />` : html`<dl class="kv">
        <dt>ID</dt><dd class="mono row">${s.id}<${CopyBtn} text=${s.id} /></dd>
        <dt>Nombre en registro</dt><dd>${s.registryName || '—'}${s.alias ? html` <span class="chip">alias: ${s.alias}</span>` : null}</dd>
        <dt>Cuenta</dt><dd>${s.account || '—'} <span class="mono dim">${s.configDir || ''}</span></dd>
        <dt>Carpeta</dt><dd class="mono">${s.cwd || '—'}</dd>
        <dt>Modelo</dt><dd>${modelLabel(s.model) || '—'}</dd>
        <dt>Contexto usado</dt><dd>${s.ctxPct != null ? Math.round(s.ctxPct) + '%' : '—'}</dd>
        <dt>Costo</dt><dd>${money(s.cost)}</dd>
        <dt>Tokens</dt><dd class="mono">entrada ${tokens(tok.in)} · salida ${tokens(tok.out)} · caché leída ${tokens(tok.cr)} · caché escrita ${tokens(tok.cc)} · ${tok.req || 0} peticiones</dd>
        <dt>Versión</dt><dd>${s.version || '—'} ${s.kind ? html`<span class="chip">${s.kind}</span>` : null}</dd>
        <dt>PID</dt><dd class="mono">${s.pid || '—'}</dd>
        <dt>Iniciada</dt><dd>${s.startedAt ? new Date(s.startedAt).toLocaleString('es-CO') : '—'}</dd>
        ${s.configPath ? html`<dt>Retomar</dt><dd><code class="mono" style="font-size:12px;overflow-wrap:anywhere">${resumeCommand(s)}</code> <${CopyBtn} text=${resumeCommand(s)} /></dd>` : null}
      </dl>`}
    </div>
  <//>`;
}

export function Sessions({ route }) {
  const sessions = useStore((s) => s.sessions);
  const accounts = useStore((s) => s.accounts);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useLocal('sessionsFilter', 'alive');
  const now = useNow(15000);

  const counts = {
    alive: sessions.filter((s) => s.alive).length,
    busy: sessions.filter((s) => s.alive && s.status === 'busy').length,
    idle: sessions.filter((s) => s.alive && s.status !== 'busy').length,
    closed: sessions.filter((s) => !s.alive).length,
  };
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filter === 'alive' && !s.alive) return false;
      if (filter === 'busy' && !(s.alive && s.status === 'busy')) return false;
      if (filter === 'idle' && !(s.alive && s.status !== 'busy')) return false;
      if (filter === 'closed' && s.alive) return false;
      if (!needle) return true;
      return [s.name, s.registryName, s.crew && s.crew.title, s.cwd, s.account, s.configDir, s.model, s.crew && s.crew.task].some((v) => v && String(v).toLowerCase().includes(needle));
    }).sort((a, b) => (sessionState(a).cls === 'busy' ? 0 : 1) - (sessionState(b).cls === 'busy' ? 0 : 1) || (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [sessions, q, filter]);

  const groups = [];
  const byKey = new Map();
  const keyOf = (s) => (s.source === 'antigravity' ? 'agy' : s.configDir || 'unknown');
  for (const a of accounts) byKey.set(a.configDir, { title: a.email || 'sin sesión iniciada', chip: a.configDir, items: [] });
  byKey.set('agy', { title: 'Antigravity', chip: '~/.gemini', items: [] });
  byKey.set('unknown', { title: 'Cuenta desconocida', chip: 'cerradas', items: [] });
  for (const s of visible) (byKey.get(keyOf(s)) || byKey.get('unknown')).items.push(s);
  for (const g of byKey.values()) if (g.items.length) groups.push(g);

  return html`<div class="page">
    <div class="page-head">
      <div><h2>Sesiones</h2><p>Todas tus sesiones de Claude Code y Antigravity, de todas tus cuentas, en vivo.</p></div>
      <div class="actions"><${Btn} kind="primary" icon="plus" onClick=${() => newSession()}>Nueva sesión<//></div>
    </div>
    <div class="toolbar">
      <div class="with-icon"><${Icon} name="search" /><input class="input" value=${q} placeholder="Nombre, carpeta, cuenta, modelo, tarea…" onInput=${(e) => setQ(e.target.value)} /></div>
      <${Seg} value=${filter} onChange=${setFilter} options=${[
        { value: 'alive', label: 'Vivas', count: counts.alive },
        { value: 'busy', label: 'Trabajando', count: counts.busy },
        { value: 'idle', label: 'En espera', count: counts.idle },
        { value: 'closed', label: 'Cerradas', count: counts.closed },
      ]} />
      <span class="dim" style="font-size:12px;margin-left:auto">Doble clic en un nombre para renombrar</span>
    </div>
    ${groups.length ? groups.map((g) => html`<section>
      <div class="group-head"><span class="acct">${g.title}</span><span class="chip mono">${g.chip}</span><span class="dim">${g.items.length}</span></div>
      <div class="cards">${g.items.map((s) => html`<${SessionCard} key=${s.id} s=${s} waiters=${waitersFor(s, sessions)} now=${now} />`)}</div>
    </section>`) : html`<${Empty} icon="sessions" title=${q ? 'Nada coincide con tu búsqueda' : 'No hay sesiones en este filtro'}
        action=${html`<${Btn} kind="primary" icon="plus" onClick=${() => newSession()}>Nueva sesión<//>`}>
        Las sesiones que abras en cualquier terminal, con cualquier cuenta, aparecen aquí solas.<//>`}
    ${route.param ? html`<${SessionDrawer} id=${route.param} />` : null}
  </div>`;
}
