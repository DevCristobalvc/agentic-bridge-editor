'use strict';
// Conversation history and usage statistics across every account. Each transcript is parsed
// once, incrementally from its last byte offset, into per-file aggregates kept in
// ~/.agentic-bridge/history-index.json; queries (list, stats) only read those aggregates.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { readJson, writeJson, clip } = require('./util');
const sessions = require('./sessions');
const antigravity = require('./antigravity');

const INDEX_FILE = path.join(DATA_DIR, 'history-index.json');
const INDEX_VERSION = 4;
const CHUNK = 8 * 1024 * 1024;

// US$ per million tokens: input, output, cache read. Cache writes cost 1.25x input (5 min)
// or 2x input (1 h). Equivalent API prices, used only to estimate value: subscriptions don't bill per token.
const PRICES = [
  [/(fable|mythos)-5-1/, 10, 50, 0.25],
  [/(fable|mythos)-5/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-9])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku/, 0.8, 4, 0.08],
];
function priceOf(model) {
  const m = String(model || '').toLowerCase();
  const hit = PRICES.find(([re]) => re.test(m));
  return hit ? { in: hit[1], out: hit[2], cr: hit[3] } : null;
}
function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return 0;
  return (u.in * p.in + u.out * p.out + u.cr * p.cr + u.cc5 * p.in * 1.25 + u.cc1h * p.in * 2) / 1e6;
}

const HARNESS_TAGS = /<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|bash-[a-z-]+|task-notification)>[\s\S]*?<\/\1>/g;
function textOf(content) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
  return raw.replace(HARNESS_TAGS, '').trim();
}
const isToolResult = (content) => Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');

function dayOf(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- index ----------
let index = readJson(INDEX_FILE, null);
if (!index || index.version !== INDEX_VERSION) index = { version: INDEX_VERSION, files: {} };
let dirty = false;
let scanning = null;
let lastScanAt = 0;
let progress = { done: 0, total: 0, running: false };

function emptyEntry(file, configDir, sessionId, parent) {
  return {
    file, configDir, sessionId, parent: parent || null, offset: 0, size: 0, mtime: 0,
    entrypoint: null, cwd: null, branch: null, version: null, startedAt: null, lastAt: null,
    customTitle: null, aiTitle: null, summary: null, firstPrompt: null, lastPrompt: null,
    prompts: 0, replies: 0, images: 0, recent: [],
    dm: {},   // "day|model" -> [in, out, cacheRead, cacheWrite, cost, requests]
    dp: {},   // day -> prompts
    dh: {},   // "day|hour" -> requests
    dt: {},   // "day|tool" -> calls
  };
}

function listTranscripts() {
  const out = [];
  for (const acct of sessions.accounts()) {
    const root = path.join(acct.configPath, 'projects');
    let projects = [];
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { continue; }
    for (const p of projects) {
      const dir = path.join(root, p);
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const n of names) {
        if (n.isFile() && n.name.endsWith('.jsonl')) out.push({ file: path.join(dir, n.name), configDir: acct.configDir, sessionId: n.name.slice(0, -6) });
        else if (n.isDirectory()) {
          const sub = path.join(dir, n.name, 'subagents');
          let subs = [];
          try { subs = fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')); } catch (e) { continue; }
          for (const f of subs) out.push({ file: path.join(sub, f), configDir: acct.configDir, sessionId: f.slice(0, -6), parent: n.name });
        }
      }
    }
  }
  return out;
}

function ingest(e, o) {
  if (!o || typeof o !== 'object') return;
  const t = o.timestamp ? Date.parse(o.timestamp) : null;
  if (o.cwd && !e.cwd) e.cwd = o.cwd;
  if (o.entrypoint && !e.entrypoint) e.entrypoint = o.entrypoint;
  if (o.gitBranch) e.branch = o.gitBranch;
  if (o.version) e.version = o.version;
  if (t) { if (!e.startedAt) e.startedAt = t; e.lastAt = t; }
  switch (o.type) {
    case 'custom-title': if (o.customTitle) e.customTitle = clip(o.customTitle, 120); return;
    case 'ai-title': if (o.aiTitle) e.aiTitle = clip(o.aiTitle, 120); return;
    case 'summary': if (o.summary && !e.summary) e.summary = clip(o.summary, 160); return;
    case 'last-prompt': if (o.lastPrompt) e.lastPrompt = clip(textOf(o.lastPrompt), 200); return;
    default: break;
  }
  const m = o.message;
  if (!m || o.isMeta) return;
  if (o.type === 'user' && !o.isSidechain && !isToolResult(m.content)) {
    const text = textOf(m.content);
    if (Array.isArray(m.content)) e.images += m.content.filter((b) => b && b.type === 'image').length;
    if (!text) return;
    e.prompts++;
    if (!e.firstPrompt) e.firstPrompt = clip(text, 240);
    e.lastPrompt = clip(text, 200);
    if (t) { const d = dayOf(t); e.dp[d] = (e.dp[d] || 0) + 1; }
    return;
  }
  if (o.type !== 'assistant') return;
  const d = t ? dayOf(t) : 'sin-fecha';
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === 'tool_use' && b.name) { const k = d + '|' + b.name; e.dt[k] = (e.dt[k] || 0) + 1; }
      if (b && b.type === 'text' && b.text && !o.isSidechain) e.replies++;
    }
  }
  const u = m.usage;
  if (!u || !m.model || m.model === '<synthetic>') return;
  // One API message is written as several lines (one per content block) with the same usage.
  const id = m.id || o.requestId;
  if (id) {
    if (e.recent.includes(id)) return;
    e.recent.push(id);
    if (e.recent.length > 40) e.recent.shift();
  }
  const cc = u.cache_creation || {};
  const cc1h = cc.ephemeral_1h_input_tokens || 0;
  const ccAll = u.cache_creation_input_tokens || 0;
  const usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cc5: Math.max(0, ccAll - cc1h), cc1h };
  const k = d + '|' + m.model;
  const row = e.dm[k] || (e.dm[k] = [0, 0, 0, 0, 0, 0]);
  row[0] += usage.in; row[1] += usage.out; row[2] += usage.cr; row[3] += ccAll; row[4] += costOf(m.model, usage); row[5] += 1;
  if (t) { const h = d + '|' + new Date(t).getHours(); e.dh[h] = (e.dh[h] || 0) + 1; }
}

