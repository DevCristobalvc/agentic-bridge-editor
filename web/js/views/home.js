// Home: mission control for every session, account, room and project.
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { api, setState, useStore } from '../api.js';
import { Btn, Icon, Bar, Avatar, Empty, money, tokens, ago, useNow, sessionState, shortPath, attempt, clock, uniqueAccounts, memberIcon } from '../ui.js';
import { navigate } from '../router.js';
import { newSession, newRoom, newTerminal } from '../dialogs.js';
import { newBoard } from './boards.js';
import { newProject } from './projects.js';
import { newShell } from './terminals.js';

// Where you left off: the latest conversations of every account, one click to resume.
function Continue() {
  const sessions = useStore((s) => s.sessions);
  const [list, setList] = useState(null);
  const now = useNow(60000);
  useEffect(() => { api.get('/api/history').then((d) => setList(d.conversations.slice(0, 6))).catch(() => setList([])); }, []);
  if (!list || !list.length) return null;
  const resume = async (c) => {
    const live = sessions.find((x) => x.id === c.id && x.alive);
    if (live) { navigate(live.terminalId ? '/terminals/' + live.terminalId : '/sessions/' + live.id); return; }
    const r = c.source === 'antigravity'
      ? await attempt(() => api.post('/api/agy/sessions', { conversationId: c.id, cwd: c.cwd, name: c.title.slice(0, 40) }))
      : await attempt(() => api.post('/api/sessions', { resumeId: c.id, configDir: c.configDir, cwd: c.cwd, name: c.title.slice(0, 40), where: 'pty' }));
    if (r && r.terminal) navigate('/terminals/' + r.terminal.id);
  };
  return html`<div class="card">
    <div class="card-head"><${Icon} name="history" /><h3>Continuar donde quedaste</h3><a style="margin-left:auto;font-size:12.5px" href="#/history">Historial</a></div>
    <div class="list">${list.map((c) => {
      const live = sessions.some((x) => x.id === c.id && x.alive);
      return html`<div class="list-row" onClick=${() => navigate('/history/' + encodeURIComponent(c.id))}>
        <${Icon} name=${c.source === 'antigravity' ? 'orbit' : 'sparkles'} />
        <div class="grow"><div class="t ellipsis">${c.title}</div><div class="s ellipsis">${c.project || shortPath(c.cwd)} · ${ago(c.lastAt, now)}</div></div>
        <${Btn} size="sm" icon=${live ? 'arrow-right' : 'play'} onClick=${(e) => { e.stopPropagation(); resume(c); }}>${live ? 'Abrir' : 'Retomar'}<//>
      </div>`;
    })}</div>
  </div>`;
}

export function UsageBars({ usage, compact }) {
  if (!usage) return html`<div class="muted" style="font-size:12.5px">Sin datos de uso todavía.</div>`;
  const row = (label, w) => (w ? html`<div class="gauge-row">
    <div class="lbl"><span class="muted">${label}</span><b>${Math.round(w.pct)}%</b>${w.resetsAt ? html`<span class="dim" style="margin-left:auto;font-size:12px">se reinicia ${clock(w.resetsAt)}</span>` : null}</div>
    <${Bar} value=${w.pct} />
  </div>` : null);
  return html`<div class="col" style=${{ gap: compact ? '8px' : '12px' }}>
    ${row('Ventana de 5 horas', usage.five_hour)}
    ${row('Semana', usage.seven_day)}
    ${!compact ? row('Semana · Opus', usage.seven_day_opus) : null}
  </div>`;
}

export function ConnectCallout() {
  const integration = useStore((s) => s.integration);
  const [busy, setBusy] = useState(false);
  if (!integration) return null;
  const missing = integration.accounts.filter((a) => a.email && !a.integration.complete);
  const agyMissing = integration.antigravity.present && !integration.antigravity.mcp;
  if (!missing.length && !agyMissing) return null;
  const connect = async () => {
    setBusy(true);
    const r = await attempt(() => api.post('/api/integration/connect'), 'Listo: tus cuentas ya se pueden hablar');
    setBusy(false);
    if (r) setState({ integration: r.status });
  };
  return html`<div class="callout" style="margin-top:16px">
    <${Icon} name="plug" />
    <div class="grow">
      <h4>Conecta tus cuentas para que las sesiones se hablen</h4>
      <p>${missing.length} cuenta${missing.length === 1 ? '' : 's'}${agyMissing ? ' y Antigravity' : ''} sin el puente: herramientas <span class="mono">bridge_*</span>, buzón con hooks, guardas del contrato y la skill <span class="mono">/modo-todo</span>. Se hace una copia de respaldo de cada settings.json.</p>
    </div>
    <div class="actions"><${Btn} kind="primary" icon="plug" busy=${busy} onClick=${connect}>Conectar ahora<//></div>
  </div>`;
}

