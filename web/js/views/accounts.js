// Accounts: Claude subscriptions, Antigravity, the developer accounts read from their CLIs
// (GitHub, Vercel, Azure, Docker…) and encrypted credentials for terminals.
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { api, useStore, setState } from '../api.js';
import {
  Btn, Icon, IconBtn, Empty, Modal, Field, CopyBtn, openModal, closeModal, toast, attempt, useMenu, confirmDialog, promptDialog, ago, useNow, uniqueAccounts, shortPath,
} from '../ui.js';
import { navigate } from '../router.js';
import { newSession, newTerminal, IntegrationList } from '../dialogs.js';
import { UsageBars } from './home.js';

const STATE = {
  connected: { dot: 'busy', label: 'conectado' },
  disconnected: { dot: 'off', label: 'sin sesión' },
  stopped: { dot: 'warn', label: 'detenido' },
  checking: { dot: 'idle', label: 'revisando…' },
  error: { dot: 'bad', label: 'error' },
  missing: { dot: 'off', label: 'no instalado' },
  unknown: { dot: 'off', label: 'sin revisar' },
};

async function openTerminal(promise, label) {
  const r = await attempt(() => promise);
  if (r && r.terminal) { toast(label); navigate('/terminals/' + r.terminal.id); }
}

// ---------- Claude ----------
async function addClaudeAccount() {
  const name = await promptDialog({ title: 'Agregar una cuenta de Claude', label: 'Nombre corto (crea ~/.claude-nombre)', placeholder: 'p. ej. personal', confirm: 'Crear e iniciar sesión' });
  if (!name || !name.trim()) return;
  openTerminal(api.post('/api/claude-accounts', { name: name.trim() }), 'Inicia sesión en la terminal; luego conéctala a Bridge');
}

