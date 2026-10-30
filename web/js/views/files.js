// Files: folder tree + folder view + file viewer (code, markdown, images, PDF) with light editing.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore, rawFileUrl } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Markdown, Modal, Seg, CopyBtn, Switch,
  openModal, closeModal, toast, attempt, bytes, ago, useLocal, useNow, lightbox,
} from '../ui.js';
import { iconFor } from '../icons.js';
import { highlight, languageOf } from '../md.js';
import { navigate } from '../router.js';
import { newShell } from './terminals.js';

const listCache = new Map();
async function listDir(p, fresh) {
  if (!fresh && listCache.has(p)) return listCache.get(p);
  const d = await api.get('/api/fs/list?path=' + encodeURIComponent(p));
  listCache.set(d.path, d);
  return d;
}

function sameDir(a, b) { return String(a || '').toLowerCase().replace(/[\\/]+$/, '') === String(b || '').toLowerCase().replace(/[\\/]+$/, ''); }
function isInside(child, parent) {
  const c = String(child || '').toLowerCase().replace(/\\/g, '/');
  const p = String(parent || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return c === p || c.startsWith(p + '/');
}

const go = (p) => navigate('/files?path=' + encodeURIComponent(p));

// ---------- tree ----------
function TreeNode({ entry, depth, current, showHidden, filter }) {
  const [open, setOpen] = useState(() => entry.type === 'dir' && isInside(current, entry.path) && !sameDir(current, entry.path));
  const [kids, setKids] = useState(null);
  useEffect(() => {
    if (open && entry.type === 'dir' && !kids) listDir(entry.path).then((d) => setKids(d.entries)).catch(() => setKids([]));
  }, [open]);
  useEffect(() => { if (entry.type === 'dir' && isInside(current, entry.path) && !sameDir(current, entry.path)) setOpen(true); }, [current]);
  const on = sameDir(current, entry.path);
  const shown = (kids || []).filter((k) => (showHidden || !k.hidden) && (!filter || k.type === 'dir' || k.name.toLowerCase().includes(filter)));
  return html`<div>
    <div class=${'tree-row' + (on ? ' on' : '')} style=${{ paddingLeft: 8 + depth * 14 + 'px' }}
      onClick=${() => { go(entry.path); if (entry.type === 'dir') setOpen(true); }}>
      <span class=${'tw' + (open ? ' open' : '')} onClick=${(e) => { if (entry.type === 'dir') { e.stopPropagation(); setOpen(!open); } }}>
        ${entry.type === 'dir' ? html`<${Icon} name="chevron-right" />` : null}
      </span>
      <${Icon} name=${entry.type === 'dir' ? (open ? 'folder-open' : 'folder') : iconFor(entry)} cls="fi" />
      <span class="nm">${entry.name}</span>
    </div>
    ${open && entry.type === 'dir' ? (kids ? shown.map((k) => html`<${TreeNode} key=${k.path} entry=${k} depth=${depth + 1} current=${current} showHidden=${showHidden} filter=${filter} />`)
      : html`<div class="tree-row" style=${{ paddingLeft: 30 + depth * 14 + 'px' }}><span class="spinner"></span></div>`) : null}
  </div>`;
}

// ---------- crumbs ----------
function Crumbs({ path, sep, children }) {
  const parts = [];
  const norm = String(path || '');
  const segs = norm.split(/[\\/]/).filter(Boolean);
  let acc = /^[\\/]/.test(norm) ? '/' : '';
  segs.forEach((s, i) => {
    acc = i === 0 ? (/^[A-Za-z]:$/.test(s) ? s + (sep || '\\') : acc + s) : acc.replace(/[\\/]$/, '') + (sep || '\\') + s;
    parts.push({ label: s, path: acc });
  });
  return html`<div class="crumbs">
    ${parts.map((p, i) => html`${i ? html`<span class="sep">/</span>` : null}<button type="button" onClick=${() => go(p.path)}>${p.label}</button>`)}
    <div class="actions">${children}</div>
  </div>`;
}

// ---------- folder view ----------
function FolderView({ dir, showHidden, filter }) {
  const [mode, setMode] = useLocal('folderMode', 'grid');
  const [sort, setSort] = useLocal('folderSort', 'name');
  const now = useNow(60000);
  const entries = useMemo(() => {
    const list = dir.entries.filter((e) => (showHidden || !e.hidden) && (!filter || e.name.toLowerCase().includes(filter)));
    const by = {
      name: (a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1),
      size: (a, b) => (b.size || 0) - (a.size || 0),
      mtime: (a, b) => b.mtime - a.mtime,
    }[sort];
    return list.slice().sort(by);
  }, [dir, showHidden, filter, sort]);
  const dirs = entries.filter((e) => e.type === 'dir').length;
  return html`<div>
    <div class="row" style="padding:12px 18px 0">
      <span class="muted" style="font-size:12.5px">${dirs} carpetas · ${entries.length - dirs} archivos${dir.truncated ? ' (mostrando los primeros 3000)' : ''}</span>
      <span class="grow"></span>
      <${Seg} value=${sort} onChange=${setSort} options=${[{ value: 'name', label: 'Nombre' }, { value: 'mtime', label: 'Recientes' }, { value: 'size', label: 'Tamaño' }]} />
      <${Seg} value=${mode} onChange=${setMode} options=${[{ value: 'grid', label: '', icon: 'grid' }, { value: 'list', label: '', icon: 'list' }]} />
    </div>
    ${!entries.length ? html`<${Empty} icon="folder" title="Carpeta vacía">${filter ? 'Nada coincide con el filtro.' : 'No hay nada aquí todavía.'}<//>`
      : mode === 'grid'
        ? html`<div class="folder-grid">${entries.map((e) => html`<div class="folder-item" onClick=${() => go(e.path)} title=${e.name}>
            <div class=${'big' + (e.type === 'dir' ? ' dir' : '')}><${Icon} name=${iconFor(e)} /></div>
            <div class="nm">${e.name}</div><div class="sz">${e.type === 'dir' ? 'carpeta' : bytes(e.size)}</div>
          </div>`)}</div>`
        : html`<table class="folder-table"><thead><tr>
            <th onClick=${() => setSort('name')}>Nombre</th><th onClick=${() => setSort('mtime')}>Modificado</th><th onClick=${() => setSort('size')} style="text-align:right">Tamaño</th>
          </tr></thead><tbody>${entries.map((e) => html`<tr onClick=${() => go(e.path)}>
            <td class="nm"><${Icon} name=${iconFor(e)} />${e.name}</td><td class="muted">${ago(e.mtime, now)}</td><td class="muted" style="text-align:right">${e.type === 'dir' ? '—' : bytes(e.size)}</td>
          </tr>`)}</tbody></table>`}
  </div>`;
}

// ---------- file viewer ----------
function shareToRoom(file) {
  openModal(() => html`<${ShareDialog} file=${file} />`);
}

function ShareDialog({ file }) {
  const rooms = useStore((s) => s.rooms);
  const [note, setNote] = useState('');
  const send = async (r) => {
    const image = file.kind === 'image';
    const ok = await attempt(() => api.post('/api/rooms/' + r.id + '/messages', {
      text: (note.trim() ? note.trim() + '\n\n' : '') + '📎 `' + file.path + '`',
      attachments: [{ id: 'fs', name: file.name, type: image ? file.mime : 'text/plain', path: file.path, url: '/api/fs/raw?path=' + encodeURIComponent(file.path) }],
    }), 'Compartido en ' + r.name);
    if (ok) closeModal();
  };
  return html`<${Modal} title=${'Compartir ' + file.name} subtitle="Los agentes reciben la ruta y pueden abrir el archivo.">
    <textarea class="textarea" rows="3" value=${note} placeholder="Nota opcional, p. ej. “@arquitecto revisa esto”" onInput=${(e) => setNote(e.target.value)}></textarea>
    ${rooms.length ? html`<div class="card">${rooms.map((r) => html`<div class="list-row" onClick=${() => send(r)}><${Icon} name="hash" /><div class="grow t">${r.name}</div><${Icon} name="send" /></div>`)}</div>`
      : html`<div class="muted">No hay salas todavía.</div>`}
  <//>`;
}

