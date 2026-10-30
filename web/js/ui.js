// Shared UI primitives and formatting helpers.
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { ICONS } from './icons.js';
import { getState, setState } from './api.js';
import { renderMarkdown } from './md.js';

export { html };

export function Icon({ name, cls }) {
  return html`<svg class=${'i ' + (cls || '')} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] || ICONS.info }}></svg>`;
}

export function Btn({ icon, children, kind, size, onClick, disabled, title, type, busy }) {
  const cls = ['btn', kind, size].filter(Boolean).join(' ');
  return html`<button type=${type || 'button'} class=${cls} onClick=${onClick} disabled=${disabled || busy} title=${title}>
    ${busy ? html`<span class="spinner"></span>` : icon ? html`<${Icon} name=${icon} />` : null}${children}
  </button>`;
}

export function IconBtn({ icon, onClick, title, size, on, disabled }) {
  return html`<button type="button" class=${'icon-btn ' + (size || '') + (on ? ' on' : '')} onClick=${onClick} title=${title} aria-label=${title} disabled=${disabled}><${Icon} name=${icon} /></button>`;
}

export function Empty({ icon, title, children, action }) {
  return html`<div class="empty">
    <div class="ic"><${Icon} name=${icon || 'sparkles'} /></div>
    <h3>${title}</h3>
    ${children ? html`<p>${children}</p>` : null}
    ${action || null}
  </div>`;
}

export function Markdown({ text, cls }) {
  return html`<div class=${'md ' + (cls || '')} dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}></div>`;
}

export function Avatar({ emoji, color, name, size, status }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return html`<div class=${'avatar ' + (size || '')} style=${{ background: color || 'var(--surface-3)' }}>
    ${emoji || initial}${status ? html`<span class=${'dot st ' + status}></span>` : null}
  </div>`;
}

export function Switch({ checked, onChange, label }) {
  return html`<label class="row" style="cursor:pointer">
    <span class="switch"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} /><span></span></span>
    ${label ? html`<span>${label}</span>` : null}
  </label>`;
}

export function Seg({ value, options, onChange }) {
  return html`<div class="seg" role="tablist">
    ${options.map((o) => html`<button type="button" class=${o.value === value ? 'on' : ''} onClick=${() => onChange(o.value)}>
      ${o.icon ? html`<${Icon} name=${o.icon} />` : null}${o.label}${o.count != null ? html`<span class="n">${o.count}</span>` : null}
    </button>`)}
  </div>`;
}

export function Field({ label, hint, children }) {
  return html`<div class="field">${label ? html`<label>${label}</label>` : null}${children}${hint ? html`<div class="hint">${hint}</div>` : null}</div>`;
}

export function Bar({ value, tone, width }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const t = tone || (pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : '');
  return html`<div class=${'bar ' + t} style=${{ width: width || '100%' }}><i style=${{ width: pct + '%' }}></i></div>`;
}

export function TagInput({ values, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange(values.concat([v]));
    setDraft('');
  };
  return html`<div class="tag-input">
    ${values.map((v) => html`<span class="chip mono">${v}<button type="button" onClick=${() => onChange(values.filter((x) => x !== v))} aria-label="Quitar"><${Icon} name="x" /></button></span>`)}
    <input value=${draft} placeholder=${placeholder} onInput=${(e) => setDraft(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1)); }}
      onBlur=${add} />
  </div>`;
}

export function CopyBtn({ text, label, size }) {
  const [done, setDone] = useState(false);
  const copy = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); setDone(true); setTimeout(() => setDone(false), 1200); }
    catch (err) { toast('No se pudo copiar', 'bad'); }
  };
  if (!label) return html`<${IconBtn} icon=${done ? 'check' : 'copy'} size=${size || 'sm'} title="Copiar" onClick=${copy} />`;
  return html`<${Btn} icon=${done ? 'check' : 'copy'} size=${size || 'sm'} onClick=${copy}>${done ? 'Copiado' : label}<//>`;
}

// ---------- overlays ----------
export function openModal(render, kind) { setState({ overlay: { render, kind: kind || 'modal' } }); }
export function closeModal() { setState({ overlay: null }); }

export function Modal({ title, subtitle, children, footer, wide, onClose, steps, step }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (onClose || closeModal)(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) (onClose || closeModal)(); }}>
    <div class=${'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label=${title}>
      ${steps ? html`<div class="steps" style="padding-top:14px">${Array.from({ length: steps }, (_, i) => html`<span class=${i <= step ? 'on' : ''}></span>`)}</div>` : null}
      <div class="modal-head">
        <div class="grow"><h3>${title}</h3>${subtitle ? html`<p>${subtitle}</p>` : null}</div>
        <${IconBtn} icon="x" title="Cerrar" onClick=${onClose || closeModal} />
      </div>
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-foot">${footer}</div>` : null}
    </div>
  </div>`;
}

export function Drawer({ children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (onClose || closeModal)(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="overlay" style="background:rgb(6 4 12 / .35);display:block" onMouseDown=${(e) => { if (e.target === e.currentTarget) (onClose || closeModal)(); }}>
    <aside class="drawer" role="dialog" aria-modal="true">${children}</aside>
  </div>`;
}