function ClaudeCard({ a, usage, sessions, integration }) {
  const mine = sessions.filter((s) => a.dirs.includes(s.configDir));
  const alive = mine.filter((s) => s.alive).length;
  const integ = integration ? integration.accounts.filter((x) => a.dirs.includes(x.configDir)) : [];
  const complete = integ.length && integ.every((x) => x.integration.complete);
  return html`<div class="card prov">
    <div class="top">
      <div class="logo"><${Icon} name="sparkles" /></div>
      <div class="grow" style="min-width:0"><h3 class="ellipsis">${a.email}</h3><div class="muted ellipsis" style="font-size:12px">${[a.displayName, a.org, a.orgType && a.orgType.replace('claude_', 'Claude ')].filter(Boolean).join(' · ')}</div></div>
      <span class="state"><span class=${'dot ' + (complete ? 'busy' : 'warn')}></span>${complete ? 'en Bridge' : 'sin conectar'}</span>
    </div>
    <div class="row wrap" style="gap:6px">${a.dirs.map((d) => html`<span class="chip mono">${d}</span>`)}<span class="chip">${alive} vivas · ${mine.length} sesiones</span></div>
    <${UsageBars} usage=${usage} compact />
    <div class="actions">
      <${Btn} size="sm" icon="plus" onClick=${() => newSession({ configDir: a.configDir, agent: 'claude' })}>Nueva sesión<//>
      ${!complete ? html`<${Btn} size="sm" icon="plug" onClick=${() => attempt(() => api.post('/api/integration/connect'), 'Cuentas conectadas').then((r) => r && setState({ integration: r.status }))}>Conectar a Bridge<//>` : null}
    </div>
  </div>`;
}

function AgyCard() {
  const agy = useStore((s) => s.antigravity);
  const integration = useStore((s) => s.integration);
  if (!agy) return null;
  const mcp = integration && integration.antigravity && integration.antigravity.mcp;
  return html`<div class=${'card prov' + (agy.installed ? '' : ' off')}>
    <div class="top">
      <div class="logo"><${Icon} name="orbit" /></div>
      <div class="grow"><h3>Antigravity</h3><div class="muted" style="font-size:12px">${agy.installed ? 'agy CLI · ' + (agy.model || 'modelo por defecto') : 'CLI no instalado'}</div></div>
      <span class="state"><span class=${'dot ' + (agy.installed ? (mcp ? 'busy' : 'warn') : 'off')}></span>${agy.installed ? (mcp ? 'en Bridge' : 'sin MCP') : 'no instalado'}</span>
    </div>
    <div class="muted" style="font-size:12.5px">Su cuenta de Google vive en el propio CLI. Sus conversaciones aparecen en Historial y sus sesiones vivas en Sesiones.</div>
    <div class="actions">
      ${agy.installed ? html`<${Btn} size="sm" icon="plus" onClick=${() => newSession({ agent: 'agy' })}>Nueva sesión<//>` : null}
      <${Btn} size="sm" icon="history" onClick=${() => navigate('/history')}>Conversaciones<//>
    </div>
  </div>`;
}

// ---------- providers ----------
function ProviderCard({ p }) {
  const [openMenu, menu] = useMenu();
  const st = STATE[p.state] || STATE.unknown;
  const now = useNow(60000);
  const refresh = () => attempt(() => api.post('/api/connections/refresh', { id: p.id }));
  const azureSubs = async (e) => {
    const target = e.currentTarget;
    const subs = await attempt(() => api.get('/api/connections-azure/subscriptions'));
    if (!subs) return;
    openMenu({ currentTarget: target, stopPropagation() {} }, subs.map((x) => ({ label: (x.isDefault ? '● ' : '') + x.name, icon: 'cloud', run: () => attempt(() => api.post('/api/connections-azure/subscription', { id: x.id }), 'Suscripción activa: ' + x.name) })));
  };
  const gitIdentity = () => openModal(() => html`<${GitIdentity} p=${p} />`);
  return html`<div class=${'card prov' + (p.state === 'connected' ? '' : ' off')}>
    <div class="top">
      <div class="logo"><${Icon} name=${p.icon} /></div>
      <div class="grow"><h3>${p.name}</h3><div class="muted" style="font-size:12px">${p.checkedAt ? 'revisado ' + ago(p.checkedAt, now) : ''}${p.note ? ' · ' + p.note : ''}</div></div>
      <span class="state"><span class=${'dot ' + st.dot}></span>${st.label}</span>
      <${IconBtn} icon="refresh" size="sm" title="Volver a revisar" onClick=${refresh} />
    </div>
    ${p.accounts && p.accounts.length ? html`<div class="col" style="gap:6px">${p.accounts.map((a) => html`<div class="acc">
      <${Icon} name=${a.active ? 'check' : 'user'} />
      <div class="grow"><b>${a.label}</b>${a.detail ? html`<span title=${a.detail}>${a.detail}</span>` : null}</div>
      ${a.copy ? html`<${CopyBtn} text=${a.copy} />` : null}
      ${p.id === 'github' && !a.active ? html`<${Btn} size="sm" icon="shuffle" onClick=${() => attempt(() => api.post('/api/connections-github/switch', { user: a.id }), 'Cuenta activa: ' + a.label)}>Usar<//>` : null}
    </div>`)}</div>` : null}
    ${p.details && p.details.length ? html`<dl class="kv" style="font-size:12.5px">${p.details.filter((d) => d[1]).map((d) => html`<dt>${d[0]}</dt><dd>${d[1]}</dd>`)}</dl>` : null}
    <div class="actions">
      ${p.login ? html`<${Btn} size="sm" icon="log-in" kind=${p.state === 'connected' ? '' : 'primary'} onClick=${() => openTerminal(api.post('/api/connections/' + p.id + '/login'), 'Sigue los pasos en la terminal')}>${p.loginLabel || (p.state === 'connected' ? 'Agregar o cambiar cuenta' : 'Iniciar sesión')}<//>` : null}
      ${p.id === 'azure' && p.state === 'connected' ? html`<${Btn} size="sm" icon="shuffle" onClick=${azureSubs}>Cambiar suscripción<//>` : null}
      ${p.id === 'git' ? html`<${Btn} size="sm" icon="pencil" onClick=${gitIdentity}>Editar identidad<//>` : null}
      ${p.logout && p.state === 'connected' ? html`<${Btn} size="sm" kind="ghost" icon="log-out" onClick=${async () => { if (await confirmDialog({ title: 'Cerrar sesión en ' + p.name, text: 'Se abre una terminal con el comando de cierre de sesión de ' + p.name + '.', confirm: 'Abrir terminal' })) openTerminal(api.post('/api/connections/' + p.id + '/logout'), 'Confirma en la terminal'); }}>Cerrar sesión<//>` : null}
    </div>
    ${menu}
  </div>`;
}

function GitIdentity({ p }) {
  const ident = (p.accounts[0] && { name: p.accounts[0].label === '(sin nombre)' ? '' : p.accounts[0].label, email: p.accounts[0].detail === '(sin correo)' ? '' : p.accounts[0].detail }) || { name: '', email: '' };
  const [name, setName] = useState(ident.name);
  const [email, setEmail] = useState(ident.email);
  const save = async () => { if (await attempt(() => api.put('/api/connections-git/identity', { name, email }), 'Identidad de Git actualizada')) closeModal(); };
  return html`<${Modal} title="Identidad de Git" subtitle="git config --global user.name y user.email: firma de tus commits."
    footer=${html`<span class="left"></span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="check" onClick=${save}>Guardar<//>`}>
    <div class="grid-2">
      <${Field} label="Nombre"><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="Correo"><input class="input" value=${email} onInput=${(e) => setEmail(e.target.value)} /><//>
    </div>
  <//>`;
}

