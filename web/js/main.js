// Agentic Bridge — app shell: rail, top bar, command palette, overlays, toasts.
import { html, render, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { boot, useStore, api, getState, setState } from './api.js';
import { Icon, IconBtn, Btn, useLocal, toast, attempt } from './ui.js';
import { useRoute, navigate } from './router.js';
import { newSession, newRoom, openSettings, newTerminal } from './dialogs.js';
import { Home } from './views/home.js';
import { Sessions } from './views/sessions.js';
import { Rooms } from './views/rooms.js';
import { Terminals, newShell } from './views/terminals.js';
import { Files } from './views/files.js';
import { Projects, newProject } from './views/projects.js';
import { Team } from './views/team.js';
import { Metrics } from './views/metrics.js';
import { Vault } from './views/vault.js';
import { History } from './views/history.js';
import { Boards, newBoard } from './views/boards.js';
import { Accounts, editSecret } from './views/accounts.js';

const NAV = [
  { group: 'Espacio' },
  { id: 'home', label: 'Inicio', icon: 'home', title: 'Centro de mando' },
  { id: 'sessions', label: 'Sesiones', icon: 'sessions', title: 'Sesiones', count: (s) => s.sessions.filter((x) => x.alive).length },
  { id: 'rooms', label: 'Salas', icon: 'rooms', title: 'Salas', count: (s) => s.rooms.length, hot: (s) => Object.values(s.activity).some((a) => Object.keys(a).length) },
  { id: 'terminals', label: 'Terminales', icon: 'terminal', title: 'Terminales', count: (s) => s.terminals.filter((t) => t.alive).length || null },
  { id: 'history', label: 'Historial', icon: 'history', title: 'Historial de conversaciones' },
  { group: 'Trabajo' },
  { id: 'projects', label: 'Proyectos', icon: 'kanban', title: 'Proyectos', count: (s) => s.projects.length || null },
  { id: 'boards', label: 'Pizarras', icon: 'board', title: 'Pizarras', count: (s) => s.boards.filter((b) => b.kind === 'free').length || null },
  { id: 'files', label: 'Archivos', icon: 'folder', title: 'Archivos' },
  { id: 'team', label: 'Equipo', icon: 'team', title: 'Equipo de agentes' },
  { id: 'vault', label: 'Baúl', icon: 'book', title: 'Baúl compartido', count: (s) => s.vault.length || null },
  { group: 'Conexiones' },
  { id: 'accounts', label: 'Cuentas', icon: 'key', title: 'Cuentas y credenciales', count: (s) => s.connections.filter((c) => c.state === 'connected').length || null },
  { id: 'metrics', label: 'Métricas', icon: 'chart', title: 'Métricas y suscripciones' },
];

const VIEWS = { home: Home, sessions: Sessions, rooms: Rooms, terminals: Terminals, history: History, files: Files, projects: Projects, boards: Boards, team: Team, vault: Vault, accounts: Accounts, metrics: Metrics };
const FIXED = new Set(['rooms', 'terminals', 'files', 'history']);

function Rail({ route, collapsed, setCollapsed }) {
  const s = useStore((x) => x);
  return html`<nav class="rail" aria-label="Navegación">
    <a class="brand" href="#/home" style="text-decoration:none;color:inherit">
      <img src="/logo.svg" alt="" />
      <div class="word"><b>agentic<span>/</span>bridge</b><span class="tag">WEB4 EDITOR</span></div>
    </a>
    <div class="nav">
      ${NAV.map((n) => (n.group
        ? html`<div class="nav-label">${n.group}</div>`
        : html`<a href=${'#/' + n.id} class=${route.view === n.id ? 'active' : ''} title=${n.label}>
            <${Icon} name=${n.icon} /><span>${n.label}</span>
            ${n.count && n.count(s) != null ? html`<span class=${'count' + (n.hot && n.hot(s) ? ' hot' : '')}>${n.hot && n.hot(s) ? '● ' : ''}${n.count(s)}</span>` : null}
          </a>`))}
    </div>
    <div class="rail-foot nav">
      <a href="javascript:void 0" onClick=${openSettings} title="Ajustes"><${Icon} name="settings" /><span class="label">Ajustes</span></a>
      <a href="javascript:void 0" onClick=${() => setCollapsed(!collapsed)} title=${collapsed ? 'Expandir' : 'Contraer'}><${Icon} name="sidebar" /><span class="label">${collapsed ? 'Expandir' : 'Contraer'}</span></a>
    </div>
  </nav>`;
}

// ---------- command palette ----------
function fuzzy(q, text) {
  if (!q) return true;
  text = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) { i = text.indexOf(ch, i); if (i === -1) return false; i++; }
  return true;
}

