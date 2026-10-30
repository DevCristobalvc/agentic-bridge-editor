// Vault: notes, snippets and images shared by you and every session (bridge_vault_* tools).
import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore, upload, withToken } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Markdown, Modal, TagInput, CopyBtn,
  openModal, closeModal, toast, attempt, confirmDialog, ago, useNow, lightbox, useAutosize,
} from '../ui.js';

function NoteEditor({ note, onDone, compact }) {
  const [title, setTitle] = useState(note ? note.title : '');
  const [text, setText] = useState(note ? note.text : '');
  const [tags, setTags] = useState(note ? note.tags : []);
  const [files, setFiles] = useState(note ? note.attachments || [] : []);
  const [busy, setBusy] = useState(false);
  const ta = useRef(null);
  useAutosize(ta, text);

  const addFiles = async (list) => {
    for (const f of list) {
      const up = await attempt(() => upload(f, f.name || 'pegado-' + Date.now() + '.png'));
      if (up) setFiles((x) => x.concat([up]));
    }
  };
  const save = async () => {
    if (!title.trim() && !text.trim() && !files.length) { toast('Escribe algo para guardar', 'info'); return; }
    setBusy(true);
    const body = { title, text, tags, attachments: files };
    const ok = await attempt(() => (note ? api.put('/api/vault/' + note.id, body) : api.post('/api/vault', body)), note ? 'Nota actualizada' : 'Guardado en el Baúl');
    setBusy(false);
    if (!ok) return;
    if (!note) { setTitle(''); setText(''); setTags([]); setFiles([]); }
    onDone && onDone(ok);
  };
  return html`<div class="col" style="gap:10px">
    <input class="input" value=${title} placeholder="Título (opcional)" onInput=${(e) => setTitle(e.target.value)} style="font-weight:600" />
    <textarea ref=${ta} class="textarea" rows=${compact ? 3 : 8} value=${text} placeholder="Una decisión, un comando, un hallazgo… Pega imágenes con Ctrl+V. Ctrl+Enter guarda."
      onInput=${(e) => setText(e.target.value)}
      onPaste=${(e) => { const l = [...((e.clipboardData && e.clipboardData.files) || [])]; if (l.length) { e.preventDefault(); addFiles(l); } }}
      onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}></textarea>
    ${files.length ? html`<div class="attachments">${files.map((a) => html`<span style="position:relative">
      ${a.type && a.type.startsWith('image/') ? html`<img src=${withToken(a.url)} alt=${a.name} style="max-height:90px" />` : html`<span class="file"><${Icon} name="paperclip" />${a.name}</span>`}
      <${IconBtn} icon="x" size="sm" title="Quitar" onClick=${() => setFiles(files.filter((x) => x !== a))} />
    </span>`)}</div>` : null}
    <div class="row wrap">
      <div class="grow" style="min-width:220px"><${TagInput} values=${tags} onChange=${setTags} placeholder="Etiquetas (Enter)" /></div>
      <${Btn} kind="primary" icon="check" busy=${busy} onClick=${save}>${note ? 'Guardar cambios' : 'Guardar'}<//>
    </div>
  </div>`;
}

function editNote(note) {
  openModal(() => html`<${Modal} wide title="Editar nota"><${NoteEditor} note=${note} onDone=${closeModal} /><//>`);
}

function shareNote(note) {
  openModal(() => html`<${ShareNote} note=${note} />`);
}

function ShareNote({ note }) {
  const rooms = useStore((s) => s.rooms);
  const send = async (r) => {
    const ok = await attempt(() => api.post('/api/rooms/' + r.id + '/messages', { text: '**' + note.title + '**\n\n' + note.text, attachments: note.attachments || [] }), 'Compartida en ' + r.name);
    if (ok) closeModal();
  };
  return html`<${Modal} title=${'Compartir “' + note.title + '”'}>
    ${rooms.length ? html`<div class="card">${rooms.map((r) => html`<div class="list-row" onClick=${() => send(r)}><${Icon} name="hash" /><div class="grow t">${r.name}</div><${Icon} name="send" /></div>`)}</div>`
      : html`<div class="muted">No hay salas todavía.</div>`}
  <//>`;
}