function CodeBlock({ text, ext }) {
  const lang = languageOf(ext);
  const lines = text.split('\n');
  const tooBig = text.length > 400000;
  const body = tooBig ? null : highlight(text, lang);
  return html`<div class="code">
    <div class="ln">${lines.map((_, i) => i + 1).join('\n')}</div>
    ${tooBig ? html`<pre>${text}</pre>` : html`<pre class="hljs" dangerouslySetInnerHTML=${{ __html: body }}></pre>`}
  </div>`;
}

function FileViewer({ path }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [mdMode, setMdMode] = useLocal('mdMode', 'view');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Only the response for the file currently on screen may land: a slow answer for a file
  // clicked earlier must not replace it (and then be saved over it).
  const current = useRef(path);
  current.current = path;
  const load = () => {
    const asked = path;
    return api.get('/api/fs/read?path=' + encodeURIComponent(asked))
      .then((f) => { if (current.current === asked) { setFile(f); setError(null); } })
      .catch((e) => { if (current.current === asked) setError(e.message); });
  };
  useEffect(() => { setFile(null); setEditing(false); load(); }, [path]);

  const save = async () => {
    if (!file) return;
    setSaving(true);
    const f = await attempt(() => api.put('/api/fs/write', { path: file.path, content: draft, eol: file.eol, bom: file.bom }), 'Guardado');
    setSaving(false);
    if (f) { setFile(f); setEditing(false); }
  };

  const parent = String(path).replace(/[\\/][^\\/]*$/, '');
  if (error) return html`<div class="viewer"><${Crumbs} path=${path} /><${Empty} icon="alert" title="No pude abrir el archivo">${error}<//></div>`;
  if (!file) return html`<div class="viewer"><${Crumbs} path=${path} /><div class="row muted" style="padding:24px"><span class="spinner"></span> Abriendo…</div></div>`;

  const isMd = file.kind === 'text' && /^(md|markdown|mdx)$/.test(file.ext);
  const isJson = file.kind === 'text' && file.ext === 'json';
  let content = null;
  if (editing) content = html`<textarea class="editor-area" value=${draft} onInput=${(e) => setDraft(e.target.value)} spellcheck="false"
      onKeyDown=${(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } }}></textarea>`;
  else if (file.kind === 'image') content = html`<div class="file-img"><img src=${rawFileUrl(file.path)} alt=${file.name} onClick=${() => lightbox(rawFileUrl(file.path))} style="cursor:zoom-in" /></div>`;
  else if (file.kind === 'pdf') content = html`<iframe src=${rawFileUrl(file.path)} style="width:100%;height:100%;border:0;background:#fff" title=${file.name}></iframe>`;
  else if (file.kind === 'binary') content = html`<${Empty} icon="file" title="Archivo binario" action=${html`<${Btn} icon="external" onClick=${() => api.post('/api/fs/open', { path: file.path })}>Mostrar en el Explorador<//>`}>${bytes(file.size)} · no se puede previsualizar como texto.<//>`;
  else if (isMd && mdMode === 'view') content = html`<div class="file-md"><${Markdown} text=${file.content} /></div>`;
  else {
    let text = file.content;
    if (isJson) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {} }
    content = html`<${CodeBlock} text=${text} ext=${file.ext} />`;
  }

  return html`<div class="viewer">
    <${Crumbs} path=${file.path}>
      ${isMd && !editing ? html`<${Seg} value=${mdMode} onChange=${setMdMode} options=${[{ value: 'view', label: 'Vista', icon: 'eye' }, { value: 'code', label: 'Código', icon: 'code' }]} />` : null}
      ${editing ? html`<${Btn} size="sm" kind="ghost" onClick=${() => setEditing(false)}>Cancelar<//><${Btn} size="sm" kind="primary" icon="check" busy=${saving} onClick=${save}>Guardar<//>`
        : html`
          ${file.kind === 'text' && !file.truncated ? html`<${IconBtn} icon="pencil" title="Editar" onClick=${() => { setDraft(file.content); setEditing(true); }} />` : null}
          ${file.kind === 'text' ? html`<${CopyBtn} text=${file.content} />` : null}
          <${IconBtn} icon="link" title="Copiar ruta" onClick=${() => navigator.clipboard.writeText(file.path).then(() => toast('Ruta copiada'))} />
          <${IconBtn} icon="send" title="Compartir en una sala" onClick=${() => shareToRoom(file)} />
          <${IconBtn} icon="code" title="Abrir en VS Code" onClick=${() => attempt(() => api.post('/api/fs/open', { path: file.path, app: 'vscode' }))} />
          <${IconBtn} icon="external" title="Mostrar en el Explorador" onClick=${() => attempt(() => api.post('/api/fs/open', { path: file.path }))} />
          <${IconBtn} icon="refresh" title="Recargar" onClick=${load} />`}
    <//>
    <div class="row" style="padding:6px 18px;border-bottom:1px solid var(--line);font-size:12px" >
      <span class="muted">${bytes(file.size)} · modificado ${ago(file.mtime)}${file.truncated ? ' · mostrando los primeros 1,5 MB' : ''}</span>
      <span class="grow"></span><a href="javascript:void 0" onClick=${() => go(parent)} style="font-size:12px">Ver carpeta</a>
    </div>
    <div class="viewer-body">${content}</div>
  </div>`;
}

// ---------- view ----------
export function Files({ route }) {
  const home = useStore((s) => s.me && s.me.home);
  const [lastPath, setLastPath] = useLocal('filesPath', null);
  const [roots, setRoots] = useState([]);
  const [rootPath, setRootPath] = useLocal('filesRoot', null);
  const [showHidden, setShowHidden] = useLocal('filesHidden', false);
  const [filterRaw, setFilter] = useState('');
  const [target, setTarget] = useState(null); // { kind: 'dir'|'file', dir? }
  const [error, setError] = useState(null);
  const path = route.query.get('path') || lastPath || home;
  const filter = filterRaw.trim().toLowerCase();

  useEffect(() => { api.get('/api/fs/roots').then(setRoots).catch(() => {}); }, []);
  useEffect(() => {
    if (!route.query.get('path') && path) { go(path); return; }
    if (!path) return;
    setLastPath(path);
    setError(null);
    listDir(path, true).then((d) => setTarget({ kind: 'dir', dir: d }))
      .catch((e) => (/carpeta/i.test(e.message) ? setTarget({ kind: 'file' }) : (setError(e.message), setTarget(null))));
  }, [path]);

  const root = rootPath && isInside(path, rootPath) ? rootPath : (roots.find((r) => isInside(path, r.path) && r.path !== home) || {}).path || home;
  const rootEntry = { name: (roots.find((r) => sameDir(r.path, root)) || {}).label || root, path: root, type: 'dir' };

  return html`<div class="files-layout">
    <aside class="tree-pane">
      <div class="head">
        <select class="select" value=${root} onChange=${(e) => { setRootPath(e.target.value); go(e.target.value); }}>
          ${roots.map((r) => html`<option value=${r.path}>${r.label}</option>`)}
          ${!roots.some((r) => sameDir(r.path, root)) ? html`<option value=${root}>${root}</option>` : null}
        </select>
        <div class="with-icon"><${Icon} name="search" /><input class="input" value=${filterRaw} placeholder="Filtrar por nombre" onInput=${(e) => setFilter(e.target.value)} /></div>
        <div class="row"><${Switch} checked=${showHidden} onChange=${setShowHidden} label="Ocultos" /><span class="grow"></span>
          <${IconBtn} icon="terminal" title="PowerShell aquí" onClick=${() => newShell(target && target.kind === 'dir' ? path : String(path).replace(/[\\/][^\\/]*$/, ''))} />
          <${IconBtn} icon="refresh" title="Recargar" onClick=${() => { listCache.clear(); go(path + ''); setTarget(null); listDir(path, true).then((d) => setTarget({ kind: 'dir', dir: d })).catch(() => setTarget({ kind: 'file' })); }} />
        </div>
      </div>
      <div class="tree"><${TreeNode} key=${root} entry=${rootEntry} depth=${0} current=${path} showHidden=${showHidden} filter=${filter} /></div>
    </aside>
    ${error ? html`<div class="viewer"><${Crumbs} path=${path} /><${Empty} icon="alert" title="No pude abrir esta ruta">${error}<//></div>`
      : !target ? html`<div class="viewer"><${Crumbs} path=${path} /><div class="row muted" style="padding:24px"><span class="spinner"></span> Cargando…</div></div>`
      : target.kind === 'dir' ? html`<div class="viewer">
          <${Crumbs} path=${target.dir.path} sep=${target.dir.sep}>
            <${IconBtn} icon="link" title="Copiar ruta" onClick=${() => navigator.clipboard.writeText(target.dir.path).then(() => toast('Ruta copiada'))} />
            <${IconBtn} icon="code" title="Abrir en VS Code" onClick=${() => attempt(() => api.post('/api/fs/open', { path: target.dir.path, app: 'vscode' }))} />
            <${IconBtn} icon="external" title="Abrir en el Explorador" onClick=${() => attempt(() => api.post('/api/fs/open', { path: target.dir.path }))} />
          <//>
          <div class="viewer-body"><${FolderView} dir=${target.dir} showHidden=${showHidden} filter=${filter} /></div>
        </div>`
      : html`<${FileViewer} path=${path} />`}
  </div>`;
}
