// Rooms: group chat between you, role agents and live Claude sessions.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore, loadRoom, upload, withToken, getState } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Markdown, Modal, Field, Seg, Avatar, CopyBtn,
  openModal, closeModal, toast, attempt, useMenu, useNow, ago, clock, money, lightbox, confirmDialog, useAutosize, modelLabel, shortPath, useLocal,
} from '../ui.js';
import { navigate } from '../router.js';
import { newRoom, addMember, MODELS, PERMISSIONS } from '../dialogs.js';

const MODE_LABEL = { lead: 'Responde el coordinador', mentions: 'Solo mencionados', all: 'Responden todos' };

function memberAvatar(m, size) {
  if (m.kind === 'session') return html`<${Avatar} size=${size} emoji="⌘" color="var(--surface-3)" />`;
  return html`<${Avatar} size=${size} emoji=${m.emoji} color=${m.color} name=${m.name} />`;
}

function authorAvatar(a, humanName) {
  if (a.kind === 'human') return html`<${Avatar} name=${humanName || a.name} color="linear-gradient(135deg,#a78bfa,#6d28d9)" />`;
  if (a.kind === 'session') return html`<${Avatar} emoji="⌘" color="var(--surface-3)" />`;
  return html`<${Avatar} emoji=${a.emoji || '🤖'} color=${a.color} name=${a.name} />`;
}

// ---------- room list ----------
function RoomList({ rooms, current, activity }) {
  const [q, setQ] = useState('');
  const now = useNow(30000);
  const shown = rooms.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  return html`<aside class="room-list">
    <div class="head">
      <${Btn} kind="primary" icon="plus" onClick=${() => newRoom()}>Nueva sala<//>
      <div class="with-icon"><${Icon} name="search" /><input class="input" value=${q} placeholder="Buscar sala" onInput=${(e) => setQ(e.target.value)} /></div>
    </div>
    <ul>
      ${shown.map((r) => {
        const busy = activity[r.id] && Object.keys(activity[r.id]).length;
        return html`<li class=${r.id === current ? 'on' : ''} onClick=${() => navigate('/rooms/' + r.id)}>
          <span class="hash">${r.directKey ? html`<${Icon} name="mail" />` : r.projectId ? html`<${Icon} name="kanban" />` : '#'}</span>
          <div class="grow">
            <div class="row"><span class="t ellipsis grow">${r.name}</span>${busy ? html`<span class="spinner"></span>` : html`<span class="dim" style="font-size:11px">${r.last ? ago(r.last.at, now) : ''}</span>`}</div>
            <div class="s">${r.last ? r.last.author.name + ': ' + r.last.text : r.members.length + ' miembros · sin mensajes'}</div>
          </div>
        </li>`;
      })}
    </ul>
  </aside>`;
}

// ---------- messages ----------
function Attachments({ list }) {
  if (!list || !list.length) return null;
  return html`<div class="attachments">${list.map((a) => (a.type && a.type.startsWith('image/')
    ? html`<img src=${withToken(a.url)} alt=${a.name} onClick=${() => lightbox(withToken(a.url))} />`
    : html`<span class="file"><${Icon} name="paperclip" />${a.name}<${CopyBtn} text=${a.path} /></span>`))}</div>`;
}

function Message({ m, cont, humanName, onQuote, onMention }) {
  if (m.author.kind === 'system') return html`<div class="msg system"><span class="pill">${m.text}</span></div>`;
  const role = m.author.roleId && (getState().roles.find((r) => r.id === m.author.roleId) || {}).name;
  return html`<div class=${'msg' + (cont ? ' cont' : '') + (m.author.kind === 'human' ? ' mine' : '')}>
    ${authorAvatar(m.author, humanName)}
    <div class="body">
      ${!cont ? html`<div class="by">
        <b style=${m.author.color ? { color: m.author.color } : null}>${m.author.kind === 'human' ? humanName || m.author.name : m.author.name}</b>
        ${m.author.kind === 'session' ? html`<span class="chip">sesión</span>` : role && role !== m.author.name ? html`<span class="chip">${role}</span>` : null}
        <span class="time">${clock(m.at)}</span>
        ${m.meta && m.meta.cost ? html`<span class="meta">${money(m.meta.cost)}${m.meta.tools ? ' · ' + m.meta.tools + ' herramientas' : ''}${m.meta.durationMs ? ' · ' + Math.round(m.meta.durationMs / 1000) + ' s' : ''}</span>` : null}
      </div>` : null}
      ${m.text ? html`<${Markdown} text=${m.text} />` : null}
      <${Attachments} list=${m.attachments} />
    </div>
    <div class="tools">
      <${CopyBtn} text=${m.text} />
      <${IconBtn} icon="quote" size="sm" title="Citar" onClick=${() => onQuote(m)} />
      ${m.author.kind !== 'human' ? html`<${IconBtn} icon="at" size="sm" title="Mencionar" onClick=${() => onMention(m.author)} />` : null}
    </div>
  </div>`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === y.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
}

