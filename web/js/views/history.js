// History: every conversation of every account (Claude Code transcripts and Antigravity),
// searchable by title or by content, with a full reader to resume, export or keep.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Markdown, Seg, CopyBtn, toast, attempt, useMenu, ago, useNow, money, tokens, shortPath, useDebounced, useLocal, modelLabel,
} from '../ui.js';
import { navigate } from '../router.js';
import { expectSession } from './terminals.js';

let cache = null; // last list, so coming back to the view is instant

function dayGroup(ts, now) {
  if (!ts) return 'Sin fecha';
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Hoy';
  if (diff <= 1) return 'Ayer';
  if (diff < 7) return 'Esta semana';
  if (diff < 31) return 'Este mes';
  return d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

function highlight(text, q) {
  const s = String(text || '');
  if (!q) return s;
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return s;
  return html`${s.slice(0, i)}<mark>${s.slice(i, i + q.length)}</mark>${s.slice(i + q.length)}`;
}

function toMarkdown(conv, entries) {
  const out = ['# ' + conv.title, '', '_' + (conv.source === 'antigravity' ? 'Antigravity' : conv.account) + (conv.cwd ? ' · ' + conv.cwd : '') + (conv.lastAt ? ' · ' + new Date(conv.lastAt).toLocaleString('es-CO') : '') + '_', ''];
  for (const e of entries) {
    if (e.role === 'user') out.push('## Tú', '', e.text, '');
    else if (e.role === 'assistant') out.push('## ' + (conv.source === 'antigravity' ? 'Antigravity' : 'Claude'), '', e.text, '');
    else out.push('> **' + e.name + '** ' + (e.text || ''), '');
  }
  return out.join('\n');
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) + '.md';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- reader ----------
export function ToolEntry({ e }) {
  const [open, setOpen] = useState(false);
  return html`<div class="t-entry tool">
    <div class="who">${'herram.'}</div>
    <div class="body" style="min-width:0">
      <div class="tool-line" onClick=${() => setOpen(!open)}><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} /><b>${e.name}</b><span class="ellipsis">${e.text}</span>${e.error ? html`<span class="chip bad">error</span>` : null}</div>
      ${open ? html`<div class="tool-detail">
        ${e.input ? html`<pre>${e.input}</pre>` : null}
        ${e.result != null ? html`<pre class=${e.error ? 'err' : ''}>${e.result || '(sin salida)'}</pre>` : null}
      </div>` : null}
    </div>
  </div>`;
}

function Reader({ conv }) {
  const sessions = useStore((s) => s.sessions);
  const body = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [shown, setShown] = useState(300);
  const [hideTools, setHideTools] = useLocal('historyHideTools', false);
  const [openMenu, menu] = useMenu();
  useEffect(() => {
    setData(null); setError(null); setShown(300);
    api.get('/api/history/' + encodeURIComponent(conv.id) + '?source=' + conv.source)
      .then((d) => { if (d.error && !d.entries.length) setError(d.error); setData(d); requestAnimationFrame(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }); })
      .catch((e) => setError(e.message));
  }, [conv.id]);

  const live = sessions.find((s) => s.id === conv.id && s.alive);
  const entries = data ? data.entries.filter((e) => !hideTools || e.role !== 'tool') : [];
  const visible = entries.slice(-shown);
  const md = () => toMarkdown(conv, data ? data.entries : []);
  const resume = async (where) => {
    if (live) { navigate(live.terminalId ? '/terminals/' + live.terminalId : '/terminals/s.' + live.id); return; }
    const r = conv.source === 'antigravity'
      ? await attempt(() => api.post('/api/agy/sessions', { conversationId: conv.id, cwd: conv.cwd, name: conv.title.slice(0, 40) }))
      : await attempt(() => api.post('/api/sessions', { resumeId: conv.id, configDir: conv.configDir, cwd: conv.cwd, name: conv.title.slice(0, 40), where }));
    if (r && r.terminal) navigate('/terminals/' + r.terminal.id);
    else if (r && r.sessionId) { expectSession(r.sessionId, conv.title.slice(0, 40), where); navigate('/terminals/s.' + r.sessionId); toast(where === 'gitbash' ? 'Retomando en Git Bash en tu PC' : 'Retomando en Windows Terminal'); }
  };
  const toVault = () => attempt(() => api.post('/api/vault', { title: 'Conversación: ' + conv.title.slice(0, 80), text: md().slice(0, 60000), tags: ['historial'].concat(conv.project ? [conv.project] : []) }), 'Guardada en el Baúl');

  return html`<section class="conv-reader">
    <div class="conv-head">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <h3>${conv.title}</h3>
          <div class="row wrap" style="margin-top:6px;gap:6px">
            <span class="chip accent"><${Icon} name=${conv.source === 'antigravity' ? 'orbit' : 'sparkles'} />${conv.source === 'antigravity' ? 'Antigravity' : conv.account}</span>
            ${conv.cwd ? html`<span class="chip mono" title=${conv.cwd}>${shortPath(conv.cwd)}</span>` : null}
            ${conv.branch ? html`<span class="chip"><${Icon} name="branch" />${conv.branch}</span>` : null}
            ${(conv.models || []).map((m) => html`<span class="chip">${modelLabel(m)}</span>`)}
            ${live ? html`<span class="chip ok"><span class="dot busy"></span>abierta ahora</span>` : null}
          </div>
        </div>
        <div class="row" style="flex:none">
          <${Btn} kind="primary" icon="play" onClick=${() => resume('pty')}>${live ? 'Ir a la sesión' : 'Retomar'}<//>
          <${IconBtn} icon="more" title="Más" onClick=${(e) => openMenu(e, [
            conv.source === 'claude' && !live ? { label: 'Retomar en Git Bash', icon: 'git', run: () => resume('gitbash') } : null,
            conv.source === 'claude' && !live ? { label: 'Retomar en Windows Terminal', icon: 'external', run: () => resume('external') } : null,
            { label: 'Copiar como Markdown', icon: 'copy', run: () => navigator.clipboard.writeText(md()).then(() => toast('Conversación copiada')) },
            { label: 'Descargar .md', icon: 'download', run: () => download(conv.title, md()) },
            { label: 'Guardar en el Baúl', icon: 'book', run: toVault },
            conv.cwd ? { label: 'Abrir la carpeta', icon: 'folder-open', run: () => navigate('/files?path=' + encodeURIComponent(conv.cwd)) } : null,
            { label: 'Copiar id', icon: 'hash', run: () => navigator.clipboard.writeText(conv.id).then(() => toast('Id copiado')) },
          ])} />
        </div>
      </div>
      <div class="row wrap muted" style="font-size:12.5px;gap:14px">
        ${conv.prompts != null ? html`<span><b class="mono" style="color:var(--text)">${conv.prompts}</b> mensajes tuyos</span>` : html`<span><b class="mono" style="color:var(--text)">${conv.steps || 0}</b> pasos</span>`}
        ${conv.tokens ? html`<span><b class="mono" style="color:var(--text)">${tokens(conv.tokens)}</b> tokens</span>` : null}
        ${conv.cost ? html`<span title="Equivalente en precios de la API; tu suscripción no cobra por token"><b class="mono" style="color:var(--text)">${money(conv.cost)}</b> equivalente API</span>` : null}
        ${conv.subagents ? html`<span>${conv.subagents} subagentes</span>` : null}
        ${conv.startedAt ? html`<span>empezó ${new Date(conv.startedAt).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}</span>` : null}
        <span class="grow"></span>
        <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" checked=${hideTools} onChange=${(e) => setHideTools(e.target.checked)} />Ocultar herramientas</label>
      </div>
    </div>
    <div class="conv-body" ref=${body}>
      ${error ? html`<${Empty} icon="alert" title="No pude leer la conversación">${error}<//>`
        : !data ? html`<div class="row muted"><span class="spinner"></span> Leyendo la conversación…</div>`
        : html`<div class="transcript">
          ${entries.length > shown ? html`<div><${Btn} size="sm" icon="arrow-up" onClick=${() => setShown(shown + 300)}>Ver ${Math.min(300, entries.length - shown)} anteriores (${entries.length - shown} más)<//></div>` : null}
          ${visible.map((e) => (e.role === 'tool' ? html`<${ToolEntry} e=${e} />` : html`<div class=${'t-entry ' + e.role}>
            <div class="who">${e.role === 'user' ? 'Tú' : conv.source === 'antigravity' ? 'Agy' : 'Claude'}</div>
            <div class="body">${e.role === 'user' ? html`<div style="white-space:pre-wrap;overflow-wrap:anywhere">${e.text}</div>${e.images ? html`<span class="chip" style="margin-top:6px"><${Icon} name="image" />${e.images} imagen${e.images > 1 ? 'es' : ''}</span>` : null}` : html`<${Markdown} text=${e.text} />`}</div>
          </div>`))}
          ${!entries.length ? html`<div class="muted">Sin mensajes legibles.</div>` : null}
        </div>`}
    </div>
    ${menu}
  </section>`;
}