// ---------- credentials ----------
export function editSecret(s) { openModal(() => html`<${SecretEditor} s=${s} />`); }

function SecretEditor({ s }) {
  const isNew = !s;
  const [name, setName] = useState(s ? s.name : '');
  const [value, setValue] = useState('');
  const [service, setService] = useState(s ? s.service : '');
  const [note, setNote] = useState(s ? s.note : '');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { name: name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'), service, note };
    if (value) body.value = value;
    const r = await attempt(() => (isNew ? api.post('/api/secrets', body) : api.put('/api/secrets/' + s.id, body)), isNew ? 'Credencial guardada y cifrada' : 'Credencial actualizada');
    setBusy(false);
    if (r) closeModal();
  };
  return html`<${Modal} title=${isNew ? 'Nueva credencial' : 'Editar ' + s.name} subtitle="Se cifra en este equipo con DPAPI de Windows: solo tu usuario puede descifrarla."
    footer=${html`<span class="left">Nunca se envía a agentes ni a salas.</span><${Btn} kind="ghost" onClick=${closeModal}>Cancelar<//><${Btn} kind="primary" icon="lock" busy=${busy} onClick=${save}>Guardar<//>`}>
    <div class="grid-2">
      <${Field} label="Variable de entorno" hint="Así llega a la terminal, p. ej. GITHUB_TOKEN."><input class="input mono" autofocus value=${name} placeholder="OPENAI_API_KEY" onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="Servicio"><input class="input" value=${service} placeholder="p. ej. OpenAI, Supabase, Stripe" onInput=${(e) => setService(e.target.value)} /><//>
    </div>
    <${Field} label=${isNew ? 'Valor' : 'Nuevo valor (vacío = no cambiar)'}>
      <div class="row"><input class="input mono" type=${show ? 'text' : 'password'} value=${value} autocomplete="off" onInput=${(e) => setValue(e.target.value)} /><${IconBtn} icon=${show ? 'eye-off' : 'eye'} title=${show ? 'Ocultar' : 'Mostrar'} onClick=${() => setShow(!show)} /></div>
    <//>
    <${Field} label="Nota (opcional)"><input class="input" value=${note} placeholder="Para qué es, cuándo vence…" onInput=${(e) => setNote(e.target.value)} /><//>
  <//>`;
}

function SecretRow({ s }) {
  const [shown, setShown] = useState(null);
  const now = useNow(60000);
  const reveal = async () => {
    if (shown != null) { setShown(null); return; }
    const r = await attempt(() => api.post('/api/secrets/' + s.id + '/reveal'));
    if (r) { setShown(r.value); setTimeout(() => setShown(null), 20000); }
  };
  const copy = async () => {
    const r = await attempt(() => api.post('/api/secrets/' + s.id + '/reveal'));
    if (r) { await navigator.clipboard.writeText(r.value); toast(s.name + ' copiada al portapapeles'); }
  };
  return html`<div class="secret-row">
    <div style="min-width:0"><div class="nm" title=${s.name}>${s.name}</div>${s.note ? html`<div class="dim ellipsis" style="font-size:11.5px">${s.note}</div>` : null}</div>
    <div class=${'val' + (shown != null ? ' shown' : '')} title=${shown != null ? '' : 'Pista: ' + s.hint}>${shown != null ? shown : s.hint || '••••••••'}</div>
    <div class="svc muted ellipsis" style="font-size:12.5px">${s.service || '—'}${s.usedAt ? html`<div class="dim" style="font-size:11px">usada ${ago(s.usedAt, now)}</div>` : null}</div>
    <div class="row" style="gap:2px">
      <${IconBtn} icon=${shown != null ? 'eye-off' : 'eye'} size="sm" title=${shown != null ? 'Ocultar' : 'Ver 20 s'} onClick=${reveal} />
      <${IconBtn} icon="copy" size="sm" title="Copiar valor" onClick=${copy} />
      <${IconBtn} icon="pencil" size="sm" title="Editar" onClick=${() => editSecret(s)} />
      <${IconBtn} icon="trash" size="sm" title="Eliminar" onClick=${async () => { if (await confirmDialog({ title: 'Eliminar ' + s.name, text: 'Se borra el valor cifrado de este equipo.', confirm: 'Eliminar', danger: true })) attempt(() => api.del('/api/secrets/' + s.id), 'Credencial eliminada'); }} />
    </div>
  </div>`;
}

