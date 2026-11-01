// Terminals: every session open on this PC in one place. Sessions that run in their own window
// (Git Bash, Windows Terminal, VS Code) appear as mirrors: their whole conversation, live, and a
// box to write to them as if you were at their keyboard. Sessions and shells that live in the
// editor keep their real terminal (xterm.js over node-pty) next to the same chat view.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore, TOKEN, getState, setState, REMOTE } from '../api.js';
import { Btn, Icon, IconBtn, Empty, Markdown, Seg, toast, attempt, useMenu, confirmDialog, useLocal, useNow, ago, shortPath, sessionState, useAutosize } from '../ui.js';
import { navigate } from '../router.js';
import { newSession, newTerminal, resumeSession } from '../dialogs.js';
import { ToolEntry } from './history.js';

const THEME = {
  background: '#0c0c0e', foreground: '#e6e6e9', cursor: '#c2c2c7', cursorAccent: '#0c0c0e',
  selectionBackground: 'rgba(164, 151, 232, 0.32)',
  black: '#1c1c20', red: '#f27382', green: '#5ed39b', yellow: '#f0bf62', blue: '#8db1ff', magenta: '#c792ea', cyan: '#89ddff', white: '#d9d5e3',
  brightBlack: '#5f5a6e', brightRed: '#ff8f9c', brightGreen: '#7fe6b3', brightYellow: '#ffd27f', brightBlue: '#a9c4ff', brightMagenta: '#ddb2ff', brightCyan: '#a8e8ff', brightWhite: '#ffffff',
};

const MIRROR = 's.'; // route prefix for a session that lives outside the editor: /terminals/s.<id>
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;

const cache = new Map(); // terminal id -> { term, fit, ws, el, opened, exit }

export async function newShell(cwd, shell) {
  const t = await attempt(() => api.post('/api/terminals', { cwd, shell }));
  if (t) navigate('/terminals/' + t.id);
}

// A session just opened in its own window: show its mirror while it starts and registers.
export function expectSession(id, name, where) {
  setState((s) => ({ pendingSessions: (s.pendingSessions || []).filter((p) => p.id !== id).concat([{ id, name, where, at: Date.now() }]) }));
}

const KIND_ICON = { claude: 'sparkles', agy: 'orbit' };
function tabIcon(t) {
  if (KIND_ICON[t.kind]) return KIND_ICON[t.kind];
  const sh = (getState().shells || []).find((x) => x.id === t.shell);
  return sh ? sh.icon : 'terminal';
}

// Menu entries to open any kind of terminal, shared by the tab bar, files and projects.
export function terminalMenu(cwd) {
  const shells = getState().shells || [];
  const agy = getState().antigravity;
  return [
    { label: 'Sesión de Claude…', icon: 'sparkles', run: () => newSession({ cwd, agent: 'claude' }) },
    { label: 'Retomar una sesión…', icon: 'history', run: () => resumeSession() },
    agy && agy.installed ? { label: 'Sesión de Antigravity…', icon: 'orbit', run: () => newSession({ cwd, agent: 'agy' }) } : null,
    '-',
    ...shells.map((x) => ({ label: x.label, icon: x.icon, run: () => newShell(cwd, x.id) })),
    { label: 'Terminal con credenciales…', icon: 'key', run: () => newTerminal({ cwd }) },
  ];
}

// ---------- xterm ----------
function connect(c, id) {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/term/' + id + '?t=' + encodeURIComponent(TOKEN));
  c.ws = ws;
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.type === 'replay') { c.term.reset(); c.term.write(m.data); if (!m.alive) c.exit = m.exitCode; }
    else if (m.type === 'data') c.term.write(m.data);
    else if (m.type === 'exit') { c.exit = m.exitCode; c.onExit && c.onExit(); }
  };
  ws.onopen = () => { const { cols, rows } = c.term; ws.send(JSON.stringify({ type: 'resize', cols, rows })); };
}