function readFrom(file, offset, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(CHUNK, size - offset);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, offset);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

const tick = () => new Promise((r) => setImmediate(r));

async function indexFile(t) {
  let st;
  try { st = fs.statSync(t.file); } catch (e) { return; }
  let e = index.files[t.file];
  if (e && st.size < e.offset) e = null; // rewritten
  if (!e) e = index.files[t.file] = emptyEntry(t.file, t.configDir, t.sessionId, t.parent);
  e.mtime = st.mtimeMs;
  e.size = st.size;
  while (e.offset < st.size) {
    const buf = readFrom(t.file, e.offset, st.size);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl === -1) {
      if (buf.length < CHUNK) break; // a line still being written
      e.offset += buf.length; // a single line bigger than a chunk: skip it
      continue;
    }
    const text = buf.subarray(0, lastNl).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let o;
      try { o = JSON.parse(line); } catch (err) { continue; }
      ingest(e, o);
    }
    e.offset += lastNl + 1;
    dirty = true;
    await tick();
  }
}

async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const list = listTranscripts();
    const seen = new Set(list.map((t) => t.file));
    for (const f of Object.keys(index.files)) if (!seen.has(f)) { delete index.files[f]; dirty = true; }
    progress = { done: 0, total: list.length, running: true };
    let savedAt = Date.now();
    for (const t of list) {
      const e = index.files[t.file];
      let st = null;
      try { st = fs.statSync(t.file); } catch (err) {}
      if (st && (!e || e.size !== st.size || e.mtime !== st.mtimeMs)) await indexFile(t);
      progress.done++;
      // A long first scan saves as it goes, so a restart resumes instead of starting over.
      if (dirty && Date.now() - savedAt > 15000) { writeJson(INDEX_FILE, index); dirty = false; savedAt = Date.now(); }
    }
    progress.running = false;
    lastScanAt = Date.now();
    if (dirty) { writeJson(INDEX_FILE, index); dirty = false; }
  })();
  try { await scanning; } finally { scanning = null; }
}