export function Home() {
  const sessions = useStore((s) => s.sessions);
  const accounts = useStore((s) => s.accounts);
  const rooms = useStore((s) => s.rooms);
  const usage = useStore((s) => s.usage);
  const activity = useStore((s) => s.activity);
  const projects = useStore((s) => s.projects);
  const prefs = useStore((s) => s.prefs);
  const now = useNow(20000);

  const alive = sessions.filter((s) => s.alive);
  const busy = alive.filter((s) => s.status === 'busy');
  const cost = alive.reduce((a, s) => a + (s.cost || 0), 0);
  const tok = alive.reduce((a, s) => a + (s.tokens ? s.tokens.in + s.tokens.out + s.tokens.cr + s.tokens.cc : 0), 0);
  const working = Object.values(activity).reduce((a, r) => a + Object.keys(r).length, 0);
  const signed = uniqueAccounts(accounts, usage, sessions);
  const firstName = String(prefs.humanName || '').split(' ')[0];
  const sorted = alive.slice().sort((a, b) => (a.status === 'busy' ? -1 : 0) - (b.status === 'busy' ? -1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));

  return html`<div class="page">
    <section class="hero">
      <div class="eyebrow">Agentic Bridge · el editor web4</div>
      <h2>${firstName ? firstName + ', tus' : 'Tus'} agentes y todas tus cuentas, <em>en un solo puente</em>.</h2>
      <p>Web1 te dejó leer, web2 escribir y web3 poseer. Web4 es delegar: humanos y agentes en el mismo espacio, con contrato, memoria y reglas que se cumplen.</p>
      <div class="actions">
        <${Btn} kind="primary" size="lg" icon="plus" onClick=${() => newSession()}>Nueva sesión<//>
        <${Btn} size="lg" icon="rooms" onClick=${() => newRoom()}>Nueva sala<//>
        <${Btn} size="lg" icon="scroll" onClick=${() => { navigate('/projects'); setTimeout(newProject, 50); }}>Proyecto con contrato<//>
      </div>
    </section>

    <${ConnectCallout} />

    <div class="kpis">
      <div class="kpi"><div class="k"><${Icon} name="sessions" />Sesiones vivas</div><div class="v">${alive.length}</div><div class="s">${busy.length} trabajando ahora</div></div>
      <div class="kpi"><div class="k"><${Icon} name="user" />Cuentas</div><div class="v">${signed.length}</div><div class="s">${signed.map((a) => a.email.split('@')[0]).join(' · ') || '—'}</div></div>
      <div class="kpi"><div class="k"><${Icon} name="bot" />Agentes en salas</div><div class="v">${rooms.reduce((a, r) => a + r.members.filter((m) => m.kind === 'agent').length, 0)}</div><div class="s">${working ? working + ' respondiendo ahora' : 'todos en espera'}</div></div>
      <div class="kpi"><div class="k"><${Icon} name="dollar" />Costo de sesiones vivas</div><div class="v">${money(cost)}</div><div class="s">${tokens(tok)} tokens procesados</div></div>
    </div>

    <div class="home-grid">
      <div class="card">
        <div class="card-head"><${Icon} name="sessions" /><h3>Sesiones activas</h3><span class="dim" style="font-size:12.5px">${alive.length}</span><a class="more" style="margin-left:auto;font-size:12.5px" href="#/sessions">Ver todas</a></div>
        ${sorted.length ? html`<div class="list">${sorted.slice(0, 9).map((s) => {
          const st = sessionState(s);
          const c = s.crew;
          return html`<div class="list-row" onClick=${() => navigate('/sessions/' + s.id)}>
            <span class=${'dot ' + st.cls}></span>
            <div class="grow">
              <div class="row"><span class="t ellipsis">${s.name}</span>${s.unread ? html`<span class="chip accent"><${Icon} name="inbox" />${s.unread}</span>` : null}${s.terminalId ? html`<span class="chip">integrada</span>` : null}</div>
              <div class="s ellipsis">${s.source === 'antigravity' ? 'Antigravity' : s.account || '—'} · ${shortPath(s.cwd)}</div>
            </div>
            ${c && c.total ? html`<div class="col" style="width:90px;gap:3px;align-items:flex-end"><span class="dim mono" style="font-size:11px">${c.task ? 'Task ' + c.task : ''} ${c.done}/${c.total}</span><${Bar} value=${(100 * c.done) / c.total} tone="ok" /></div>` : null}
            <span class="mono muted" style="font-size:12px;width:72px;text-align:right">${s.cost != null ? money(s.cost) : ''}</span>
            <span class="dim" style="font-size:12px;width:76px;text-align:right">${st.label === 'trabajando' ? st.label : ago(s.updatedAt, now)}</span>
          </div>`;
        })}</div>` : html`<${Empty} icon="sessions" title="No hay sesiones abiertas" action=${html`<${Btn} kind="primary" icon="plus" onClick=${() => newSession()}>Abrir una<//>`}>Abre una sesión desde aquí o desde cualquier terminal: aparecerá sola en segundos.<//>`}
      </div>

      <div class="col" style="gap:16px">
        <${Continue} />
        <div class="card">
          <div class="card-head"><${Icon} name="zap" /><h3>Atajos</h3><kbd style="margin-left:auto">Ctrl K</kbd></div>
          <div class="quick">
            <button type="button" onClick=${() => newRoom()}><span class="ic"><${Icon} name="rooms" /></span><span><b>Sala de agentes</b><small>Supervisor, arquitecto, devs…</small></span></button>
            <button type="button" onClick=${() => { navigate('/projects'); setTimeout(newProject, 50); }}><span class="ic"><${Icon} name="scroll" /></span><span><b>Modo todo.md</b><small>Contrato + tablero</small></span></button>
            <button type="button" onClick=${() => newBoard()}><span class="ic"><${Icon} name="board" /></span><span><b>Pizarra</b><small>Excalidraw para pensar</small></span></button>
            <button type="button" onClick=${() => newTerminal({})}><span class="ic"><${Icon} name="terminal" /></span><span><b>Terminal</b><small>PowerShell, Git Bash, CMD</small></span></button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><${Icon} name="chart" /><h3>Suscripciones</h3><a style="margin-left:auto;font-size:12.5px" href="#/metrics">Detalle</a></div>
          <div class="card-body col" style="gap:16px">
            ${signed.length ? signed.map((a) => html`<div class="col" style="gap:8px">
              <div class="row"><b class="ellipsis" style="font-size:13px">${a.email}</b><span class="chip mono" style="margin-left:auto">${a.dirs.join(' · ')}</span></div>
              <${UsageBars} usage=${usage[a.configDir]} compact />
            </div>`) : html`<span class="muted">Sin cuentas con sesión iniciada.</span>`}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><${Icon} name="rooms" /><h3>Salas recientes</h3><a style="margin-left:auto;font-size:12.5px" href="#/rooms">Todas</a></div>
          ${rooms.length ? html`<div class="list">${rooms.slice(0, 5).map((r) => html`<div class="list-row" onClick=${() => navigate('/rooms/' + r.id)}>
            <div class="stack-avatars">${r.members.slice(0, 4).map((m) => html`<${Avatar} size="sm" icon=${m.kind === 'session' ? 'terminal' : memberIcon(m)} color=${m.color} name=${m.name} />`)}</div>
            <div class="grow"><div class="t ellipsis">${r.name}</div><div class="s ellipsis">${r.last ? r.last.author.name + ': ' + r.last.text : 'Sin mensajes todavía'}</div></div>
            ${activity[r.id] && Object.keys(activity[r.id]).length ? html`<span class="spinner"></span>` : html`<span class="dim" style="font-size:12px">${ago(r.updatedAt, now)}</span>`}
          </div>`)}</div>` : html`<div class="card-body muted">Aún no hay salas. ${projects.length ? '' : 'Crea una o arma un proyecto con contrato.'}</div>`}
        </div>
      </div>
    </div>
  </div>`;
}