export function confirmDialog({ title, text, confirm, danger }) {
  return new Promise((resolve) => {
    const done = (v) => { closeModal(); resolve(v); };
    openModal(() => html`<${Modal} title=${title} onClose=${() => done(false)}
      footer=${html`<span class="left"></span><${Btn} kind="ghost" onClick=${() => done(false)}>Cancelar<//><${Btn} kind=${danger ? 'danger' : 'primary'} onClick=${() => done(true)}>${confirm || 'Confirmar'}<//>`}>
      <p style="margin:0;color:var(--text-2)">${text}</p>
    <//>`);
  });
}

export function lightbox(src) {
  openModal(() => html`<div class="overlay" onMouseDown=${closeModal}><img class="lightbox" src=${src} alt="" /></div>`, 'raw');
}

// ---------- popover menu ----------
export function useMenu() {
  const [menu, setMenu] = useState(null);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const t = setTimeout(() => window.addEventListener('click', close), 0);
    window.addEventListener('keydown', close);
    return () => { clearTimeout(t); window.removeEventListener('click', close); window.removeEventListener('keydown', close); };
  }, [menu]);
  const open = (e, items) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 230, r.left);
    setMenu({ x: left, y: r.bottom + 6, items });
  };
  const node = menu ? html`<div class="menu" style=${{ left: menu.x + 'px', top: menu.y + 'px', position: 'fixed' }}>
    ${menu.items.filter(Boolean).map((it) => (it === '-' ? html`<hr />` : html`<button type="button" class=${it.danger ? 'danger' : ''} onClick=${() => { setMenu(null); it.run(); }}><${Icon} name=${it.icon || 'chevron-right'} />${it.label}</button>`))}
  </div>` : null;
  return [open, node];
}

// ---------- toasts ----------
let toastSeq = 0;
export function toast(text, tone) {
  const id = ++toastSeq;
  setState((s) => ({ toasts: s.toasts.concat([{ id, text, tone: tone || 'ok' }]) }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'bad' ? 6000 : 3200);
}

export async function attempt(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, 'bad'); return null; }
}

// ---------- formatting ----------
export function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms || 15000); return () => clearInterval(t); }, []);
  return now;
}

export function ago(ts, now) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
  if (s < 45) return 'ahora';
  const m = Math.round(s / 60);
  if (m < 60) return 'hace ' + m + ' min';
  const h = Math.round(m / 60);
  if (h < 36) return 'hace ' + h + ' h';
  return 'hace ' + Math.round(h / 24) + ' d';
}

export function clock(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function money(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  // Agent turns often cost fractions of a cent; don't round them to zero.
  const digits = v > 0 && v < 0.01 ? 4 : v > 0 && v < 1 ? 3 : 2;
  return 'US$' + v.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' k';
  if (n < 1e9) return (n / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 2 }) + ' M';
  return (n / 1e9).toLocaleString('es-CO', { maximumFractionDigits: 2 }) + ' B';
}

export function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

export function shortPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  const home = String((getState().me && getState().me.home) || '').replace(/\\/g, '/');
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) s = '~' + s.slice(home.length);
  const parts = s.split('/').filter(Boolean);
  if (parts.length > 4) s = (s.startsWith('~') ? '~/…/' : '…/') + parts.slice(-3).join('/');
  return s || '~';
}

export function sessionState(s) {
  if (!s.alive) return { cls: 'off', label: 'cerrada' };
  if (s.status === 'busy') return { cls: 'busy', label: 'trabajando' };
  if (s.status === 'idle') return { cls: 'idle', label: 'en espera' };
  return { cls: 'busy', label: 'activa' };
}

// One entry per subscription: config dirs signed into the same email share their limits.
// Prefer the dir that has usage data, then the one with the most sessions.
export function uniqueAccounts(accounts, usage, sessions) {
  const byEmail = new Map();
  for (const a of accounts) {
    if (!a.email) continue;
    const score = (usage && usage[a.configDir] ? 1000 : 0) + sessions.filter((s) => s.configDir === a.configDir).length;
    const prev = byEmail.get(a.email);
    const dirs = (prev ? prev.dirs : []).concat([a.configDir]);
    if (!prev || score > prev.score) byEmail.set(a.email, Object.assign({}, a, { score, dirs }));
    else prev.dirs = dirs;
  }
  return [...byEmail.values()];
}

export function accountLabel(configDir) {
  const a = getState().accounts.find((x) => x.configDir === configDir);
  return a ? a.email || a.configDir : configDir || 'cuenta desconocida';
}

export function modelLabel(m) {
  if (!m) return '';
  const s = String(m);
  const hit = /(opus|sonnet|haiku|fable)[-\s]?(\d+)[-.](\d+)/i.exec(s);
  if (hit) return hit[1][0].toUpperCase() + hit[1].slice(1).toLowerCase() + ' ' + hit[2] + '.' + hit[3];
  return s.replace(/^claude-/, '');
}

// Autosize a textarea to its content.
export function useAutosize(ref, value) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [value]);
}

export const ROLE_COLORS = ['#a78bfa', '#8b5cf6', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#5eead4', '#7dd3fc', '#fbbf24', '#f59e0b', '#94a3b8', '#86efac'];

export function useLocal(key, initial) {
  const [v, setV] = useState(() => {
    try { const raw = localStorage.getItem('ab.' + key); return raw == null ? initial : JSON.parse(raw); } catch (e) { return initial; }
  });
  const set = (next) => {
    setV((prev) => {
      const val = typeof next === 'function' ? next(prev) : next;
      try { localStorage.setItem('ab.' + key, JSON.stringify(val)); } catch (e) {}
      return val;
    });
  };
  return [v, set];
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value]);
  return v;
}

export { useRef, useState, useEffect };