function ensureFresh(maxAgeMs) {
  if (Date.now() - lastScanAt > (maxAgeMs || 30000)) scan().catch((e) => console.error('[history]', e.message));
  return scanning;
}

// ---------- queries ----------
function accountsByDir() {
  const m = new Map();
  for (const a of sessions.accounts()) m.set(a.configDir, a.email || a.configDir);
  return m;
}

function sumRows(e, from) {
  const tot = { in: 0, out: 0, cr: 0, cc: 0, cost: 0, req: 0 };
  const models = new Set();
  for (const [k, r] of Object.entries(e.dm)) {
    const [d, model] = k.split('|');
    if (from && d < from) continue;
    tot.in += r[0]; tot.out += r[1]; tot.cr += r[2]; tot.cc += r[3]; tot.cost += r[4]; tot.req += r[5];
    models.add(model);
  }
  return { tot, models: [...models] };
}

function conversations(filter) {
  const f = filter || {};
  const accts = accountsByDir();
  const children = new Map();
  for (const e of Object.values(index.files)) {
    if (!e.parent) continue;
    const list = children.get(e.parent) || [];
    list.push(e);
    children.set(e.parent, list);
  }
  const out = [];
  for (const e of Object.values(index.files)) {
    if (e.parent || (!e.prompts && !e.replies)) continue;
    const { tot, models } = sumRows(e);
    for (const c of children.get(e.sessionId) || []) {
      const s = sumRows(c).tot;
      tot.in += s.in; tot.out += s.out; tot.cr += s.cr; tot.cc += s.cc; tot.cost += s.cost; tot.req += s.req;
    }
    out.push({
      id: e.sessionId, source: 'claude', configDir: e.configDir, account: accts.get(e.configDir) || e.configDir,
      title: e.customTitle || e.aiTitle || e.summary || e.firstPrompt || '(sin título)',
      customTitle: e.customTitle, firstPrompt: e.firstPrompt, lastPrompt: e.lastPrompt,
      cwd: e.cwd, project: e.cwd ? path.basename(e.cwd) : null, branch: e.branch, version: e.version,
      startedAt: e.startedAt, lastAt: e.lastAt || e.mtime, prompts: e.prompts, replies: e.replies, images: e.images,
      tokens: tot.in + tot.out + tot.cr + tot.cc, cost: tot.cost, requests: tot.req, models, size: e.size,
      subagents: (children.get(e.sessionId) || []).length,
      // `claude -p` runs (room agents, probes) are not conversations the person had.
      headless: e.entrypoint === 'sdk-cli',
    });
  }
  for (const c of antigravity.conversations()) {
    out.push({
      id: c.id, source: 'antigravity', configDir: null, account: 'Antigravity', title: c.title || '(sin título)',
      firstPrompt: c.preview, cwd: c.workspaces[0] || null, project: c.workspaces[0] ? path.basename(c.workspaces[0]) : null,
      startedAt: null, lastAt: c.updatedAt, prompts: null, replies: null, steps: c.steps, tokens: null, cost: null, models: [], status: c.status,
    });
  }
  const q = String(f.q || '').toLowerCase().trim();
  return out
    .filter((c) => (!f.source || c.source === f.source) && (!f.configDir || c.configDir === f.configDir) && (f.all || !c.headless))
    .filter((c) => !f.cwd || (c.cwd && c.cwd.toLowerCase().replace(/[\\/]+$/, '').startsWith(String(f.cwd).toLowerCase().replace(/[\\/]+$/, ''))))
    .filter((c) => !q || [c.title, c.firstPrompt, c.lastPrompt, c.cwd, c.branch, c.id].some((v) => v && String(v).toLowerCase().includes(q)))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

function stats(opts) {
  const o = opts || {};
  const days = Math.max(1, Math.min(3650, Number(o.days) || 30));
  const now = new Date();
  const fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const from = dayOf(fromDate.getTime());
  const accts = accountsByDir();
  const daily = new Map();
  for (let i = 0; i < days; i++) daily.set(dayOf(new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + i).getTime()), { date: null, cost: 0, tokens: 0, out: 0, req: 0, prompts: 0 });
  const byModel = new Map();
  const byProject = new Map();
  const byAccount = new Map();
  const byTool = new Map();
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const tot = { in: 0, out: 0, cr: 0, cc: 0, cost: 0, req: 0, prompts: 0 };
  const convs = new Set();
  const cwdOf = new Map();
  for (const e of Object.values(index.files)) if (!e.parent) cwdOf.set(e.sessionId, e.cwd);

  for (const e of Object.values(index.files)) {
    if (o.configDir && e.configDir !== o.configDir) continue;
    const cwd = e.cwd || cwdOf.get(e.parent) || null;
    if (o.cwd && !(cwd && cwd.toLowerCase().startsWith(String(o.cwd).toLowerCase()))) continue;
    const project = cwd ? path.basename(cwd) : '(sin carpeta)';
    let touched = false;
    for (const [k, r] of Object.entries(e.dm)) {
      const [d, model] = k.split('|');
      if (d < from || !daily.has(d)) continue;
      touched = true;
      const tokens = r[0] + r[1] + r[2] + r[3];
      tot.in += r[0]; tot.out += r[1]; tot.cr += r[2]; tot.cc += r[3]; tot.cost += r[4]; tot.req += r[5];
      const day = daily.get(d);
      day.cost += r[4]; day.tokens += tokens; day.out += r[1]; day.req += r[5];
      const add = (map, key, extra) => {
        const v = map.get(key) || Object.assign({ key, cost: 0, tokens: 0, req: 0 }, extra || {});
        v.cost += r[4]; v.tokens += tokens; v.req += r[5];
        map.set(key, v);
      };
      add(byModel, model);
      add(byProject, project, { cwd });
      // Config dirs signed into the same email are one subscription.
      add(byAccount, accts.get(e.configDir) || e.configDir, { account: accts.get(e.configDir) || e.configDir });
    }
    for (const [d, n] of Object.entries(e.dp)) {
      if (d < from || !daily.has(d)) continue;
      daily.get(d).prompts += n;
      tot.prompts += n;
      touched = true;
    }
    for (const [k, n] of Object.entries(e.dh)) {
      const [d, h] = k.split('|');
      if (d < from || !daily.has(d)) continue;
      const [y, mo, da] = d.split('-').map(Number);
      heat[new Date(y, mo - 1, da).getDay()][Number(h)] += n;
    }
    for (const [k, n] of Object.entries(e.dt)) {
      const [d, name] = k.split('|');
      if (d < from || !daily.has(d)) continue;
      byTool.set(name, (byTool.get(name) || 0) + n);
    }
    if (touched) convs.add(e.parent || e.sessionId);
  }

  const dailyList = [...daily.entries()].map(([date, v]) => Object.assign(v, { date }));
  const activeDays = dailyList.filter((d) => d.req || d.prompts).length;
  let streak = 0;
  for (let i = dailyList.length - 1; i >= 0; i--) {
    if (dailyList[i].req || dailyList[i].prompts) streak++;
    else if (i === dailyList.length - 1) continue; // today may not have started yet
    else break;
  }
  const sorted = (m) => [...m.values()].sort((a, b) => b.cost - a.cost);
  return {
    days, from, to: dayOf(now.getTime()),
    totals: Object.assign(tot, { tokens: tot.in + tot.out + tot.cr + tot.cc, conversations: convs.size, activeDays, streak }),
    daily: dailyList,
    byModel: sorted(byModel),
    byProject: sorted(byProject).slice(0, 25),
    byAccount: sorted(byAccount),
    byTool: [...byTool.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    heat,
    indexing: Object.assign({}, progress),
  };
}

// ---------- reading one conversation ----------
function fileOf(id) {
  const hit = Object.values(index.files).find((e) => e.sessionId === id && !e.parent);
  if (hit && fs.existsSync(hit.file)) return hit.file;
  const found = sessions.findTranscriptAnywhere(id);
  return found ? found.file : null;
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.notebook_path || input.command || input.pattern || input.url || input.query || input.description || input.prompt || input.skill || '';
  return clip(String(v || JSON.stringify(input)).replace(/\s+/g, ' '), 240);
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[imagen]' : '')).join('\n');
  return '';
}

async function transcript(id, opts) {
  const o = opts || {};
  if (o.source === 'antigravity') return Object.assign({ source: 'antigravity' }, antigravity.transcript(id, o.limit || 3000));
  const file = fileOf(id);
  if (!file) return { entries: [], truncated: false, error: 'No encontré el transcript' };
  const entries = [];
  const byTool = new Map();
  const st = fs.statSync(file);
  let offset = 0;
  while (offset < st.size) {
    const buf = readFrom(file, offset, st.size);
    const lastNl = buf.lastIndexOf(10);
    const cut = lastNl === -1 ? buf.length : lastNl + 1;
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let ob;
      try { ob = JSON.parse(line); } catch (e) { continue; }
      if (!ob || ob.isSidechain || ob.isMeta || !ob.message) continue;
      const at = ob.timestamp || null;
      const content = ob.message.content;
      if (ob.type === 'user') {
        if (isToolResult(content)) {
          for (const b of content) {
            if (b.type !== 'tool_result') continue;
            const target = byTool.get(b.tool_use_id);
            if (target) { target.result = clip(resultText(b.content), 4000); target.error = !!b.is_error; }
          }
          continue;
        }
        const text = textOf(content);
        const images = Array.isArray(content) ? content.filter((b) => b && b.type === 'image').length : 0;
        if (text || images) entries.push({ role: 'user', text: clip(text, 40000), images, at });
      } else if (ob.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && b.text && b.text.trim()) entries.push({ role: 'assistant', text: clip(b.text.trim(), 60000), at, model: ob.message.model });
          else if (b.type === 'tool_use') {
            const ent = { role: 'tool', name: b.name, text: summarizeInput(b.input), input: clip(JSON.stringify(b.input, null, 2), 6000), at };
            byTool.set(b.id, ent);
            entries.push(ent);
          }
        }
      }
    }
    offset += cut;
    await tick();
  }
  const limit = Math.min(20000, o.limit || 4000);
  return { source: 'claude', entries: entries.slice(-limit), truncated: entries.length > limit, total: entries.length };
}

