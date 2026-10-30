// Metrics: subscription windows per account, cost and tokens per session, full table.
import { html, useMemo, useState } from '/vendor/htm-preact.js';
import { api, useStore } from '../api.js';
import { Btn, Icon, Empty, Seg, money, tokens, ago, useNow, sessionState, modelLabel, attempt, useLocal, uniqueAccounts } from '../ui.js';
import { UsageBars } from './home.js';
import { navigate } from '../router.js';

const totalTok = (s) => (s.tokens ? s.tokens.in + s.tokens.out + s.tokens.cr + s.tokens.cc : 0);

// One-hue magnitude bars with a hover tooltip; text stays in text colors.
function HBars({ rows, format, empty }) {
  const [tip, setTip] = useState(null);
  if (!rows.length) return html`<div class="muted" style="padding:16px">${empty}</div>`;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  return html`<div class="hbars" onMouseLeave=${() => setTip(null)}>
    ${rows.map((r) => html`<div class="hbar-row" onClick=${r.onClick}
        onMouseMove=${(e) => { const b = e.currentTarget.parentNode.getBoundingClientRect(); setTip({ r, x: e.clientX - b.left, y: e.clientY - b.top }); }}>
      <span class="hbar-label ellipsis" title=${r.label}>${r.label}</span>
      <span class="hbar-track"><i style=${{ width: Math.max(0.6, (100 * r.value) / max) + '%' }}></i></span>
      <span class="hbar-val">${format(r.value)}</span>
    </div>`)}
    ${tip ? html`<div class="chart-tip" style=${{ left: Math.min(tip.x + 14, 9999) + 'px', top: tip.y + 12 + 'px' }}>
      <b>${tip.r.label}</b>${tip.r.tip.map((l) => html`<div><span class="muted">${l[0]}</span> ${l[1]}</div>`)}
    </div>` : null}
  </div>`;
}

function SubscriptionCard({ a, usage, sessions }) {
  const [busy, setBusy] = useState(false);
  const now = useNow(30000);
  const mine = sessions.filter((s) => a.dirs.includes(s.configDir));
  const alive = mine.filter((s) => s.alive);
  const cost = mine.reduce((x, s) => x + (s.cost || 0), 0);
  const refresh = async () => {
    setBusy(true);
    const r = await attempt(() => api.post('/api/accounts/' + encodeURIComponent(a.configDir) + '/usage'));
    setBusy(false);
    if (r && !r.ok) attempt(() => Promise.reject(new Error('La cuenta no devolvió datos de uso.')));
  };
  return html`<div class="card sub-card">
    <div class="row">
      <div class="avatar" style="background:linear-gradient(135deg,#a78bfa,#6d28d9)">${(a.displayName || a.email || '?').charAt(0).toUpperCase()}</div>
      <div class="grow"><b class="ellipsis" style="display:block">${a.email}</b><span class="muted" style="font-size:12px">${a.displayName || ''}${a.org ? ' · ' + a.org : ''}</span></div>
      <span class="chip mono">${a.dirs.join(' · ')}</span>
    </div>
    <div class="row wrap">
      ${a.orgType ? html`<span class="chip accent">${a.orgType.replace('claude_', 'Claude ')}</span>` : null}
      ${a.seatTier ? html`<span class="chip">${a.seatTier.replace(/_/g, ' ')}</span>` : null}
      ${a.billingType ? html`<span class="chip">${a.billingType.replace(/_/g, ' ')}</span>` : null}
    </div>
    <${UsageBars} usage=${usage} />
    <div class="row" style="font-size:12.5px;border-top:1px solid var(--line);padding-top:10px;margin-top:auto">
      <div class="col grow" style="gap:1px">
        <span><b>${alive.length}</b> <span class="muted">vivas de ${mine.length} · ${money(cost)}</span></span>
        <span class="dim" style="font-size:11.5px">${usage ? 'uso leído ' + ago(usage.at, now) + ' desde ' + (usage.source === 'cockpit' ? 'el cockpit' : usage.source === 'agent' ? 'un agente' : 'un sondeo') : 'sin lectura de uso'}</span>
      </div>
      <${Btn} size="sm" icon="refresh" busy=${busy} onClick=${refresh} title="Hace una consulta mínima con Haiku para leer el uso">Actualizar<//>
    </div>
  </div>`;
}

const COLUMNS = [
  { key: 'name', label: 'Sesión', get: (s) => s.name.toLowerCase() },
  { key: 'account', label: 'Cuenta', get: (s) => s.account || '' },
  { key: 'state', label: 'Estado', get: (s) => sessionState(s).label },
  { key: 'model', label: 'Modelo', get: (s) => s.model || '' },
  { key: 'ctx', label: 'Contexto', num: true, get: (s) => s.ctxPct || 0 },
  { key: 'in', label: 'Entrada', num: true, get: (s) => (s.tokens ? s.tokens.in : 0) },
  { key: 'out', label: 'Salida', num: true, get: (s) => (s.tokens ? s.tokens.out : 0) },
  { key: 'cache', label: 'Caché', num: true, get: (s) => (s.tokens ? s.tokens.cr + s.tokens.cc : 0) },
  { key: 'req', label: 'Peticiones', num: true, get: (s) => (s.tokens ? s.tokens.req : 0) },
  { key: 'cost', label: 'Costo', num: true, get: (s) => s.cost || 0 },
];