function NoteCard({ n, now, onTag }) {
  const [open, setOpen] = useState(false);
  const togglePin = () => attempt(() => api.put('/api/vault/' + n.id, Object.assign({}, n, { pinned: !n.pinned })));
  const remove = async () => {
    if (await confirmDialog({ title: 'Borrar “' + n.title + '”', text: 'La nota desaparece del Baúl para todas las sesiones.', confirm: 'Borrar', danger: true })) attempt(() => api.del('/api/vault/' + n.id), 'Nota borrada');
  };
  const byHuman = !n.author || n.author.kind === 'human';
  return html`<article class=${'card note' + (n.pinned ? ' pinned' : '') + (open ? ' open' : '')}>
    <div class="row">
      <b class="grow ellipsis" title=${n.title}>${n.title}</b>
      <${IconBtn} icon="target" size="sm" on=${n.pinned} title=${n.pinned ? 'Desfijar' : 'Fijar arriba'} onClick=${togglePin} />
    </div>
    <div class="row wrap" style="gap:6px">
      <span class=${'chip' + (byHuman ? '' : ' accent')}>${byHuman ? html`<${Icon} name="user" />` : html`<${Icon} name="bot" />`}${(n.author && n.author.name) || 'Tú'}</span>
      <span class="dim" style="font-size:12px">${ago(n.updatedAt, now)}</span>
      ${n.tags.map((t) => html`<button type="button" class="chip mono" style="cursor:pointer" onClick=${() => onTag(t)}>#${t}</button>`)}
    </div>
    ${n.text ? html`<div class="note-body" onClick=${() => setOpen(!open)}><${Markdown} text=${n.text} /></div>` : null}
    ${n.attachments && n.attachments.length ? html`<div class="attachments">${n.attachments.map((a) => (a.type && a.type.startsWith('image/')
      ? html`<img src=${withToken(a.url)} alt=${a.name} onClick=${() => lightbox(withToken(a.url))} />`
      : html`<span class="file"><${Icon} name="paperclip" />${a.name}</span>`))}</div>` : null}
    <div class="row" style="margin-top:auto">
      <${CopyBtn} text=${n.text} label="Copiar" />
      <${IconBtn} icon="send" size="sm" title="Compartir en una sala" onClick=${() => shareNote(n)} />
      <${IconBtn} icon="pencil" size="sm" title="Editar" onClick=${() => editNote(n)} />
      <span class="grow"></span>
      <${IconBtn} icon="trash" size="sm" title="Borrar" onClick=${remove} />
    </div>
  </article>`;
}

export function Vault() {
  const notes = useStore((s) => s.vault);
  const [q, setQ] = useState('');
  const now = useNow(30000);
  const tags = useMemo(() => {
    const count = new Map();
    for (const n of notes) for (const t of n.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [notes]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = notes.filter((n) => {
    const hay = (n.title + '\n' + n.text + '\n#' + n.tags.join(' #') + '\n' + ((n.author && n.author.name) || '')).toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);

  return html`<div class="page">
    <div class="page-head">
      <div><h2>Baúl</h2><p>La memoria compartida: lo que guardas tú y lo que guarda cualquier sesión, de cualquier cuenta, con <span class="mono">bridge_vault_save</span>.</p></div>
    </div>
    <div class="card pad" style="margin-bottom:18px"><${NoteEditor} compact /></div>
    <div class="toolbar">
      <div class="with-icon"><${Icon} name="search" /><input class="input" value=${q} placeholder="Buscar en el Baúl" onInput=${(e) => setQ(e.target.value)} /></div>
      ${tags.map(([t, n]) => html`<button type="button" class=${'chip mono' + (words.includes('#' + t) ? ' accent' : '')} style="cursor:pointer;height:28px"
        onClick=${() => setQ(words.includes('#' + t) ? q.replace('#' + t, '').trim() : (q + ' #' + t).trim())}>#${t} <span class="dim">${n}</span></button>`)}
    </div>
    ${shown.length ? html`<div class="notes">${shown.map((n) => html`<${NoteCard} key=${n.id} n=${n} now=${now} onTag=${(t) => setQ('#' + t)} />`)}</div>`
      : html`<${Empty} icon="book" title=${notes.length ? 'Nada coincide' : 'El Baúl está vacío'}>
          ${notes.length ? 'Prueba con otra búsqueda.' : 'Guarda aquí decisiones, comandos, prompts o capturas. Tus sesiones también pueden guardar y buscar con las herramientas bridge_vault_*.'}<//>`}
  </div>`;
}