// ---------- full-text search ----------
async function search(q, opts) {
  const needle = String(q || '').toLowerCase().trim();
  if (needle.length < 2) return [];
  const o = opts || {};
  const deadline = Date.now() + (o.budgetMs || 6000);
  const hits = [];
  const files = Object.values(index.files).filter((e) => !e.parent).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  for (const e of files) {
    if (Date.now() > deadline || hits.length >= (o.limit || 40)) break;
    let st;
    try { st = fs.statSync(e.file); } catch (err) { continue; }
    let offset = 0;
    let found = 0;
    while (offset < st.size && found < 3 && Date.now() < deadline) {
      const buf = readFrom(e.file, offset, st.size);
      const lastNl = buf.lastIndexOf(10);
      const cut = lastNl === -1 ? buf.length : lastNl + 1;
      const text = buf.subarray(0, cut).toString('utf8');
      const lower = text.toLowerCase();
      let i = lower.indexOf(needle);
      while (i !== -1 && found < 3) {
        const start = text.lastIndexOf('\n', i) + 1;
        let end = text.indexOf('\n', i);
        if (end === -1) end = text.length;
        let ob = null;
        try { ob = JSON.parse(text.slice(start, end)); } catch (err) {}
        if (ob && ob.message && (ob.type === 'user' || ob.type === 'assistant') && !ob.isMeta) {
          const body = ob.type === 'user' && isToolResult(ob.message.content) ? '' : textOf(ob.message.content);
          const j = body.toLowerCase().indexOf(needle);
          if (j !== -1) {
            found++;
            hits.push({ id: e.sessionId, role: ob.type, at: ob.timestamp, snippet: (j > 80 ? '…' : '') + body.slice(Math.max(0, j - 80), j + needle.length + 120).replace(/\s+/g, ' ') + (j + needle.length + 120 < body.length ? '…' : '') });
          }
        }
        i = lower.indexOf(needle, end);
      }
      offset += cut;
      await tick();
    }
  }
  return hits;
}

module.exports = { scan, ensureFresh, conversations, stats, transcript, search, progress: () => progress, priceOf };