export function Metrics() {
  const sessions = useStore((s) => s.sessions);
  const accounts = useStore((s) => s.accounts);
  const usage = useStore((s) => s.usage);
  const rooms = useStore((s) => s.rooms);
  const [scope, setScope] = useLocal('metricsScope', 'alive');
  const [sort, setSort] = useState({ key: 'cost', dir: -1 });

  const list = scope === 'alive' ? sessions.filter((s) => s.alive) : sessions;
  const cost = list.reduce((a, s) => a + (s.cost || 0), 0);
  const tok = list.reduce((a, s) => a + totalTok(s), 0);
  const req = list.reduce((a, s) => a + (s.tokens ? s.tokens.req : 0), 0);
  const roomSpend = rooms.reduce((a, r) => a + (r.spentUsd || 0), 0);
  const cacheRead = list.reduce((a, s) => a + (s.tokens ? s.tokens.cr : 0), 0);
  const signed = uniqueAccounts(accounts, usage, sessions);

  const rowOf = (s, value) => ({
    id: s.id, label: s.name, value, onClick: () => navigate('/sessions/' + s.id),
    tip: [['Costo', money(s.cost)], ['Tokens', tokens(totalTok(s))], ['Modelo', modelLabel(s.model) || '—'], ['Cuenta', s.account || '—']],
  });
  const byCost = list.filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 12).map((s) => rowOf(s, s.cost));
  const byTok = list.filter((s) => totalTok(s) > 0).sort((a, b) => totalTok(b) - totalTok(a)).slice(0, 12).map((s) => rowOf(s, totalTok(s)));

  const col = COLUMNS.find((c) => c.key === sort.key);
  const rows = useMemo(() => list.slice().sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
  }), [list, sort]);

  return html`<div class="page">
    <div class="page-head">
      <div><h2>Métricas</h2><p>Uso de cada suscripción, costo y tokens de cada sesión, en todas tus cuentas.</p></div>
      <div class="actions"><${Seg} value=${scope} onChange=${setScope} options=${[{ value: 'alive', label: 'Sesiones vivas' }, { value: 'all', label: 'Todas' }]} /></div>
    </div>
    <div class="kpis" style="margin-top:0">
      <div class="kpi"><div class="k"><${Icon} name="dollar" />Costo</div><div class="v">${money(cost)}</div><div class="s">+ ${money(roomSpend)} en agentes de salas</div></div>
      <div class="kpi"><div class="k"><${Icon} name="cpu" />Tokens</div><div class="v">${tokens(tok)}</div><div class="s">${tok ? Math.round((100 * cacheRead) / tok) : 0}% servido desde caché</div></div>
      <div class="kpi"><div class="k"><${Icon} name="zap" />Peticiones</div><div class="v">${req.toLocaleString('es-CO')}</div><div class="s">al modelo</div></div>
      <div class="kpi"><div class="k"><${Icon} name="sessions" />Sesiones</div><div class="v">${list.length}</div><div class="s">${list.filter((s) => s.status === 'busy' && s.alive).length} trabajando</div></div>
    </div>

    <div class="section-title"><${Icon} name="user" />Suscripciones<span class="dim">el uso llega del cockpit y de los agentes; “Actualizar” lo consulta al momento</span></div>
    ${signed.length ? html`<div class="cards">${signed.map((a) => html`<${SubscriptionCard} a=${a} usage=${usage[a.configDir]} sessions=${sessions} />`)}</div>`
      : html`<${Empty} icon="user" title="Sin cuentas con sesión iniciada" />`}

    <div class="home-grid" style="grid-template-columns:1fr 1fr">
      <div class="card"><div class="card-head"><h3>Costo por sesión</h3><span class="dim" style="font-size:12px">top 12</span></div><div class="card-body"><${HBars} rows=${byCost} format=${money} empty="Sin costo registrado todavía." /></div></div>
      <div class="card"><div class="card-head"><h3>Tokens por sesión</h3><span class="dim" style="font-size:12px">entrada + salida + caché</span></div><div class="card-body"><${HBars} rows=${byTok} format=${tokens} empty="Sin tokens registrados todavía." /></div></div>
    </div>

    <div class="section-title"><${Icon} name="list" />Todas las sesiones<span class="dim">${rows.length}</span></div>
    <div class="card table-wrap">
      <table class="table">
        <thead><tr>${COLUMNS.map((c) => html`<th class=${c.num ? 'num' : ''} onClick=${() => setSort({ key: c.key, dir: sort.key === c.key ? -sort.dir : c.num ? -1 : 1 })}>
          ${c.label}${sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`)}</tr></thead>
        <tbody>${rows.map((s) => {
          const st = sessionState(s);
          return html`<tr onClick=${() => navigate('/sessions/' + s.id)} style="cursor:pointer">
            <td><span class="row"><span class=${'dot ' + st.cls}></span>${s.name}</span></td>
            <td class="muted">${s.source === 'antigravity' ? 'Antigravity' : s.account || '—'}</td>
            <td class="muted">${st.label}</td>
            <td>${modelLabel(s.model) || '—'}</td>
            <td class="num">${s.ctxPct != null ? Math.round(s.ctxPct) + '%' : '—'}</td>
            <td class="num">${s.tokens ? tokens(s.tokens.in) : '—'}</td>
            <td class="num">${s.tokens ? tokens(s.tokens.out) : '—'}</td>
            <td class="num">${s.tokens ? tokens(s.tokens.cr + s.tokens.cc) : '—'}</td>
            <td class="num">${s.tokens ? s.tokens.req : '—'}</td>
            <td class="num">${money(s.cost)}</td>
          </tr>`;
        })}</tbody>
      </table>
    </div>
  </div>`;
}