// ---------- view ----------
export function History({ route }) {
  const accounts = useStore((s) => s.accounts);
  const [list, setList] = useState(cache ? cache.conversations : null);
  const [indexing, setIndexing] = useState(cache ? cache.indexing : null);
  const [q, setQ] = useState('');
  const [deep, setDeep] = useState(false);
  const [hits, setHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [source, setSource] = useLocal('historySource', '');
  const [acct, setAcct] = useState('');
  const [project, setProject] = useState('');
  const [agents, setAgents] = useLocal('historyAgents', false);
  const dq = useDebounced(q, 250);
  const now = useNow(60000);

  const load = () => api.get('/api/history' + (agents ? '?all=1' : '')).then((d) => { cache = agents ? null : d; setList(d.conversations); setIndexing(d.indexing); });
  useEffect(() => { load().catch((e) => toast(e.message, 'bad')); }, [agents]);
  useEffect(() => {
    if (!indexing || !indexing.running) return undefined;
    const t = setTimeout(() => load().catch(() => {}), 2500);
    return () => clearTimeout(t);
  }, [indexing]);
  useEffect(() => {
    if (!deep || dq.trim().length < 2) { setHits(null); return; }
    setSearching(true);
    api.get('/api/history-search?q=' + encodeURIComponent(dq.trim())).then(setHits).catch((e) => toast(e.message, 'bad')).finally(() => setSearching(false));
  }, [dq, deep]);

  const emails = useMemo(() => [...new Set(accounts.filter((a) => a.email).map((a) => a.email))], [accounts]);
  const projects = useMemo(() => [...new Set((list || []).map((c) => c.project).filter(Boolean))].sort(), [list]);
  const filtered = useMemo(() => (list || []).filter((c) => (!source || c.source === source)
    && (!acct || c.account === acct)
    && (!project || c.project === project)
    && (!dq || deep || [c.title, c.firstPrompt, c.lastPrompt, c.cwd, c.branch].some((v) => v && v.toLowerCase().includes(dq.toLowerCase())))), [list, source, acct, project, dq, deep]);

  const current = (list || []).find((c) => c.id === route.param) || null;
  const open = (c) => navigate('/history/' + encodeURIComponent(c.id));
  let lastGroup = null;

  return html`<div class="history-layout">
    <aside class="conv-pane">
      <div class="head">
        <div class="with-icon"><${Icon} name="search" /><input class="input" value=${q} placeholder=${deep ? 'Buscar dentro de las conversaciones…' : 'Buscar por título, carpeta o prompt…'} onInput=${(e) => setQ(e.target.value)} /></div>
        <div class="row wrap" style="gap:6px">
          <button type="button" class=${'tag-check' + (deep ? ' on' : '')} onClick=${() => setDeep(!deep)} title="Lee los transcripts completos (puede tardar unos segundos)"><${Icon} name="filter" />En el contenido</button>
          <${Seg} value=${source} onChange=${setSource} options=${[{ value: '', label: 'Todo' }, { value: 'claude', label: 'Claude' }, { value: 'antigravity', label: 'Agy' }]} />
          <button type="button" class=${'tag-check' + (agents ? ' on' : '')} onClick=${() => setAgents(!agents)} title="Incluye las sesiones automáticas: agentes de salas y sondeos de uso"><${Icon} name="bot" />Agentes</button>
        </div>
        <div class="row" style="gap:6px">
          <select class="select sm" value=${acct} onChange=${(e) => setAcct(e.target.value)}><option value="">Todas las cuentas</option>${emails.map((m) => html`<option value=${m}>${m}</option>`)}</select>
          <select class="select sm" value=${project} onChange=${(e) => setProject(e.target.value)}><option value="">Todas las carpetas</option>${projects.map((p) => html`<option value=${p}>${p}</option>`)}</select>
        </div>
        ${indexing && indexing.running ? html`<div class="row muted" style="font-size:12px"><span class="spinner"></span>Indexando ${indexing.done}/${indexing.total} transcripts…</div>` : null}
      </div>
      <div class="conv-list">
        ${deep && dq.trim().length >= 2 ? (searching ? html`<div class="row muted" style="padding:12px"><span class="spinner"></span>Buscando “${dq}”…</div>`
          : hits && hits.length ? hits.map((h) => {
            const c = (list || []).find((x) => x.id === h.id);
            return html`<div class="hit" onClick=${() => open(c || { id: h.id })}>
              <div class="w">${c ? c.title : h.id.slice(0, 8)} · ${h.role === 'user' ? 'tú' : 'Claude'} · ${ago(h.at, now)}</div>
              <div>${highlight(h.snippet, dq)}</div>
            </div>`;
          }) : html`<div class="muted" style="padding:12px">Sin resultados en el contenido.</div>`)
        : !list ? html`<div class="row muted" style="padding:12px"><span class="spinner"></span>Cargando historial…</div>`
        : filtered.length ? filtered.map((c) => {
          const g = dayGroup(c.lastAt, now);
          const head = g !== lastGroup ? html`<div class="conv-group">${g}</div>` : null;
          lastGroup = g;
          return html`${head}<div class=${'conv-item' + (current && current.id === c.id ? ' on' : '')} onClick=${() => open(c)}>
            <div class="t"><${Icon} name=${c.source === 'antigravity' ? 'orbit' : 'sparkles'} /><span>${highlight(c.title, deep ? '' : dq)}</span></div>
            ${c.firstPrompt && c.firstPrompt !== c.title ? html`<div class="p">${highlight(c.firstPrompt, deep ? '' : dq)}</div>` : null}
            <div class="m"><span>${c.source === 'antigravity' ? 'Antigravity' : c.account.split('@')[0]}</span>${c.project ? html`<span>${c.project}</span>` : null}${c.prompts != null ? html`<span>${c.prompts} msj</span>` : null}${c.cost ? html`<span>${money(c.cost)}</span>` : null}<span>${ago(c.lastAt, now)}</span></div>
          </div>`;
        }) : html`<div class="muted" style="padding:12px">Nada coincide con los filtros.</div>`}
      </div>
    </aside>
    ${current ? html`<${Reader} key=${current.id} conv=${current} />`
      : html`<div class="conv-reader"><${Empty} icon="history" title="Historial de conversaciones">
          ${list ? list.length + ' conversaciones de todas tus cuentas y Antigravity. ' : ''}Elige una para leerla completa, retomarla donde quedó, exportarla o guardarla en el Baúl.<//></div>`}
  </div>`;
}