function entry(id) {
  let c = cache.get(id);
  if (c) return c;
  const term = new window.Terminal({
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', fontSize: narrow() ? 11 : 13, lineHeight: 1.15,
    cursorBlink: true, scrollback: 8000, theme: THEME, allowProposedApi: true, macOptionIsMeta: true,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.style.height = '100%';
  c = { term, fit, el, opened: false, exit: null, ws: null };
  const send = (data) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'input', data })); };
  term.onData(send);
  term.onResize(({ cols, rows }) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  // Ctrl+C copies when there is a selection; Ctrl+V pastes text, or hands an image in the
  // OS clipboard to Claude Code (which reads it itself on Ctrl+V).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if ((e.ctrlKey || e.metaKey) && k === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); else send('\x16'); }).catch(() => send('\x16'));
      return false;
    }
    return true;
  });
  connect(c, id);
  cache.set(id, c);
  return c;
}

function drop(id) {
  const c = cache.get(id);
  if (!c) return;
  try { c.ws && c.ws.close(); } catch (e) {}
  try { c.term.dispose(); } catch (e) {}
  cache.delete(id);
}

async function resumeIn(s, where) {
  const r = s.source === 'antigravity' || s.kind === 'agy'
    ? await attempt(() => api.post('/api/agy/sessions', { conversationId: s.conversationId || s.id, cwd: s.cwd, name: s.name }))
    : await attempt(() => api.post('/api/sessions', { resumeId: s.sessionId || s.id, configDir: s.configDir, cwd: s.cwd, name: s.name, where }));
  if (!r) return null;
  if (r.terminal) navigate('/terminals/' + r.terminal.id);
  else if (r.sessionId) { expectSession(r.sessionId, s.name, where); navigate('/terminals/' + MIRROR + r.sessionId); toast(where === 'gitbash' ? 'Abriendo en Git Bash en tu PC' : 'Abriendo en Windows Terminal'); }
  return r;
}

function TermHost({ t }) {
  const host = useRef(null);
  const [exit, setExit] = useState(null);
  useEffect(() => {
    const c = entry(t.id);
    c.onExit = () => setExit(c.exit);
    setExit(c.exit);
    host.current.appendChild(c.el);
    if (!c.opened) { c.term.open(c.el); c.opened = true; }
    const doFit = () => { try { c.fit.fit(); } catch (e) {} };
    requestAnimationFrame(() => { doFit(); if (!touch()) c.term.focus(); });
    const ro = new ResizeObserver(doFit);
    ro.observe(host.current);
    return () => { ro.disconnect(); c.onExit = null; if (c.el.parentNode) c.el.parentNode.removeChild(c.el); };
  }, [t.id]);

  const resume = async () => {
    const r = await resumeIn(t, 'pty');
    if (r && r.terminal) { await api.del('/api/terminals/' + t.id); drop(t.id); }
  };
  const canResume = (t.kind === 'claude' && t.sessionId) || (t.kind === 'agy' && t.conversationId);

  return html`<div class="term-host" ref=${host}>
    ${exit != null || !t.alive ? html`<div class="term-dead">
      <${Icon} name="info" /><span>${t.kind === 'shell' ? 'La terminal terminó' : 'La sesión terminó'}${exit != null ? ' (código ' + exit + ')' : ''}.</span>
      ${canResume ? html`<${Btn} size="sm" kind="primary" icon="play" onClick=${resume}>Retomar<//>` : null}
      <${Btn} size="sm" icon="x" onClick=${() => api.del('/api/terminals/' + t.id).then(() => { drop(t.id); navigate('/terminals'); })}>Cerrar pestaña<//>
    </div>` : null}
  </div>`;
}