// ---------- composer ----------
function Composer({ room, draftRef }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [drop, setDrop] = useState(false);
  const [pop, setPop] = useState(null); // { items, sel, start }
  const ta = useRef(null);
  const fileInput = useRef(null);
  useAutosize(ta, text);

  useEffect(() => {
    draftRef.current = {
      insert: (s) => { setText((t) => (t && !t.endsWith('\n') && !t.endsWith(' ') ? t + ' ' : t) + s); setTimeout(() => ta.current && ta.current.focus(), 0); },
    };
  }, []);
  useEffect(() => { setText(''); setFiles([]); setPop(null); }, [room.id]);

  const addFiles = async (list) => {
    for (const f of list) {
      const tmp = { id: 'tmp' + Math.random(), name: f.name || 'imagen.png', type: f.type, uploading: true, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      setFiles((x) => x.concat([tmp]));
      try {
        const up = await upload(f, f.name || 'pegado-' + Date.now() + '.png');
        setFiles((x) => x.map((y) => (y.id === tmp.id ? Object.assign({}, up, { preview: tmp.preview }) : y)));
      } catch (e) {
        toast('No se pudo adjuntar ' + tmp.name + ': ' + e.message, 'bad');
        setFiles((x) => x.filter((y) => y.id !== tmp.id));
      }
    }
  };

  const mentionables = () => [{ handle: 'todos', name: 'Todo el equipo', emoji: '👥' }].concat(room.members);
  const onInput = (e) => {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart;
    const m = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(v.slice(0, caret));
    if (m) {
      const qq = m[2].toLowerCase();
      const items = mentionables().filter((x) => x.handle.startsWith(qq) || (x.name || '').toLowerCase().startsWith(qq)).slice(0, 8);
      setPop(items.length ? { items, sel: 0, start: caret - m[2].length - 1 } : null);
    } else setPop(null);
  };
  const pick = (item) => {
    const el = ta.current;
    const caret = el.selectionStart;
    const next = text.slice(0, pop.start) + '@' + item.handle + ' ' + text.slice(caret);
    setText(next);
    setPop(null);
    setTimeout(() => { el.focus(); const pos = pop.start + item.handle.length + 2; el.setSelectionRange(pos, pos); }, 0);
  };

  const send = async () => {
    const ready = files.filter((f) => !f.uploading);
    if (!text.trim() && !ready.length) return;
    if (files.some((f) => f.uploading)) { toast('Espera a que terminen de subir los adjuntos', 'info'); return; }
    setSending(true);
    const ok = await attempt(() => api.post('/api/rooms/' + room.id + '/messages', { text, attachments: ready.map(({ preview, ...a }) => a) }));
    setSending(false);
    if (ok) { setText(''); setFiles([]); }
  };

  const onKey = (e) => {
    if (pop) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPop(Object.assign({}, pop, { sel: (pop.sel + 1) % pop.items.length })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPop(Object.assign({}, pop, { sel: (pop.sel - 1 + pop.items.length) % pop.items.length })); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(pop.items[pop.sel]); return; }
      if (e.key === 'Escape') { setPop(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  };
  const onPaste = (e) => {
    const list = [...(e.clipboardData && e.clipboardData.files || [])];
    if (list.length) { e.preventDefault(); addFiles(list); }
  };

  return html`<div class=${'composer' + (drop ? ' drop' : '')}
      onDragOver=${(e) => { e.preventDefault(); setDrop(true); }} onDragLeave=${() => setDrop(false)}
      onDrop=${(e) => { e.preventDefault(); setDrop(false); addFiles([...e.dataTransfer.files]); }}>
    ${pop ? html`<div class="mention-pop">${pop.items.map((it, i) => html`<div class=${i === pop.sel ? 'on' : ''} onMouseDown=${(e) => { e.preventDefault(); pick(it); }}>
      ${it.kind ? memberAvatar(it, 'sm') : html`<${Avatar} size="sm" emoji=${it.emoji} />`}<b>@${it.handle}</b><span class="muted ellipsis">${it.name}</span>
    </div>`)}</div>` : null}
    ${files.length ? html`<div class="pending">${files.map((f) => html`<div class="att">
      ${f.preview ? html`<img src=${f.preview} alt="" />` : html`<${Icon} name="paperclip" />`}
      <span class="ellipsis">${f.name}</span>${f.uploading ? html`<span class="spinner"></span>` : null}
      <${IconBtn} icon="x" size="sm" title="Quitar" onClick=${() => setFiles(files.filter((x) => x !== f))} />
    </div>`)}</div>` : null}
    <textarea ref=${ta} rows="1" value=${text} placeholder=${'Escribe a #' + room.name + ' — @ para mencionar, pega imágenes con Ctrl+V'}
      onInput=${onInput} onKeyDown=${onKey} onPaste=${onPaste} aria-label="Mensaje"></textarea>
    <div class="bar-row">
      <${IconBtn} icon="paperclip" title="Adjuntar archivos" onClick=${() => fileInput.current.click()} />
      <${IconBtn} icon="at" title="Mencionar" onClick=${() => { setText((t) => t + (t && !t.endsWith(' ') ? ' @' : '@')); ta.current.focus(); setPop({ items: mentionables(), sel: 0, start: text.length + (text && !text.endsWith(' ') ? 1 : 0) }); }} />
      <span class="hint">Enter envía · Shift+Enter nueva línea</span>
      <span class="grow"></span>
      <${Btn} kind="primary" size="sm" icon="send" busy=${sending} onClick=${send}>Enviar<//>
      <input ref=${fileInput} type="file" multiple hidden onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
    </div>
  </div>`;
}

// ---------- members ----------
function AgentTranscript({ member }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/api/sessions/' + member.sessionUuid + '/transcript?limit=200').then(setData).catch(() => setData({ entries: [] })); }, []);
  return html`<${Modal} wide title=${'Memoria de ' + member.name} subtitle="La sesión de Claude detrás de este agente: lo que leyó, hizo y respondió.">
    ${!data ? html`<div class="row muted"><span class="spinner"></span> Leyendo…</div>`
      : !data.entries.length ? html`<div class="muted">Este agente todavía no ha tenido turnos.</div>`
      : html`<div class="transcript">${data.entries.map((e) => (e.role === 'tool'
        ? html`<div class="t-entry tool"><div class="who">${e.name}</div><div class="body ellipsis">${e.text}</div></div>`
        : html`<div class=${'t-entry ' + e.role}><div class="who">${e.role === 'user' ? 'Sala' : member.name}</div><div class="body"><${Markdown} text=${e.text} /></div></div>`))}</div>`}
  <//>`;
}

function EditAgent({ room, member }) {
  const [name, setName] = useState(member.name);
  const [model, setModel] = useState(member.model || '');
  const [permissionMode, setPermissionMode] = useState(member.permissionMode || 'acceptEdits');
  const save = async () => {
    const ok = await attempt(() => api.patch('/api/rooms/' + room.id + '/members/' + member.id, { name, model, permissionMode }), 'Agente actualizado');
    if (ok) closeModal();
  };
  return html`<${Modal} title=${'Editar ' + member.name} footer=${html`<span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" onClick=${save}>Guardar<//>`}>
    <${Field} label="Nombre" hint="Cambia también su @handle."><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /><//>
    <div class="grid-2">
      <${Field} label="Modelo"><select class="select" value=${model} onChange=${(e) => setModel(e.target.value)}>${MODELS.map((m) => html`<option value=${m.value}>${m.label}</option>`)}</select><//>
      <${Field} label="Permisos"><select class="select" value=${permissionMode} onChange=${(e) => setPermissionMode(e.target.value)}>${PERMISSIONS.map((p) => html`<option value=${p.value}>${p.label}</option>`)}</select><//>
    </div>
    <dl class="kv"><dt>Cuenta</dt><dd>${member.configDir || 'por defecto'}</dd><dt>Carpeta</dt><dd class="mono">${member.cwd}</dd><dt>Sesión</dt><dd class="mono">${member.sessionUuid}</dd></dl>
  <//>`;
}

function Members({ room, activity, onMention }) {
  const sessions = useStore((s) => s.sessions);
  const prefs = useStore((s) => s.prefs);
  const [openMenu, menu] = useMenu();
  const act = activity[room.id] || {};
  return html`<aside class="members">
    <div class="row"><b>Miembros</b><span class="dim">${room.members.length + 1}</span><span class="grow"></span><${Btn} size="sm" icon="plus" onClick=${() => addMember(room)}>Agregar<//></div>
    <div class="col" style="gap:2px">
      <div class="member"><${Avatar} name=${prefs.humanName} color="linear-gradient(135deg,#a78bfa,#6d28d9)" size="sm" /><div class="grow"><div class="n">${prefs.humanName || 'Tú'}</div><div class="s">humano · tú</div></div></div>
      ${room.members.map((m) => {
        const a = act[m.id];
        const s = m.kind === 'session' ? sessions.find((x) => x.id === m.sessionId) : null;
        const status = m.kind === 'agent' ? (a ? 'busy' : 'idle') : s && s.alive ? (s.status === 'busy' ? 'busy' : 'idle') : 'off';
        return html`<div class="member">
          <div style="position:relative">${memberAvatar(m, 'sm')}<span class=${'dot st ' + status} style="position:absolute;right:-3px;bottom:-3px;border:2px solid var(--bg-2)"></span></div>
          <div class="grow">
            <div class="n row" style="gap:5px"><span class="ellipsis">${m.name}</span>${room.leadId === m.id ? html`<span class="lead" title="Coordina la sala"><${Icon} name="crown" /></span>` : null}</div>
            <div class="s ellipsis">${a ? a.text : m.kind === 'agent' ? '@' + m.handle + ' · ' + (modelLabel(m.model) || 'modelo por defecto') : '@' + m.handle + ' · ' + (s ? (s.alive ? 'sesión en vivo' : 'cerrada') : 'sesión')}</div>
          </div>
          <${IconBtn} icon="more" size="sm" title="Acciones" onClick=${(e) => openMenu(e, [
            { label: 'Mencionar', icon: 'at', run: () => onMention(m) },
            m.kind === 'agent' && room.leadId !== m.id ? { label: 'Hacer coordinador', icon: 'crown', run: () => attempt(() => api.patch('/api/rooms/' + room.id, { leadId: m.id }), m.name + ' coordina la sala') } : null,
            m.kind === 'agent' ? { label: 'Ver su memoria', icon: 'eye', run: () => openModal(() => html`<${AgentTranscript} member=${m} />`) } : null,
            m.kind === 'agent' ? { label: 'Editar agente', icon: 'pencil', run: () => openModal(() => html`<${EditAgent} room=${room} member=${m} />`) } : null,
            m.kind === 'session' ? { label: 'Ver sesión', icon: 'sessions', run: () => navigate('/sessions/' + m.sessionId) } : null,
            '-',
            { label: 'Quitar de la sala', icon: 'trash', danger: true, run: async () => { if (await confirmDialog({ title: 'Quitar a ' + m.name, text: m.kind === 'agent' ? 'Se detiene si está trabajando. Su sesión de Claude queda guardada.' : 'Dejará de recibir los mensajes de esta sala.', confirm: 'Quitar', danger: true })) attempt(() => api.del('/api/rooms/' + room.id + '/members/' + m.id)); } },
          ])} />
        </div>`;
      })}
    </div>
    <div class="card pad col" style="gap:8px;font-size:12.5px">
      <div class="row"><${Icon} name="info" /><b>Cómo funciona</b></div>
      <div class="muted">${MODE_LABEL[room.mode]} cuando escribes sin mencionar a nadie. Los agentes se activan entre ellos solo con @menciones.</div>
      <div class="row"><span class="muted">Turnos automáticos</span><span class="grow"></span><b class="mono">${room.autoLeft}/${room.maxAutoTurns}</b></div>
      <div class="row"><span class="muted">Gastado</span><span class="grow"></span><b class="mono">${money(room.spentUsd || 0)}${room.budgetUsd ? ' / ' + money(room.budgetUsd) : ''}</b></div>
    </div>
    ${menu}
  </aside>`;
}

function RoomSettings({ room }) {
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic || '');
  const [mode, setMode] = useState(room.mode);
  const [maxAutoTurns, setMaxAutoTurns] = useState(room.maxAutoTurns);
  const [budgetUsd, setBudgetUsd] = useState(room.budgetUsd || 0);
  const save = async () => {
    const ok = await attempt(() => api.patch('/api/rooms/' + room.id, { name, topic, mode, maxAutoTurns, budgetUsd }), 'Sala actualizada');
    if (ok) closeModal();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Borrar la sala ' + room.name, text: 'Se borra el historial de la sala. Las sesiones de los agentes quedan guardadas en sus cuentas.', confirm: 'Borrar sala', danger: true }))) return;
    const ok = await attempt(() => api.del('/api/rooms/' + room.id), 'Sala borrada');
    if (ok) navigate('/rooms');
  };
  return html`<${Modal} title="Ajustes de la sala" footer=${html`<${Btn} kind="danger" icon="trash" onClick=${remove}>Borrar sala<//><span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" onClick=${save}>Guardar<//>`}>
    <div class="grid-2">
      <${Field} label="Nombre"><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="Tema"><input class="input" value=${topic} onInput=${(e) => setTopic(e.target.value)} /><//>
    </div>
    <${Field} label="Cuando escribes sin mencionar a nadie">
      <${Seg} value=${mode} onChange=${setMode} options=${[{ value: 'lead', label: 'Responde el coordinador', icon: 'crown' }, { value: 'mentions', label: 'Nadie', icon: 'at' }, { value: 'all', label: 'Todos', icon: 'team' }]} />
    <//>
    <div class="grid-2">
      <${Field} label="Turnos automáticos por mensaje tuyo" hint="Cuántas veces pueden activarse los agentes entre ellos antes de esperarte.">
        <input class="input" type="number" min="0" max="50" value=${maxAutoTurns} onInput=${(e) => setMaxAutoTurns(Number(e.target.value))} />
      <//>
      <${Field} label="Presupuesto (US$)" hint="0 = sin tope. Al llegar, los agentes se detienen."><input class="input" type="number" min="0" step="0.5" value=${budgetUsd} onInput=${(e) => setBudgetUsd(Number(e.target.value))} /><//>
    </div>
  <//>`;
}

// ---------- chat ----------
function Chat({ room, activity, showMembers, setShowMembers, draft }) {
  const messages = useStore((s) => s.roomMessages[room.id]);
  const humanName = useStore((s) => s.prefs.humanName);
  const box = useRef(null);
  const stick = useRef(true);
  const act = activity[room.id] || {};
  const running = Object.keys(act);

  useEffect(() => { if (!messages) loadRoom(room.id).catch((e) => toast(e.message, 'bad')); stick.current = true; }, [room.id]);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages && messages.length, running.length, room.id]);

  const onScroll = () => {
    const el = box.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const quote = (m) => draft.current.insert('> ' + m.text.split('\n').slice(0, 4).join('\n> ') + '\n\n');
  const mention = (a) => {
    const m = room.members.find((x) => x.id === a.id || x.sessionId === a.id);
    draft.current.insert('@' + (m ? m.handle : a.name) + ' ');
  };
  const stopAll = () => attempt(() => api.post('/api/rooms/' + room.id + '/stop'), 'Agentes detenidos');

  let lastDay = null;
  let prev = null;
  return html`<section class="chat">
    <div class="chat-head">
      <span class="avatar" style="background:var(--accent);color:#fff">${room.directKey ? html`<${Icon} name="mail" />` : '#'}</span>
      <div class="grow"><h3 class="ellipsis">${room.name}</h3><div class="topic ellipsis">${room.topic || MODE_LABEL[room.mode]}</div></div>
      ${running.length ? html`<${Btn} size="sm" kind="danger" icon="stop" onClick=${stopAll}>Detener (${running.length})<//>` : null}
      <span class="chip mono" title="Gastado en esta sala">${money(room.spentUsd || 0)}</span>
      <${IconBtn} icon="settings" title="Ajustes de la sala" onClick=${() => openModal(() => html`<${RoomSettings} room=${room} />`)} />
      <${IconBtn} icon="panel" title="Miembros" on=${showMembers} onClick=${() => setShowMembers(!showMembers)} />
    </div>
    <div class="messages" ref=${box} onScroll=${onScroll}>
      ${!messages ? html`<div class="row muted" style="margin:auto"><span class="spinner"></span> Cargando…</div>`
        : !messages.length ? html`<${Empty} icon="rooms" title=${'Bienvenido a #' + room.name}>
            ${room.members.some((m) => m.kind === 'agent') ? 'Escribe un objetivo. ' + MODE_LABEL[room.mode] + ', y los agentes se pasan el trabajo con @menciones.' : 'Agrega agentes con rol o sesiones en vivo desde el panel de miembros.'}
          <//>`
        : messages.map((m) => {
          const day = dayLabel(m.at);
          const sep = day !== lastDay ? html`<div class="day">${day}</div>` : null;
          lastDay = day;
          const cont = prev && prev.author.id === m.author.id && m.author.kind !== 'system' && m.at - prev.at < 5 * 60 * 1000 && !sep;
          prev = m;
          return html`${sep}<${Message} key=${m.id} m=${m} cont=${cont} humanName=${humanName} onQuote=${quote} onMention=${mention} />`;
        })}
    </div>
    ${running.length ? html`<div class="activity">${running.map((id) => {
      const m = room.members.find((x) => x.id === id);
      return m ? html`<div class="typing"><i></i><i></i><i></i><b>${m.emoji || ''} ${m.name}</b><span class="ellipsis">${act[id].text}</span></div>` : null;
    })}</div>` : null}
    <${Composer} room=${room} draftRef=${draft} />
  </section>`;
}

export function Rooms({ route }) {
  const rooms = useStore((s) => s.rooms);
  const activity = useStore((s) => s.activity);
  const [showMembers, setShowMembers] = useLocal('roomMembers', true);
  const draft = useRef({ insert: () => {} });
  const room = rooms.find((r) => r.id === route.param);

  useEffect(() => {
    if (!route.param && rooms.length) navigate('/rooms/' + rooms[0].id);
  }, [route.param, rooms.length]);

  if (!rooms.length) {
    return html`<div class="page"><${Empty} icon="rooms" title="Tu primera sala"
      action=${html`<div class="row"><${Btn} kind="primary" icon="plus" onClick=${() => newRoom()}>Nueva sala<//><${Btn} icon="scroll" onClick=${() => navigate('/projects')}>Proyecto con contrato<//></div>`}>
      Una sala reúne agentes con rol (supervisor, arquitecto, desarrolladores, QA…) y tus sesiones en vivo. Tú escribes el objetivo; ellos se coordinan con @menciones.<//></div>`;
  }
  return html`<div class=${'chat-layout' + (showMembers && room ? '' : ' no-members')}>
    <${RoomList} rooms=${rooms} current=${route.param} activity=${activity} />
    ${room ? html`<${Chat} key=${room.id} room=${room} activity=${activity} showMembers=${showMembers} setShowMembers=${setShowMembers} draft=${draft} />`
      : html`<div class="chat"><${Empty} icon="hash" title="Elige una sala">O crea una nueva.<//></div>`}
    ${room && showMembers ? html`<${Members} room=${room} activity=${activity} onMention=${(m) => draft.current.insert('@' + m.handle + ' ')} />` : null}
  </div>`;
}