function Palette({ onClose }) {
  const s = useStore((x) => x);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  useEffect(() => { input.current && input.current.focus(); }, []);

  const items = useMemo(() => {
    const out = [];
    const add = (group, label, icon, run, kind) => out.push({ group, label, icon, run, kind });
    add('Acciones', 'Nueva sesión de Claude', 'sparkles', () => newSession({ agent: 'claude' }), 'acción');
    if (s.antigravity && s.antigravity.installed) add('Acciones', 'Nueva sesión de Antigravity', 'orbit', () => newSession({ agent: 'agy' }), 'acción');
    add('Acciones', 'Nueva sala de chat', 'rooms', () => newRoom(), 'acción');
    add('Acciones', 'Nuevo proyecto (modo todo.md)', 'kanban', () => { navigate('/projects'); setTimeout(newProject, 50); }, 'acción');
    add('Acciones', 'Nueva pizarra (Excalidraw)', 'board', () => newBoard(), 'acción');
    for (const sh of s.shells) add('Acciones', 'Abrir ' + sh.label, sh.icon, () => newShell(undefined, sh.id), 'terminal');
    add('Acciones', 'Terminal con credenciales', 'key', () => newTerminal({}), 'acción');
    add('Acciones', 'Guardar una credencial', 'lock', () => { navigate('/accounts'); setTimeout(() => editSecret(null), 50); }, 'acción');
    add('Acciones', 'Buscar en el historial', 'history', () => navigate('/history'), 'acción');
    for (const f of s.prefs.favorites || []) add('Favoritas', f.label, 'star', () => navigate('/files?path=' + encodeURIComponent(f.path)), 'carpeta');
    for (const b of s.boards) add('Pizarras', b.name, b.kind === 'project' ? 'kanban' : 'board', () => navigate(b.kind === 'project' ? '/projects/' + b.projectId + '?tab=board' : '/boards/' + encodeURIComponent(b.ref)), b.kind === 'project' ? 'proyecto' : 'pizarra');
    add('Acciones', 'Guardar algo en el Baúl', 'book', () => navigate('/vault'), 'acción');
    for (const n of s.vault.slice(0, 30)) add('Baúl', n.title, 'book', () => navigate('/vault'), n.tags.map((t) => '#' + t).join(' ') || 'nota');
    add('Acciones', 'Conectar cuentas a Bridge', 'plug', () => attempt(() => api.post('/api/integration/connect'), 'Cuentas conectadas'), 'acción');
    add('Acciones', 'Ajustes', 'settings', openSettings, 'acción');
    for (const n of NAV) if (n.id) add('Ir a', n.label, n.icon, () => navigate('/' + n.id), 'vista');
    for (const x of s.sessions.filter((v) => v.alive)) add('Sesiones', x.name, 'sessions', () => navigate('/sessions/' + x.id), x.account || x.source);
    for (const r of s.rooms) add('Salas', r.name, 'hash', () => navigate('/rooms/' + r.id), r.members.length + ' miembros');
    for (const p of s.projects) add('Proyectos', p.name, 'kanban', () => navigate('/projects/' + p.id), 'proyecto');
    for (const t of s.terminals) add('Terminales', t.name, 'terminal', () => navigate('/terminals/' + t.id), t.alive ? 'viva' : 'cerrada');
    return out.filter((it) => fuzzy(q, it.label + ' ' + it.group));
  }, [q, s.sessions, s.rooms, s.projects, s.terminals, s.boards, s.prefs]);

  useEffect(() => setSel(0), [q]);
  const run = (it) => { onClose(); it.run(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(items.length - 1, sel + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)); }
    else if (e.key === 'Enter' && items[sel]) run(items[sel]);
    else if (e.key === 'Escape') onClose();
  };
  let lastGroup = null;
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="palette" role="dialog" aria-label="Paleta de comandos">
      <div class="with-icon"><${Icon} name="search" /><input ref=${input} class="input" value=${q} placeholder="Busca sesiones, salas, proyectos o acciones…" onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} /></div>
      <ul>
        ${items.length ? items.slice(0, 60).map((it, i) => {
          const head = it.group !== lastGroup ? html`<div class="group">${it.group}</div>` : null;
          lastGroup = it.group;
          return html`${head}<li class=${i === sel ? 'on' : ''} onMouseEnter=${() => setSel(i)} onClick=${() => run(it)}><${Icon} name=${it.icon} />${it.label}<span class="kind">${it.kind}</span></li>`;
        }) : html`<li style="cursor:default">Sin resultados para “${q}”</li>`}
      </ul>
    </div>
  </div>`;
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((t) => html`<div class=${'toast ' + t.tone}><${Icon} name=${t.tone === 'bad' ? 'alert' : t.tone === 'info' ? 'info' : 'check'} /><span>${t.text}</span></div>`)}
  </div>`;
}