// ---------- the live conversation ----------
function useFeed(sessionId, fast) {
  const [view, setView] = useState({ entries: null, older: false, missing: false, error: null });
  const st = useRef(null);
  const kick = useRef(null);
  useEffect(() => {
    let stop = false;
    let timer = null;
    const s = st.current = { offset: null, entries: [], byId: new Map(), limit: 300, older: false };
    const tick = async () => {
      clearTimeout(timer);
      try {
        const url = '/api/sessions/' + encodeURIComponent(sessionId) + '/feed' + (s.offset == null ? '?limit=' + s.limit : '?from=' + s.offset);
        const d = await api.get(url);
        if (stop || st.current !== s) return;
        if ('total' in d || s.offset == null) {
          s.entries = d.entries;
          s.byId = new Map(d.entries.filter((e) => e.id).map((e) => [e.id, e]));
          s.older = !!d.older;
        } else if (d.entries.length || d.results.length) {
          for (const r of d.results) { const e = s.byId.get(r.id); if (e) Object.assign(e, { result: r.result, error: r.error }); }
          for (const e of d.entries) if (e.id) s.byId.set(e.id, e);
          s.entries = s.entries.concat(d.entries);
        }
        s.offset = d.missing ? null : d.offset;
        setView({ entries: s.entries, older: s.older, missing: !!d.missing, error: null });
      } catch (e) {
        if (!stop) setView((v) => Object.assign({}, v, { error: e.message }));
      }
      if (!stop) timer = setTimeout(tick, document.hidden ? 6000 : fast.current ? 1200 : 4000);
    };
    kick.current = tick;
    tick();
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [sessionId]);
  const loadOlder = () => { const s = st.current; s.limit += 600; s.offset = null; kick.current && kick.current(); };
  const refresh = () => kick.current && kick.current();
  return [view, loadOlder, refresh];
}

function Chat({ s, pending, onSent, live, hideTools }) {
  const fast = useRef(true);
  fast.current = !!live;
  const [feed, loadOlder, refresh] = useFeed(s.id, fast);
  const box = useRef(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const entries = feed.entries || [];
  const shown = hideTools ? entries.filter((e) => e.role !== 'tool') : entries;
  // Prompts sent from here show right away, until the transcript has them.
  const userTexts = new Set(entries.filter((e) => e.role === 'user').slice(-20).map((e) => e.text.trim()));
  const waiting = pending.filter((p) => !userTexts.has(p.text.trim()));

  const onScroll = () => {
    const el = box.current;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (pinned.current) setUnseen(false);
  };
  const toBottom = () => { const el = box.current; if (el) { el.scrollTop = el.scrollHeight; pinned.current = true; setUnseen(false); } };
  useEffect(() => { if (pinned.current) requestAnimationFrame(toBottom); else setUnseen(true); }, [entries.length, waiting.length, s.status]);
  useEffect(() => { onSent.current = () => { pinned.current = true; refresh(); }; }, []);

  if (!feed.entries && !feed.error) return html`<div class="mirror-body"><div class="row muted" style="padding:18px"><span class="spinner"></span> Leyendo la conversación…</div></div>`;
  const busy = s.alive && s.status === 'busy';
  return html`<div class="mirror-body" ref=${box} onScroll=${onScroll}>
    <div class="transcript mirror-transcript">
      ${feed.older ? html`<div><${Btn} size="sm" icon="arrow-up" onClick=${loadOlder}>Ver mensajes anteriores<//></div>` : null}
      ${feed.error && !feed.entries ? html`<${Empty} icon="alert" title="No pude leer la conversación">${feed.error}<//>` : null}
      ${feed.missing && !waiting.length ? html`<div class="muted mirror-empty">Todavía no hay mensajes. ${s.alive ? 'Escribe el primero abajo.' : ''}</div>` : null}
      ${shown.map((e) => (e.role === 'tool' ? html`<${ToolEntry} e=${e} />` : html`<div class=${'t-entry ' + e.role}>
        <div class="who">${e.role === 'user' ? 'Tú' : 'Claude'}</div>
        <div class="body">${e.role === 'user'
          ? html`<div class="user-text">${e.text}</div>${e.images ? html`<span class="chip" style="margin-top:6px"><${Icon} name="image" />${e.images} imagen${e.images > 1 ? 'es' : ''}</span>` : null}`
          : html`<${Markdown} text=${e.text} />`}</div>
      </div>`))}
      ${waiting.map((p) => html`<div class="t-entry user pending"><div class="who">Tú</div><div class="body"><div class="user-text">${p.text}</div><div class="sending">enviado · esperando a que la sesión lo muestre</div></div></div>`)}
      ${busy ? html`<div class="working"><span class="spinner"></span>Trabajando${s.crew && s.crew.task ? ' · tarea ' + s.crew.task + (s.crew.total ? ' (' + s.crew.done + '/' + s.crew.total + ')' : '') : ''}…</div>` : null}
    </div>
    ${unseen ? html`<button type="button" class="new-below" onClick=${toBottom}><${Icon} name="chevron-down" />Mensajes nuevos</button>` : null}
  </div>`;
}

// ---------- the console screen of a session outside the editor ----------
const KEYS = [
  { k: 'esc', label: 'Esc' }, { k: 'enter', label: 'Enter' }, { k: 'up', label: '↑' }, { k: 'down', label: '↓' },
  { k: 'tab', label: 'Tab' }, { k: '1', label: '1' }, { k: '2', label: '2' }, { k: '3', label: '3' },
];

function Screen({ s }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const pre = useRef(null);
  const load = () => api.get('/api/sessions/' + encodeURIComponent(s.id) + '/screen').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    let stop = false;
    let timer = null;
    const loop = async () => { await load(); if (!stop) timer = setTimeout(loop, document.hidden ? 5000 : 1200); };
    loop();
    return () => { stop = true; clearTimeout(timer); };
  }, [s.id]);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [data]);
  const press = async (k) => { const ok = await attempt(() => api.post('/api/sessions/' + encodeURIComponent(s.id) + '/keys', { keys: k })); if (ok) setTimeout(load, 250); };
  return html`<div class="mirror-body screen-wrap">
    <pre class="screen" ref=${pre}>${data ? data.lines.join('\n') : error ? '' : 'Leyendo la pantalla…'}</pre>
    ${error ? html`<div class="notice bad"><${Icon} name="alert" />${error}</div>` : null}
    <div class="keys" role="group" aria-label="Teclas">
      <span class="dim">Teclas</span>
      ${KEYS.map((x) => html`<button type="button" class="key" onClick=${() => press(x.k)}>${x.label}</button>`)}
    </div>
  </div>`;
}

// ---------- writing to the session ----------
function Composer({ s, onSent, disabled }) {
  const [text, setText] = useLocal('draft:' + s.id, '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const ta = useRef(null);
  useAutosize(ta, text);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/api/sessions/' + encodeURIComponent(s.id) + '/prompt', { text: t });
      setText('');
      onSent(t);
    } catch (e) {
      setNotice(e.message);
    }
    setBusy(false);
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch()) { e.preventDefault(); send(); }
  };
  if (disabled) return null;
  return html`<div class="composer">
    ${notice ? html`<div class="notice warn"><${Icon} name="alert" /><span>${notice}</span><${IconBtn} icon="x" size="sm" title="Cerrar" onClick=${() => setNotice(null)} /></div>` : null}
    <div class="composer-row">
      <textarea ref=${ta} class="textarea" rows="1" value=${text} placeholder=${'Escribe a ' + s.name + '…'} onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey} enterkeyhint=${touch() ? 'enter' : 'send'}></textarea>
      <${Btn} kind="primary" icon="send" busy=${busy} disabled=${!text.trim()} onClick=${send} title="Enviar">${narrow() ? '' : 'Enviar'}<//>
    </div>
    ${!touch() ? html`<div class="composer-hint dim">Enter envía · Shift+Enter nueva línea · Llega a la sesión como si lo escribieras en su teclado.</div>` : null}
  </div>`;
}

// ---------- one session: chat + terminal or screen ----------
function placeLabel(s, t) {
  if (t) return 'En el editor';
  return 'Ventana en el PC';
}

function SessionPane({ sessionId, t }) {
  const s0 = useStore((x) => x.sessions.find((v) => v.id === sessionId));
  const pendingStart = useStore((x) => (x.pendingSessions || []).find((p) => p.id === sessionId));
  const now = useNow(5000);
  const [openMenu, menu] = useMenu();
  const [mode, setMode] = useLocal(t ? 'termPaneMode' : 'mirrorPaneMode', t ? (narrow() ? 'chat' : 'terminal') : 'chat');
  const [sent, setSent] = useState([]);
  const [hideTools, setHideTools] = useLocal('mirrorHideTools', false);
  const onSent = useRef(null);
  const s = s0 || (t ? { id: sessionId, name: t.name, alive: t.alive, status: 'idle', cwd: t.cwd, configDir: t.configDir } : pendingStart ? { id: sessionId, name: pendingStart.name, alive: false, status: 'starting', cwd: null } : null);
  const starting = !s0 && pendingStart && now - pendingStart.at < 90000;
  const alive = s0 ? s0.alive : t ? t.alive : false;
  const st = s0 ? sessionState(s0) : starting ? { cls: 'idle', label: 'Abriendo…' } : { cls: 'off', label: alive ? 'Activa' : 'Cerrada' };
  const canScreen = !t && s0 && s0.alive && s0.pid && getState().me && getState().me.platform === 'win32';
  const tabs = t ? [{ value: 'chat', label: 'Chat', icon: 'message' }, { value: 'terminal', label: 'Terminal', icon: 'terminal' }]
    : canScreen ? [{ value: 'chat', label: 'Chat', icon: 'message' }, { value: 'screen', label: 'Pantalla', icon: 'monitor' }] : null;
  const current = tabs && tabs.some((x) => x.value === mode) ? mode : 'chat';

  useEffect(() => { setSent([]); }, [sessionId]);
  const afterSend = (text) => { setSent((list) => list.concat([{ text, at: Date.now() }]).slice(-5)); if (onSent.current) onSent.current(); };
  const back = () => navigate('/terminals');

  if (!s) {
    return html`<div class="term-main"><div class="mirror-head"><${IconBtn} icon="arrow-left" title="Volver" onClick=${back} /><b>Sesión no encontrada</b></div>
      <${Empty} icon="terminal" title="Esta sesión ya no está abierta">Búscala en Historial para retomarla.<//></div>`;
  }
  const isClaude = !t || t.kind === 'claude';
  const closeTerm = async () => {
    if (!(await confirmDialog({ title: 'Cerrar ' + s.name, text: 'Se termina el proceso de la sesión. La conversación queda guardada y puedes retomarla.', confirm: 'Cerrar', danger: true }))) return;
    await attempt(() => api.del('/api/terminals/' + t.id));
    drop(t.id);
    navigate('/terminals');
  };
  const more = (e) => openMenu(e, [
    current === 'chat' && isClaude ? { label: hideTools ? 'Mostrar herramientas' : 'Ocultar herramientas', icon: hideTools ? 'eye' : 'eye-off', run: () => setHideTools(!hideTools) } : null,
    { label: 'Historial completo', icon: 'history', run: () => navigate('/history/' + encodeURIComponent(s.id)) },
    s.cwd ? { label: 'Ver su carpeta', icon: 'folder-open', run: () => navigate('/files?path=' + encodeURIComponent(s.cwd)) } : null,
    { label: 'Copiar ID', icon: 'copy', run: () => navigator.clipboard.writeText(s.id).then(() => toast('ID copiado')) },
    !alive && !t && s0 ? { label: 'Retomar en el editor', icon: 'terminal', run: () => resumeIn(s0, 'pty') } : null,
    !alive && !t && s0 ? { label: 'Retomar en Git Bash', icon: 'git', run: () => resumeIn(s0, 'gitbash') } : null,
    t ? '-' : null,
    t ? { label: 'Cerrar sesión del editor', icon: 'x', run: closeTerm } : null,
  ]);

  return html`<div class="term-main">
    <div class="mirror-head">
      <span class="back"><${IconBtn} icon="arrow-left" title="Volver a la lista" onClick=${back} /></span>
      <span class=${'dot ' + (starting ? 'idle' : st.cls)}></span>
      <div class="grow" style="min-width:0">
        <div class="name ellipsis">${s.name}</div>
        <div class="sub ellipsis">${st.label}${s0 && s0.updatedAt && st.cls !== 'busy' && alive ? ' · ' + ago(s0.updatedAt, now) : ''} · ${placeLabel(s, t)}${s.cwd ? ' · ' + shortPath(s.cwd) : ''}${s0 && s0.account ? ' · ' + s0.account.split('@')[0] : ''}</div>
      </div>
      ${tabs ? html`<${Seg} value=${current} onChange=${setMode} options=${tabs} />` : null}
      <${IconBtn} icon="more" title="Más" onClick=${more} />
    </div>
    ${starting ? html`<div class="notice info"><span class="spinner"></span><span>Abriendo la sesión ${pendingStart.where === 'gitbash' ? 'en una ventana de Git Bash' : 'en Windows Terminal'} en tu PC. Si es una carpeta nueva, Claude pregunta si confías en ella: respóndelo en la ventana o en «Pantalla».</span></div>` : null}
    ${t && current === 'terminal' ? html`<${TermHost} key=${t.id} t=${t} />`
      : current === 'screen' ? html`<${Screen} key=${s.id} s=${s0} />`
      : isClaude ? html`<${Chat} key=${s.id} s=${s} pending=${sent} onSent=${onSent} hideTools=${hideTools} live=${alive && s.status === 'busy' || sent.length > 0} />`
      : html`<${Empty} icon="orbit" title="Sin vista de chat">Para Antigravity usa la pestaña Terminal.<//>`}
    ${current !== 'terminal' && isClaude ? html`<${Composer} key=${s.id} s=${s} onSent=${afterSend} disabled=${!alive} />` : null}
    ${!alive && !starting && !t ? html`<div class="notice"><${Icon} name="info" /><span>La sesión se cerró.</span>
      ${s0 && s0.configPath ? html`<${Btn} size="sm" kind="primary" icon="play" onClick=${() => resumeIn(s0, 'pty')}>Retomar aquí<//><${Btn} size="sm" icon="git" onClick=${() => resumeIn(s0, 'gitbash')}>En Git Bash<//>` : null}</div>` : null}
    ${menu}
  </div>`;
}

function ShellPane({ t }) {
  const [openMenu, menu] = useMenu();
  const close = async () => {
    if (t.alive && !(await confirmDialog({ title: 'Cerrar ' + t.name, text: 'Se termina el proceso de la terminal.', confirm: 'Cerrar', danger: true }))) return;
    await attempt(() => api.del('/api/terminals/' + t.id));
    drop(t.id);
    navigate('/terminals');
  };
  return html`<div class="term-main">
    <div class="mirror-head">
      <span class="back"><${IconBtn} icon="arrow-left" title="Volver a la lista" onClick=${() => navigate('/terminals')} /></span>
      <span class=${'dot ' + (t.alive ? 'idle' : 'off')}></span>
      <div class="grow" style="min-width:0"><div class="name ellipsis">${t.name}</div><div class="sub ellipsis">${t.alive ? 'Terminal' : 'Terminó'} · ${shortPath(t.cwd)}${t.env && t.env.length ? ' · variables: ' + t.env.join(', ') : ''}</div></div>
      ${!narrow() ? html`<span class="dim mono" style="font-size:11.5px" title="Ctrl+C copia la selección · Ctrl+V pega texto o una imagen del portapapeles">Ctrl+C copia · Ctrl+V pega</span>` : null}
      <${IconBtn} icon="more" title="Más" onClick=${(e) => openMenu(e, [
        { label: 'Ver su carpeta', icon: 'folder-open', run: () => navigate('/files?path=' + encodeURIComponent(t.cwd)) },
        { label: 'Cerrar terminal', icon: 'x', run: close },
      ])} />
    </div>
    <${TermHost} key=${t.id} t=${t} />
    ${menu}
  </div>`;
}

// ---------- the list ----------
function SideItem({ on, dot, icon, name, sub, badge, onClick, onDbl, title }) {
  return html`<button type="button" class=${'side-item' + (on ? ' on' : '')} onClick=${onClick} onDblClick=${onDbl} title=${title || ''}>
    <span class=${'dot ' + dot}></span>
    <${Icon} name=${icon} />
    <span class="txt"><span class="n ellipsis">${name}</span>${sub ? html`<span class="s ellipsis">${sub}</span>` : null}</span>
    ${badge ? html`<span class="chip accent">${badge}</span>` : null}
  </button>`;
}

export function Terminals({ route }) {
  const terms = useStore((s) => s.terminals);
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pendingSessions || []);
  const me = useStore((s) => s.me);
  const [openMenu, menu] = useMenu();
  const now = useNow(10000);

  // Sessions open on this PC outside the editor (Git Bash, Windows Terminal, VS Code...).
  const outside = useMemo(() => sessions.filter((s) => s.alive && s.source === 'claude' && !s.terminalId)
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })), [sessions]);
  const starting = pending.filter((p) => now - p.at < 90000 && !sessions.some((s) => s.id === p.id && s.alive));

  const param = route.param || '';
  const mirrorId = param.startsWith(MIRROR) ? param.slice(MIRROR.length) : null;
  const term = mirrorId ? null : terms.find((t) => t.id === param) || null;
  // A mirrored session that moves into an editor terminal (resumed there) follows it.
  const hosted = mirrorId ? terms.find((t) => t.sessionId === mirrorId && t.alive) : null;
  useEffect(() => { if (hosted) navigate('/terminals/' + hosted.id); }, [hosted && hosted.id]);

  // Desktop opens something right away; the phone starts on the list.
  useEffect(() => {
    if (param || narrow()) return;
    if (outside.length) navigate('/terminals/' + MIRROR + outside[0].id);
    else if (terms.length) navigate('/terminals/' + terms[terms.length - 1].id);
  }, [param, outside.length, terms.length]);
  useEffect(() => { for (const id of cache.keys()) if (!terms.some((t) => t.id === id)) drop(id); }, [terms]);

  const plus = (e) => openMenu(e, terminalMenu(term ? term.cwd : undefined));
  const hasCurrent = !!(mirrorId || term);
  // Like a chat list: the last thing said, or where it works when nothing was said yet.
  const preview = (s) => {
    const last = s.last && (s.last.assistant || s.last.user);
    if (last && last.text) return last.text.replace(/\s+/g, ' ').slice(0, 90);
    return (s.crew && s.crew.title) || shortPath(s.cwd || '') || (s.account || '').split('@')[0];
  };
  const statusOf = (s) => sessionState(s);

  const side = html`<aside class="term-side">
    <div class="side-head">
      <b>Sesiones</b><span class="grow"></span>
      <${IconBtn} icon="history" title="Retomar una sesión" onClick=${() => resumeSession()} />
      <${IconBtn} icon="plus" title="Nueva sesión o terminal" onClick=${plus} />
    </div>
    <div class="side-group">En este PC <span class="dim">${outside.length + starting.length}</span></div>
    ${outside.map((s) => html`<${SideItem} key=${s.id} on=${mirrorId === s.id} dot=${statusOf(s).cls} icon="monitor" name=${s.name}
      sub=${statusOf(s).label + ' · ' + preview(s)}
      badge=${s.unread || null} onClick=${() => navigate('/terminals/' + MIRROR + s.id)} title=${s.cwd || ''} />`)}
    ${starting.map((p) => html`<${SideItem} key=${p.id} on=${mirrorId === p.id} dot="idle" icon="monitor" name=${p.name} sub="Abriendo…" onClick=${() => navigate('/terminals/' + MIRROR + p.id)} />`)}
    ${!outside.length && !starting.length ? html`<div class="side-empty">Las sesiones que abras en Git Bash, Windows Terminal o VS Code aparecen aquí.</div>` : null}
    <div class="side-group">En el editor <span class="dim">${terms.length}</span></div>
    ${terms.map((t) => {
      const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : null;
      const dot = !t.alive ? 'off' : s ? statusOf(s).cls : t.kind === 'shell' ? 'idle' : 'busy';
      return html`<${SideItem} key=${t.id} on=${term && term.id === t.id} dot=${dot} icon=${tabIcon(t)} name=${t.name}
        sub=${(t.alive ? (s ? statusOf(s).label : t.kind === 'shell' ? 'Terminal' : 'Activa') : 'Terminó') + ' · ' + (shortPath(t.cwd).split(/[\\/]/).pop() || '')}
        onClick=${() => navigate('/terminals/' + t.id)} title=${t.cwd} />`;
    })}
    ${!terms.length ? html`<div class="side-empty">Sesiones y terminales que viven dentro del editor.</div>` : null}
    <div class="side-actions">
      <${Btn} kind="primary" icon="sparkles" onClick=${() => newSession({ agent: 'claude' })}>Nueva sesión<//>
      ${(getState().shells || []).filter((x) => x.id === 'gitbash').map((x) => html`<${Btn} icon=${x.icon} onClick=${() => newShell(undefined, x.id)}>Git Bash<//>`)}
    </div>
  </aside>`;

  let main;
  if (mirrorId) main = html`<${SessionPane} key=${'m' + mirrorId} sessionId=${mirrorId} t=${null} />`;
  else if (term && (term.kind === 'claude' || term.kind === 'agy') && term.sessionId) main = html`<${SessionPane} key=${'t' + term.id} sessionId=${term.kind === 'agy' ? term.conversationId || term.sessionId : term.sessionId} t=${term} />`;
  else if (term) main = html`<${ShellPane} key=${term.id} t=${term} />`;
  else if (me && !me.pty && !outside.length) {
    main = html`<div class="term-main"><${Empty} icon="terminal" title="Terminales integradas no disponibles"
      action=${html`<${Btn} kind="primary" icon="plus" onClick=${() => newSession()}>Nueva sesión<//>`}>
      node-pty no pudo cargarse en este equipo. Las sesiones se abren en Git Bash o Windows Terminal y aparecen aquí como espejo.<//></div>`;
  } else {
    main = html`<div class="term-main"><${Empty} icon="terminal" title="Elige una sesión"
      action=${html`<div class="row wrap" style="justify-content:center"><${Btn} kind="primary" icon="sparkles" onClick=${() => newSession({ agent: 'claude' })}>Nueva sesión<//><${Btn} icon="history" onClick=${() => resumeSession()}>Retomar una<//></div>`}>
      Las sesiones abiertas en este PC aparecen a la izquierda: lee su conversación en vivo y escríbeles${REMOTE ? ' desde este dispositivo' : ''}.<//></div>`;
  }

  return html`<div class=${'term-layout' + (hasCurrent ? ' has-current' : '')}>
    ${side}
    ${main}
    ${menu}
  </div>`;
}