// ---------- view ----------
export function Accounts() {
  const accounts = useStore((s) => s.accounts);
  const usage = useStore((s) => s.usage);
  const sessions = useStore((s) => s.sessions);
  const integration = useStore((s) => s.integration);
  const connections = useStore((s) => s.connections);
  const secrets = useStore((s) => s.secrets);
  const [showMissing, setShowMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/connections').then((l) => setState({ connections: l })).catch(() => {}); }, []);
  const signed = uniqueAccounts(accounts, usage, sessions);
  const unsigned = accounts.filter((a) => !a.email);
  const installed = connections.filter((p) => p.state !== 'missing');
  const missing = connections.filter((p) => p.state === 'missing');
  const refreshAll = async () => { setBusy(true); await attempt(() => api.post('/api/connections/refresh', {})); setBusy(false); };

  return html`<div class="page">
    <div class="page-head">
      <div><h2>Cuentas y credenciales</h2><p>Tus suscripciones de IA, las cuentas de tus herramientas de desarrollo y los secretos que necesitan tus terminales, en un solo lugar.</p></div>
      <div class="actions"><${Btn} icon="key" onClick=${() => editSecret(null)}>Nueva credencial<//><${Btn} kind="primary" icon="plus" onClick=${addClaudeAccount}>Cuenta de Claude<//></div>
    </div>

    <div class="section-title"><${Icon} name="sparkles" />Agentes de IA<span class="dim">${signed.length} suscripciones de Claude${unsigned.length ? ' · ' + unsigned.length + ' sin sesión iniciada' : ''}</span></div>
    <div class="prov-grid">
      ${signed.map((a) => html`<${ClaudeCard} a=${a} usage=${usage[a.configDir]} sessions=${sessions} integration=${integration} />`)}
      ${unsigned.map((a) => html`<div class="card prov off"><div class="top"><div class="logo"><${Icon} name="sparkles" /></div><div class="grow"><h3 class="mono">${a.configDir}</h3><div class="muted" style="font-size:12px">sin sesión iniciada</div></div></div>
        <div class="actions"><${Btn} size="sm" kind="primary" icon="log-in" onClick=${() => newSession({ configDir: a.configDir, agent: 'claude', name: 'login' })}>Iniciar sesión<//></div></div>`)}
      <${AgyCard} />
    </div>
    ${integration ? html`<details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:12.5px">Detalle de la integración con Bridge (MCP, buzón, guardas, skill)</summary><div style="margin-top:8px"><${IntegrationList} integration=${integration} /></div></details>` : null}

    <div class="section-title"><${Icon} name="globe" />Herramientas de desarrollo<span class="dim">leídas de sus propios CLI; Bridge no guarda sus tokens</span>
      <span class="more"><${Btn} size="sm" icon="refresh" busy=${busy} onClick=${refreshAll}>Revisar todas<//></span></div>
    ${installed.length ? html`<div class="prov-grid">${installed.map((p) => html`<${ProviderCard} key=${p.id} p=${p} />`)}</div>` : html`<div class="row muted"><span class="spinner"></span>Revisando tus herramientas…</div>`}
    ${missing.length ? html`<div style="margin-top:12px">
      <button type="button" class="btn ghost sm" onClick=${() => setShowMissing(!showMissing)}><${Icon} name=${showMissing ? 'chevron-down' : 'chevron-right'} />${missing.length} herramientas no instaladas</button>
      ${showMissing ? html`<div class="card" style="margin-top:8px">${missing.map((p) => html`<div class="list-row" style="cursor:default">
        <${Icon} name=${p.icon} /><div class="grow"><div class="t">${p.name}</div>${p.install ? html`<div class="s mono">${p.install}</div>` : null}</div>
        ${p.install ? html`<${CopyBtn} text=${p.install} label="Copiar comando" />` : null}
      </div>`)}</div>` : null}
    </div>` : null}

    <div class="section-title"><${Icon} name="lock" />Credenciales<span class="dim">cifradas en este equipo · se pasan como variables de entorno a las terminales que elijas</span>
      <span class="more row" style="gap:6px"><${Btn} size="sm" icon="terminal" onClick=${() => newTerminal({})} disabled=${!secrets.length}>Terminal con credenciales<//><${Btn} size="sm" icon="plus" onClick=${() => editSecret(null)}>Nueva<//></span></div>
    ${secrets.length ? html`<div class="card">${secrets.map((s) => html`<${SecretRow} key=${s.id} s=${s} />`)}</div>`
      : html`<div class="card"><${Empty} icon="key" title="Sin credenciales todavía" action=${html`<${Btn} kind="primary" icon="plus" onClick=${() => editSecret(null)}>Guardar la primera<//>`}>
        Guarda tokens y API keys (GITHUB_TOKEN, OPENAI_API_KEY, SUPABASE_URL…) cifrados con DPAPI. Al abrir una terminal o una sesión eliges cuáles recibe como variables de entorno.<//></div>`}
  </div>`;
}