function Overlay() {
  const overlay = useStore((s) => s.overlay);
  return overlay ? overlay.render() : null;
}

function App() {
  const route = useRoute();
  const connected = useStore((s) => s.connected);
  const [collapsed, setCollapsed] = useLocal('railCollapsed', false);
  const [palette, setPalette] = useState(false);
  const nav = NAV.find((n) => n.id === route.view) || NAV[1];
  const View = VIEWS[route.view] || Home;

  useEffect(() => {
    const onKey = (e) => {
      // Excalidraw uses Ctrl+K for links; leave it alone inside a board.
      if (e.target && e.target.closest && e.target.closest('.excalidraw')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { document.title = nav.label + ' · Agentic Bridge'; }, [nav]);
  // A dialog left open does not follow you to another view.
  useEffect(() => { if (getState().overlay) setState({ overlay: null }); }, [route.view, route.param]);

  return html`<div class=${'app' + (collapsed ? ' collapsed' : '')}>
    <${Rail} route=${route} collapsed=${collapsed} setCollapsed=${setCollapsed} />
    <main class="main">
      <header class="topbar">
        <h1>${nav.title}</h1>
        <button type="button" class="search-trigger" onClick=${() => setPalette(true)} aria-label="Buscar (Ctrl+K)">
          <${Icon} name="search" /><span>Buscar o ejecutar…</span><kbd>Ctrl K</kbd>
        </button>
        <span class="conn" title=${connected ? 'Conectado al hub' : 'Reconectando con el hub…'}>
          <span class=${'dot ' + (connected ? 'busy' : 'bad')}></span>${connected ? 'En vivo' : 'Reconectando'}
        </span>
        <${Btn} kind="primary" icon="plus" onClick=${() => newSession()}>Nueva sesión<//>
      </header>
      <section class=${'view' + (FIXED.has(route.view) ? ' fixed' : '')}>
        <${View} route=${route} />
      </section>
    </main>
    ${palette ? html`<${Palette} onClose=${() => setPalette(false)} />` : null}
    <${Overlay} />
    <${Toasts} />
  </div>`;
}

boot()
  .then(() => render(html`<${App} />`, document.getElementById('app')))
  .catch((e) => {
    document.getElementById('app').innerHTML = '<div class="boot"><img src="/logo.svg" width="44" height="44" alt=""><b>No pude conectar con el hub</b><span>' + String(e.message).replace(/[<>&]/g, '') + '</span></div>';
  });
