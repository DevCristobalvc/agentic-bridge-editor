// Metrics: history-wide usage (from every transcript), subscription windows over time,
// and the live sessions table. Charts use one purple hue; values are always shown as text too.
import { html, useEffect, useMemo, useState } from '/vendor/htm-preact.js';
import { api, useStore } from '../api.js';
import { Btn, Icon, Empty, Seg, Sparkline, money, tokens, ago, useNow, sessionState, modelLabel, attempt, useLocal, uniqueAccounts, sourceLabel } from '../ui.js';
import { UsageBars } from './home.js';
import { navigate } from '../router.js';

const totalTok = (s) => (s.tokens ? s.tokens.in + s.tokens.out + s.tokens.cr + s.tokens.cc : 0);
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

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
    ${tip && tip.r.tip ? html`<div class="chart-tip" style=${{ left: Math.min(tip.x + 14, 9999) + 'px', top: tip.y + 12 + 'px' }}>
      <b>${tip.r.label}</b>${tip.r.tip.map((l) => html`<div><span class="muted">${l[0]}</span> ${l[1]}</div>`)}
    </div>` : null}
  </div>`;
}

function ColumnChart({ daily, metric }) {
  const [tip, setTip] = useState(null);
  const val = (d) => (metric === 'cost' ? d.cost : metric === 'tokens' ? d.tokens : d.prompts);
  const fmt = metric === 'cost' ? money : metric === 'tokens' ? tokens : (n) => String(n);
  const max = Math.max(...daily.map(val)) || 1;
  const mid = daily[Math.floor(daily.length / 2)];
  return html`<div class="chart-wrap" onMouseLeave=${() => setTip(null)}>
    <div class="colchart" role="img" aria-label=${'Serie diaria de ' + (metric === 'cost' ? 'valor equivalente' : metric === 'tokens' ? 'tokens' : 'mensajes')}>
      ${daily.map((d) => html`<div class=${'c' + (val(d) ? '' : ' zero')}
          onMouseMove=${(e) => { const b = e.currentTarget.parentNode.parentNode.getBoundingClientRect(); setTip({ d, x: e.clientX - b.left, y: e.clientY - b.top }); }}>
        <i style=${{ height: Math.max(val(d) ? 2 : 1, (100 * val(d)) / max) + '%' }}></i>
      </div>`)}
    </div>
    <div class="colaxis"><span>${fmtDate(daily[0].date)}</span>${mid ? html`<span>${fmtDate(mid.date)}</span>` : null}<span>${fmtDate(daily[daily.length - 1].date)}</span></div>
    ${tip ? html`<div class="chart-tip" style=${{ left: Math.min(tip.x + 12, 9999) + 'px', top: Math.max(0, tip.y - 70) + 'px' }}>
      <b>${new Date(tip.d.date + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}</b>
      <div><span class="muted">Equivalente API</span> ${money(tip.d.cost)}</div>
      <div><span class="muted">Tokens</span> ${tokens(tip.d.tokens)}</div>
      <div><span class="muted">Mensajes tuyos</span> ${tip.d.prompts}</div>
      <div><span class="muted">Peticiones</span> ${tip.d.req}</div>
    </div>` : null}
  </div>`;
}

function Heatmap({ heat }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(1, ...heat.flat());
  const step = (n) => (n ? Math.min(5, Math.ceil((5 * n) / max)) : 0);
  const bg = (n) => { const s = step(n); return s ? 'color-mix(in srgb, var(--v-500) ' + (s * 20) + '%, var(--surface-3))' : 'var(--surface-3)'; };
  const order = [1, 2, 3, 4, 5, 6, 0];
  return html`<div class="chart-wrap" onMouseLeave=${() => setTip(null)}>
    <div class="heat" role="img" aria-label="Actividad por día de la semana y hora">
      <span></span>${Array.from({ length: 24 }, (_, h) => html`<span class="hr">${h % 3 === 0 ? h : ''}</span>`)}
      ${order.map((d) => html`<span class="lbl">${DAYS[d]}</span>${heat[d].map((n, h) => html`<span class="cell" style=${{ background: bg(n) }}
        onMouseMove=${(e) => { const b = e.currentTarget.parentNode.getBoundingClientRect(); setTip({ d, h, n, x: e.clientX - b.left, y: e.clientY - b.top }); }}></span>`)}`)}
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:8px"><span class="legend-scale">menos ${[0, 1, 2, 3, 4, 5].map((s) => html`<i style=${{ background: s ? 'color-mix(in srgb, var(--v-500) ' + s * 20 + '%, var(--surface-3))' : 'var(--surface-3)' }}></i>`)} más</span></div>
    ${tip ? html`<div class="chart-tip" style=${{ left: tip.x + 12 + 'px', top: Math.max(0, tip.y - 50) + 'px' }}><b>${DAYS[tip.d]} · ${tip.h}:00–${tip.h + 1}:00</b><div>${tip.n} peticiones al modelo</div></div>` : null}
  </div>`;
}

function SubscriptionCard({ a, usage, sessions, history }) {
  const [busy, setBusy] = useState(false);
  const now = useNow(30000);
  const mine = sessions.filter((s) => a.dirs.includes(s.configDir));
  const alive = mine.filter((s) => s.alive);
  const points = a.dirs.flatMap((d) => (history && history[d]) || []).sort((x, y) => x.at - y.at);
  const refresh = async () => {
    setBusy(true);
    const r = await attempt(() => api.post('/api/accounts/' + encodeURIComponent(a.configDir) + '/usage'));
    setBusy(false);
    if (r && !r.ok) attempt(() => Promise.reject(new Error('La cuenta no devolvió datos de uso.')));
  };
  return html`<div class="card sub-card">
    <div class="row">
      <div class="avatar human">${(a.displayName || a.email || '?').charAt(0).toUpperCase()}</div>
      <div class="grow"><b class="ellipsis" style="display:block">${a.email}</b><span class="muted" style="font-size:12px">${a.displayName || ''}${a.org ? ' · ' + a.org : ''}</span></div>
      <span class="chip mono">${a.dirs.join(' · ')}</span>
    </div>
    <div class="row wrap">
      ${a.orgType ? html`<span class="chip accent">${a.orgType.replace('claude_', 'Claude ')}</span>` : null}
      ${a.seatTier ? html`<span class="chip">${a.seatTier.replace(/_/g, ' ')}</span>` : null}
      ${a.billingType ? html`<span class="chip">${a.billingType.replace(/_/g, ' ')}</span>` : null}
    </div>
    <${UsageBars} usage=${usage} />
    <div class="row" style="font-size:12px;gap:10px"><span class="muted">Ventana de 5 h, últimos días</span><span class="grow"></span><${Sparkline} values=${points.map((p) => p.h5)} max=${100} width=${150} label="Uso de la ventana de 5 horas" /></div>
    <div class="row" style="font-size:12.5px;border-top:1px solid var(--line);padding-top:10px;margin-top:auto">
      <div class="col grow" style="gap:1px">
        <span><b>${alive.length}</b> <span class="muted">vivas de ${mine.length}</span></span>
        <span class="dim" style="font-size:11.5px">${usage ? 'uso leído ' + ago(usage.at, now) + ' desde ' + (usage.source === 'cockpit' ? 'el cockpit' : usage.source === 'agent' ? 'un agente' : 'un sondeo') : 'sin lectura de uso'}</span>
      </div>
      <${Btn} size="sm" icon="refresh" busy=${busy} onClick=${refresh} title="Hace una consulta mínima con Haiku para leer el uso">Actualizar<//>
    </div>
  </div>`;
}

const COLUMNS = [
  { key: 'name', label: 'Sesión', get: (s) => s.name.toLowerCase() },
  { key: 'account', label: 'Cuenta', get: (s) => sourceLabel(s) },
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
  const [days, setDays] = useLocal('metricsDays', '30');
  const [acct, setAcct] = useState('');
  const [metric, setMetric] = useLocal('metricsMetric', 'cost');
  const [scope, setScope] = useLocal('metricsScope', 'alive');
  const [sort, setSort] = useState({ key: 'cost', dir: -1 });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  const dirsOf = (email) => accounts.filter((a) => a.email === email).map((a) => a.configDir);
  const load = async () => {
    setLoading(true);
    try {
      const dirs = acct ? dirsOf(acct) : [];
      // Several config dirs can share an email: ask for each and add them up.
      const parts = dirs.length ? await Promise.all(dirs.map((d) => api.get('/api/stats?days=' + days + '&configDir=' + encodeURIComponent(d)))) : [await api.get('/api/stats?days=' + days)];
      setStats(parts.length === 1 ? parts[0] : combine(parts));
    } catch (e) { attempt(() => Promise.reject(e)); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [days, acct]);
  useEffect(() => {
    if (!stats || !stats.indexing || !stats.indexing.running) return undefined;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [stats]);

  const list = scope === 'alive' ? sessions.filter((s) => s.alive) : sessions;
  const signed = uniqueAccounts(accounts, usage, sessions);
  const emails = [...new Set(accounts.filter((a) => a.email).map((a) => a.email))];
  const col = COLUMNS.find((c) => c.key === sort.key);
  const rows = useMemo(() => list.slice().sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
  }), [list, sort]);
  const t = stats && stats.totals;
  const cacheShare = t && t.tokens ? Math.round((100 * t.cr) / t.tokens) : 0;
  const barRow = (label, v, extra) => Object.assign({ label, value: v.cost, tip: [['Equivalente API', money(v.cost)], ['Tokens', tokens(v.tokens)], ['Peticiones', String(v.req)]] }, extra || {});

  return html`<div class="page">
    <div class="page-head">
      <div><h2>Métricas</h2><p>Todo tu uso, leído de los transcripts de todas tus cuentas. El valor es el equivalente en precios de la API: lo que tu suscripción te ahorra.</p></div>
    </div>
    <div class="filters">
      <${Seg} value=${days} onChange=${setDays} options=${[{ value: '7', label: '7 días' }, { value: '30', label: '30 días' }, { value: '90', label: '90 días' }, { value: '365', label: 'Un año' }]} />
      <select class="select sm" style="width:auto" value=${acct} onChange=${(e) => setAcct(e.target.value)}><option value="">Todas las cuentas</option>${emails.map((m) => html`<option value=${m}>${m}</option>`)}</select>
      <span class="grow"></span>
      ${stats && stats.indexing && stats.indexing.running ? html`<span class="row muted" style="font-size:12px"><span class="spinner"></span>Indexando ${stats.indexing.done}/${stats.indexing.total}</span>` : null}
      <${Btn} size="sm" icon="refresh" busy=${loading} onClick=${load}>Actualizar<//>
    </div>

    ${t ? html`<div class="kpis" style="margin-top:0">
      <div class="kpi"><div class="k"><${Icon} name="dollar" />Equivalente API</div><div class="v">${money(t.cost)}</div><div class="s">en ${stats.days} días · ${money(t.cost / Math.max(1, t.activeDays))} por día activo</div></div>
      <div class="kpi"><div class="k"><${Icon} name="cpu" />Tokens</div><div class="v">${tokens(t.tokens)}</div><div class="s">${cacheShare}% leídos de caché · ${tokens(t.out)} escritos</div></div>
      <div class="kpi"><div class="k"><${Icon} name="message" />Conversaciones</div><div class="v">${t.conversations}</div><div class="s">${t.prompts} mensajes tuyos · ${t.req.toLocaleString('es-CO')} peticiones</div></div>
      <div class="kpi"><div class="k"><${Icon} name="flame" />Días activos</div><div class="v">${t.activeDays}</div><div class="s">racha actual: ${t.streak} día${t.streak === 1 ? '' : 's'}</div></div>
    </div>` : html`<div class="row muted"><span class="spinner"></span>Calculando…</div>`}

    ${stats ? html`
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>Día a día</h3><span class="grow"></span>
          <${Seg} value=${metric} onChange=${setMetric} options=${[{ value: 'cost', label: 'Equivalente API' }, { value: 'tokens', label: 'Tokens' }, { value: 'prompts', label: 'Mensajes' }]} /></div>
        <div class="card-body"><${ColumnChart} daily=${stats.daily} metric=${metric} /></div>
      </div>
      <div class="home-grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><div class="card-head"><h3>Por modelo</h3></div><div class="card-body"><${HBars} rows=${stats.byModel.map((m) => barRow(modelLabel(m.key) || m.key, m))} format=${money} empty="Sin uso en el periodo." /></div></div>
        <div class="card"><div class="card-head"><h3>Por proyecto (carpeta)</h3><span class="dim" style="font-size:12px">top ${Math.min(10, stats.byProject.length)}</span></div><div class="card-body"><${HBars} rows=${stats.byProject.slice(0, 10).map((p) => barRow(p.key, p, { onClick: p.cwd ? () => navigate('/files?path=' + encodeURIComponent(p.cwd)) : null }))} format=${money} empty="Sin uso en el periodo." /></div></div>
      </div>
      <div class="home-grid" style="grid-template-columns:1.3fr 1fr">
        <div class="card"><div class="card-head"><h3>Cuándo trabajas</h3><span class="dim" style="font-size:12px">peticiones por hora</span></div><div class="card-body"><${Heatmap} heat=${stats.heat} /></div></div>
        <div class="card"><div class="card-head"><h3>Herramientas más usadas</h3></div><div class="card-body"><${HBars} rows=${stats.byTool.slice(0, 10).map((x) => ({ label: x.name, value: x.count, tip: [['Llamadas', String(x.count)]] }))} format=${(n) => n.toLocaleString('es-CO')} empty="Sin herramientas en el periodo." /></div></div>
      </div>
      ${stats.byAccount.length > 1 ? html`<div class="card" style="margin-top:16px"><div class="card-head"><h3>Por cuenta</h3></div><div class="card-body"><${HBars} rows=${stats.byAccount.map((a) => barRow(a.account, a))} format=${money} empty="" /></div></div>` : null}
    ` : null}

    <div class="section-title"><${Icon} name="user" />Suscripciones<span class="dim">el uso llega del cockpit y de los agentes; “Actualizar” lo consulta al momento</span></div>
    ${signed.length ? html`<div class="cards">${signed.map((a) => html`<${SubscriptionCard} a=${a} usage=${usage[a.configDir]} sessions=${sessions} history=${stats && stats.usageHistory} />`)}</div>`
      : html`<${Empty} icon="user" title="Sin cuentas con sesión iniciada" />`}

    <div class="section-title"><${Icon} name="list" />Sesiones<span class="dim">${rows.length}</span><span class="more"><${Seg} value=${scope} onChange=${setScope} options=${[{ value: 'alive', label: 'Vivas' }, { value: 'all', label: 'Todas' }]} /></span></div>
    <div class="card table-wrap">
      <table class="table">
        <thead><tr>${COLUMNS.map((c) => html`<th class=${c.num ? 'num' : ''} onClick=${() => setSort({ key: c.key, dir: sort.key === c.key ? -sort.dir : c.num ? -1 : 1 })}>
          ${c.label}${sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`)}</tr></thead>
        <tbody>${rows.map((s) => {
          const st = sessionState(s);
          return html`<tr onClick=${() => navigate('/sessions/' + s.id)} style="cursor:pointer">
            <td><span class="row"><span class=${'dot ' + st.cls}></span>${s.name}</span></td>
            <td class="muted">${sourceLabel(s)}</td>
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

// Add up stats of several config dirs that belong to the same subscription.
function combine(parts) {
  const out = JSON.parse(JSON.stringify(parts[0]));
  const sumKeys = ['in', 'out', 'cr', 'cc', 'cost', 'req', 'prompts', 'tokens', 'conversations'];
  const mergeList = (key, id) => {
    const m = new Map();
    for (const p of parts) for (const r of p[key]) {
      const k = r[id];
      const cur = m.get(k) || Object.assign({}, r, { cost: 0, tokens: 0, req: 0, count: 0 });
      cur.cost += r.cost || 0; cur.tokens += r.tokens || 0; cur.req += r.req || 0; cur.count += r.count || 0;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => (b.cost || b.count) - (a.cost || a.count));
  };
  for (const p of parts.slice(1)) {
    for (const k of sumKeys) out.totals[k] += p.totals[k] || 0;
    p.daily.forEach((d, i) => { const o = out.daily[i]; if (o) { o.cost += d.cost; o.tokens += d.tokens; o.prompts += d.prompts; o.req += d.req; } });
    p.heat.forEach((row, d) => row.forEach((n, h) => { out.heat[d][h] += n; }));
  }
  out.totals.activeDays = out.daily.filter((d) => d.req || d.prompts).length;
  out.byModel = mergeList('byModel', 'key');
  out.byProject = mergeList('byProject', 'key');
  out.byAccount = mergeList('byAccount', 'key');
  out.byTool = mergeList('byTool', 'name');
  return out;
}
