// Embedded terminals (xterm.js over node-pty). Claude sessions here are real interactive
// sessions, cockpit included. Terminals survive view changes; they live as long as the hub.
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { api, useStore, TOKEN, getState } from '../api.js';
import { Btn, Icon, IconBtn, Empty, toast, attempt, useMenu, confirmDialog } from '../ui.js';
import { navigate } from '../router.js';
import { newSession } from '../dialogs.js';

const THEME = {
  background: '#0e0c14', foreground: '#e9e6f2', cursor: '#a78bfa', cursorAccent: '#0e0c14',
  selectionBackground: 'rgba(167, 139, 250, 0.35)',
  black: '#1b1924', red: '#f27382', green: '#5ed39b', yellow: '#f0bf62', blue: '#8db1ff', magenta: '#c792ea', cyan: '#89ddff', white: '#d9d5e3',
  brightBlack: '#5f5a6e', brightRed: '#ff8f9c', brightGreen: '#7fe6b3', brightYellow: '#ffd27f', brightBlue: '#a9c4ff', brightMagenta: '#ddb2ff', brightCyan: '#a8e8ff', brightWhite: '#ffffff',
};

const cache = new Map(); // terminal id -> { term, fit, ws, el, opened, exit }

export async function newShell(cwd) {
  const t = await attempt(() => api.post('/api/terminals', { cwd }));
  if (t) navigate('/terminals/' + t.id);
}

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
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.15,
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
    requestAnimationFrame(() => { doFit(); c.term.focus(); });
    const ro = new ResizeObserver(doFit);
    ro.observe(host.current);
    return () => { ro.disconnect(); c.onExit = null; if (c.el.parentNode) c.el.parentNode.removeChild(c.el); };
  }, [t.id]);

  const resume = async () => {
    const s = getState().sessions.find((x) => x.id === t.sessionId);
    const r = await attempt(() => api.post('/api/sessions', { resumeId: t.sessionId, configDir: t.configDir, cwd: t.cwd, name: t.name, where: 'pty' }));
    if (r && r.terminal) { await api.del('/api/terminals/' + t.id); drop(t.id); navigate('/terminals/' + r.terminal.id); }
    return s;
  };

  return html`<div class="term-host" ref=${host}>
    ${exit != null || !t.alive ? html`<div class="term-dead">
      <${Icon} name="info" /><span>${t.kind === 'claude' ? 'La sesión terminó' : 'La terminal terminó'}${exit != null ? ' (código ' + exit + ')' : ''}.</span>
      ${t.kind === 'claude' && t.sessionId ? html`<${Btn} size="sm" kind="primary" icon="play" onClick=${resume}>Retomar<//>` : null}
      <${Btn} size="sm" icon="x" onClick=${() => api.del('/api/terminals/' + t.id).then(() => { drop(t.id); navigate('/terminals'); })}>Cerrar pestaña<//>
    </div>` : null}
  </div>`;
}

export function Terminals({ route }) {
  const terms = useStore((s) => s.terminals);
  const me = useStore((s) => s.me);
  const [openMenu, menu] = useMenu();
  const current = terms.find((t) => t.id === route.param) || null;

  useEffect(() => {
    if (!route.param && terms.length) navigate('/terminals/' + terms[terms.length - 1].id);
  }, [route.param, terms.length]);
  useEffect(() => {
    for (const id of cache.keys()) if (!terms.some((t) => t.id === id)) drop(id);
  }, [terms]);

  const close = async (t, e) => {
    e.stopPropagation();
    if (t.alive && !(await confirmDialog({ title: 'Cerrar ' + t.name, text: t.kind === 'claude' ? 'Se termina el proceso de Claude. La conversación queda guardada y puedes retomarla desde Sesiones.' : 'Se termina el proceso de la terminal.', confirm: 'Cerrar', danger: true }))) return;
    await attempt(() => api.del('/api/terminals/' + t.id));
    drop(t.id);
    const rest = terms.filter((x) => x.id !== t.id);
    navigate(rest.length ? '/terminals/' + rest[rest.length - 1].id : '/terminals');
  };

  if (me && !me.pty) {
    return html`<div class="page"><${Empty} icon="terminal" title="Terminales integradas no disponibles"
      action=${html`<${Btn} kind="primary" icon="external" onClick=${() => newSession()}>Abrir en Windows Terminal<//>`}>
      node-pty no pudo cargarse en este equipo. Las sesiones se abrirán en Windows Terminal y seguirán apareciendo en Bridge.<//></div>`;
  }

  const plus = (e) => openMenu(e, [
    { label: 'Sesión de Claude…', icon: 'sparkles', run: () => newSession() },
    { label: 'PowerShell', icon: 'terminal', run: () => newShell() },
  ]);

  return html`<div class="term-layout">
    <div class="term-tabs" role="tablist">
      ${terms.map((t) => html`<div role="tab" class=${'term-tab' + (current && current.id === t.id ? ' on' : '')} onClick=${() => navigate('/terminals/' + t.id)} title=${t.cwd}>
        <span class=${'dot ' + (t.alive ? (t.kind === 'claude' ? 'idle' : 'busy') : 'off')}></span>
        <${Icon} name=${t.kind === 'claude' ? 'sparkles' : 'terminal'} />${t.name}
        <${IconBtn} icon="x" size="sm" title="Cerrar" onClick=${(e) => close(t, e)} />
      </div>`)}
      <${IconBtn} icon="plus" title="Nueva terminal" onClick=${plus} />
      <span class="grow"></span>
      ${current ? html`<span class="dim mono" style="font-size:11.5px;padding:0 8px" title="Ctrl+C copia la selección · Ctrl+V pega texto o una imagen del portapapeles">Ctrl+C copia · Ctrl+V pega (también imágenes)</span>` : null}
    </div>
    ${current ? html`<${TermHost} key=${current.id} t=${current} />`
      : html`<div class="page"><${Empty} icon="terminal" title="Sin terminales abiertas"
          action=${html`<div class="row"><${Btn} kind="primary" icon="sparkles" onClick=${() => newSession()}>Sesión de Claude<//><${Btn} icon="terminal" onClick=${() => newShell()}>PowerShell<//></div>`}>
          Las sesiones que abres aquí son de Claude Code de verdad, con tu cockpit, y Bridge puede despertarlas cuando les llega un mensaje.<//></div>`}
    ${menu}
  </div>`;
}
