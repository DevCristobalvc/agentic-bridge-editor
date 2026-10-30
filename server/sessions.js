'use strict';
// Discovers every Claude Code session on the machine across accounts, plus Antigravity.
// Sources: each config dir's sessions/<pid>.json registry, the cockpit's shared crew board,
// Antigravity presence locks, and the session transcripts themselves (tokens, last messages).

const fs = require('fs');
const path = require('path');
const { HOME, CREW_DIR, AGY_DIR } = require('./config');
const { readJson, memoByFile, clip, readTail } = require('./util');
const store = require('./store');
const antigravity = require('./antigravity');
const { DATA_DIR } = require('./config');

const CREW_STALE_MS = 5 * 60 * 1000; // same threshold as the cockpit statusline
const TAIL_BYTES = 256 * 1024;

// ---------- accounts ----------
function configDirs() {
  let names = [];
  try { names = fs.readdirSync(HOME); } catch (e) { return []; }
  return names
    .filter((n) => n.startsWith('.claude'))
    .map((n) => path.join(HOME, n))
    .filter((d) => { try { return fs.statSync(path.join(d, 'sessions')).isDirectory(); } catch (e) { return false; } });
}

const readAccountFile = memoByFile((p) => {
  const a = (readJson(p) || {}).oauthAccount || {};
  return {
    email: a.emailAddress || null,
    displayName: a.displayName || a.fullName || null,
    org: a.organizationName || null,
    orgType: a.organizationType || null,
    seatTier: a.seatTier || null,
    billingType: a.billingType || null,
  };
});

function globalConfigFile(dir) {
  // The default ~/.claude keeps its global config beside it, as ~/.claude.json.
  const own = path.join(dir, '.claude.json');
  return fs.existsSync(own) ? own : path.join(path.dirname(dir), path.basename(dir) + '.json');
}

function accounts() {
  return configDirs().map((dir) => Object.assign(
    { configDir: path.basename(dir), configPath: dir, globalConfig: globalConfigFile(dir) },
    readAccountFile(globalConfigFile(dir)) || {},
  ));
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------- transcripts ----------
const transcriptPaths = new Map();
function findTranscript(dir, sid) {
  const hit = transcriptPaths.get(sid);
  if (hit && fs.existsSync(hit)) return hit;
  let projects = [];
  try { projects = fs.readdirSync(path.join(dir, 'projects')); } catch (e) { return null; }
  for (const p of projects) {
    const f = path.join(dir, 'projects', p, sid + '.jsonl');
    if (fs.existsSync(f)) { transcriptPaths.set(sid, f); return f; }
  }
  return null;
}

function findTranscriptAnywhere(sid) {
  for (const dir of configDirs()) {
    const f = findTranscript(dir, sid);
    if (f) return { file: f, configPath: dir };
  }
  return null;
}

const HARNESS_TAGS = /<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g;
function messageText(content) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
    : '';
  return raw.replace(HARNESS_TAGS, '').trim();
}

function scanExchange(file, size, window) {
  let user = null;
  let assistant = null;
  let lines;
  try { lines = readTail(file, size, window); } catch (e) { return null; }
  for (let i = lines.length - 1; i >= 0 && !(user && assistant); i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!o || o.isSidechain || o.isMeta || !o.message) continue;
    const t = messageText(o.message.content);
    if (!t) continue;
    const entry = { text: clip(t, 700), at: o.timestamp || null };
    if (o.type === 'assistant' && !assistant) assistant = entry;
    else if (o.type === 'user' && !user) user = entry;
  }
  return { user, assistant };
}

// Last user prompt and assistant reply. Tool output can bury them, so the window grows.
const lastExchange = memoByFile((file) => {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { return null; }
  for (let window = TAIL_BYTES; ; window *= 4) {
    const found = scanExchange(file, size, window);
    if (!found || (found.user && found.assistant) || window >= size) return found;
  }
});

// Token totals parsed incrementally from a byte offset, so cost doesn't grow with the file.
const tokenCache = new Map();
function tokenStats(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { return null; }
  let c = tokenCache.get(file);
  if (!c || c.offset > size) c = { offset: 0, in: 0, out: 0, cr: 0, cc: 0, req: 0, model: null, firstAt: null };
  if (size > c.offset) {
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(size - c.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
      fs.closeSync(fd);
      text = buf.subarray(0, n).toString('utf8');
    } catch (e) { return c; }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl !== -1) {
      const usable = text.slice(0, lastNl);
      for (const line of usable.split('\n')) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (!c.firstAt && o.timestamp) c.firstAt = o.timestamp;
        const m = o.message;
        if (!m || !m.usage) continue;
        // One API message is written as one line per content block, all with the same usage.
        if (m.id && m.id === c.lastId) continue;
        c.lastId = m.id || null;
        c.in += m.usage.input_tokens || 0;
        c.out += m.usage.output_tokens || 0;
        c.cr += m.usage.cache_read_input_tokens || 0;
        c.cc += m.usage.cache_creation_input_tokens || 0;
        c.req += 1;
        if (m.model && !o.isSidechain) c.model = m.model;
      }
      c.offset += Buffer.byteLength(usable, 'utf8') + 1;
    }
    tokenCache.set(file, c);
  }
  return c;
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.notebook_path || input.command || input.pattern || input.url
    || input.query || input.description || input.prompt || input.skill || '';
  return clip(String(v || JSON.stringify(input)).replace(/\s+/g, ' '), 160);
}

// A readable conversation: user and assistant text, with tool calls collapsed to one line.
function transcript(sessionId, limit = 200) {
  const found = findTranscriptAnywhere(sessionId);
  if (!found) return { entries: [], truncated: false };
  let size = 0;
  try { size = fs.statSync(found.file).size; } catch (e) { return { entries: [], truncated: false }; }
  const window = 6 * 1024 * 1024;
  let lines = [];
  try { lines = readTail(found.file, size, window); } catch (e) {}
  const entries = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || o.isSidechain || o.isMeta || !o.message) continue;
    const at = o.timestamp || null;
    const content = o.message.content;
    if (o.type === 'user') {
      const t = messageText(content);
      if (t) entries.push({ role: 'user', text: t, at });
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text && b.text.trim()) entries.push({ role: 'assistant', text: b.text.trim(), at });
        else if (b.type === 'tool_use') entries.push({ role: 'tool', name: b.name, text: summarizeInput(b.input), at });
      }
    }
  }
  return { entries: entries.slice(-limit), truncated: entries.length > limit || size > window };
}

// ---------- crew board & Antigravity ----------
function readCrew() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(CREW_DIR); } catch (e) { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(CREW_DIR, f);
    const o = readJson(p);
    if (!o || !o.session_id) continue;
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch (e) {}
    out.set(o.session_id, Object.assign({}, o, { _mtime: mtime }));
  }
  return out;
}

function agyIds() {
  try {
    return new Set(fs.readdirSync(path.join(AGY_DIR, 'presence')).filter((f) => f.endsWith('.lock')).map((f) => f.slice(0, -5)));
  } catch (e) { return new Set(); }
}

function crewView(c, now) {
  if (!c) return null;
  return {
    title: c.name || null,
    branch: c.branch || null,
    stack: Array.isArray(c.stack) ? c.stack : [],
    task: c.task || null,
    done: typeof c.done === 'number' ? c.done : null,
    total: typeof c.total === 'number' ? c.total : null,
    blocked: !!c.blocked,
    todoFile: c.todo_file || null,
    waitingOn: c.waiting_on || null,
    updatedAt: c.updated_at || c._mtime || null,
    stale: now - c._mtime > CREW_STALE_MS,
  };
}

// ---------- rate limits ----------
function pctOf(b) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.used_percentage === 'number') return b.used_percentage;
  if (typeof b.utilization === 'number') return b.utilization <= 1 && b._fraction ? b.utilization * 100 : b.utilization;
  if (typeof b.percentUsed === 'number') return b.percentUsed;
  if (typeof b.remaining_fraction === 'number') return 100 - b.remaining_fraction * 100;
  if (typeof b.remaining_percentage === 'number') return 100 - b.remaining_percentage;
  return null;
}

function resetOf(b) {
  const r = b && (b.resets_at || b.resetsAt || b.reset_time || b.resetAt);
  if (typeof r === 'number') return r < 1e11 ? r * 1000 : r;
  if (typeof r === 'string') { const t = Date.parse(r); return isNaN(t) ? null : t; }
  return null;
}

// Accepts the statusline payload's rate_limits or a stream-json rate_limit_event.
function normalizeLimits(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const windows = raw.unifiedWindows || raw;
  const fraction = !!raw.unifiedWindows;
  const out = { at: Date.now(), source };
  for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    const b = windows[key];
    if (!b) continue;
    const pct = pctOf(Object.assign({ _fraction: fraction }, b));
    if (pct == null) continue;
    out[key] = { pct: Math.max(0, Math.min(100, pct)), resetsAt: resetOf(b), status: b.status || null };
  }
  return out.five_hour || out.seven_day ? out : null;
}

function recordUsage(configDir, raw, source) {
  const n = normalizeLimits(raw, source);
  if (!n || !configDir) return;
  const prev = store.usage.get()[configDir];
  if (prev && prev.at > n.at - 15000 && JSON.stringify(prev.five_hour) === JSON.stringify(n.five_hour)) return;
  store.usage.update((u) => Object.assign({}, u, { [configDir]: n }));
  // Keep a time series for the subscription charts; one point per change is enough.
  const pct = (w) => (w ? Math.round(w.pct * 10) / 10 : null);
  if (!prev || pct(prev.five_hour) !== pct(n.five_hour) || pct(prev.seven_day) !== pct(n.seven_day)) {
    try { fs.appendFileSync(USAGE_LOG, JSON.stringify({ at: n.at, dir: configDir, h5: pct(n.five_hour), d7: pct(n.seven_day) }) + '\n'); } catch (e) {}
  }
}

const USAGE_LOG = path.join(DATA_DIR, 'usage-history.jsonl');

// The last `days` of subscription points, per config dir.
function usageHistory(days) {
  const since = Date.now() - (days || 7) * 86400000;
  const out = {};
  let lines = [];
  try { lines = fs.readFileSync(USAGE_LOG, 'utf8').split('\n'); } catch (e) { return out; }
  if (lines.length > 20000) {
    lines = lines.slice(-10000);
    try { fs.writeFileSync(USAGE_LOG, lines.join('\n')); } catch (e) {}
  }
  for (const l of lines) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (e) { continue; }
    if (o.at < since) continue;
    (out[o.dir] = out[o.dir] || []).push({ at: o.at, h5: o.h5, d7: o.d7 });
  }
  return out;
}

// ---------- snapshot ----------
let pidIndex = new Map(); // pid -> session id, for MCP identity lookups

function snapshot() {
  const now = Date.now();
  const crew = readCrew();
  const agy = agyIds();
  const aliasMap = store.aliases.get();
  const accts = accounts();
  const sessions = [];
  const pids = new Map();

  for (const acct of accts) {
    const dir = acct.configPath;
    let files = [];
    try { files = fs.readdirSync(path.join(dir, 'sessions')).filter((f) => /^\d+\.json$/.test(f)); } catch (e) {}
    for (const f of files) {
      const r = readJson(path.join(dir, 'sessions', f));
      if (!r || !r.sessionId) continue;
      const c = crew.get(r.sessionId);
      crew.delete(r.sessionId);
      const alive = isAlive(r.pid);
      if (alive) pids.set(r.pid, r.sessionId);
      const file = findTranscript(dir, r.sessionId);
      const tok = file ? tokenStats(file) : null;
      if (c && c.rate_limits) recordUsage(acct.configDir, c.rate_limits, 'cockpit');
      sessions.push({
        id: r.sessionId,
        name: aliasMap[r.sessionId] || r.name || (c && c.name) || r.sessionId.slice(0, 8),
        registryName: r.name || null,
        alias: aliasMap[r.sessionId] || null,
        source: 'claude',
        kind: r.kind || null,
        configDir: acct.configDir,
        configPath: dir,
        account: acct.email,
        pid: r.pid || null,
        alive,
        status: alive ? r.status || 'active' : 'closed',
        cwd: r.cwd || (c && c.cwd) || null,
        version: r.version || null,
        startedAt: r.startedAt || null,
        updatedAt: Math.max(r.statusUpdatedAt || r.updatedAt || 0, (c && c.updated_at) || 0) || null,
        crew: crewView(c, now),
        model: (c && c.model) || (tok && tok.model) || null,
        ctxPct: c && typeof c.ctx_pct === 'number' ? c.ctx_pct : null,
        cost: c && typeof c.cost_usd === 'number' ? c.cost_usd : null,
        tokens: tok ? { in: tok.in, out: tok.out, cr: tok.cr, cc: tok.cc, req: tok.req } : null,
        last: file ? lastExchange(file) : null,
      });
    }
  }

  // Antigravity conversations whose agy process is running (it holds the presence lock).
  const agySettings = antigravity.settings();
  const summaries = new Map(antigravity.conversations().map((c) => [c.id, c]));
  for (const id of antigravity.liveIds()) {
    const c = summaries.get(id) || { id, title: '', workspaces: [], status: '', updatedAt: null };
    const cr = crew.get(id);
    crew.delete(id);
    sessions.push({
      id,
      name: aliasMap[id] || (cr && cr.name) || c.title || 'antigravity ' + id.slice(0, 4),
      registryName: c.title || null,
      alias: aliasMap[id] || null,
      source: 'antigravity',
      kind: null,
      configDir: null,
      configPath: null,
      account: 'Antigravity',
      pid: null,
      alive: true,
      status: /running|busy|active/.test(c.status) ? 'busy' : 'idle',
      cwd: c.workspaces[0] || (cr && cr.cwd) || null,
      version: null,
      startedAt: antigravity.lockBirth(id) || null,
      updatedAt: Math.max(c.updatedAt || 0, (cr && cr.updated_at) || 0) || null,
      crew: crewView(cr, now),
      model: (cr && cr.model) || agySettings.model || null,
      ctxPct: cr && typeof cr.ctx_pct === 'number' ? cr.ctx_pct : null,
      cost: null,
      tokens: null,
      steps: c.steps || null,
      last: c.preview ? { user: { text: c.preview, at: c.lastInputAt ? new Date(c.lastInputAt).toISOString() : null }, assistant: null } : null,
    });
  }

  // Board entries with no registry file: Antigravity, or Claude sessions that have exited
  // (Claude removes its registry file on exit, so those are closed for certain).
  for (const [sid, c] of crew) {
    const isAgy = agy.has(sid);
    const fresh = isAgy && now - c._mtime <= CREW_STALE_MS;
    const found = isAgy ? null : findTranscriptAnywhere(sid);
    const acct = found ? accts.find((a) => a.configPath === found.configPath) : null;
    sessions.push({
      id: sid,
      name: aliasMap[sid] || c.name || sid.slice(0, 8),
      registryName: null,
      alias: aliasMap[sid] || null,
      source: isAgy ? 'antigravity' : 'claude',
      kind: null,
      configDir: acct ? acct.configDir : null,
      configPath: acct ? acct.configPath : null,
      account: acct ? acct.email : null,
      pid: null,
      alive: fresh,
      status: fresh ? 'active' : 'closed',
      cwd: c.cwd || null,
      version: null,
      startedAt: null,
      updatedAt: c.updated_at || c._mtime || null,
      crew: crewView(c, now),
      model: c.model || null,
      ctxPct: typeof c.ctx_pct === 'number' ? c.ctx_pct : null,
      cost: typeof c.cost_usd === 'number' ? c.cost_usd : null,
      tokens: null,
      last: found ? lastExchange(found.file) : null,
    });
  }

  pidIndex = pids;
  return { accounts: accts, sessions };
}

function sessionForPids(list) {
  for (const pid of list || []) {
    const sid = pidIndex.get(Number(pid));
    if (sid) return sid;
  }
  return null;
}

module.exports = { accounts, configDirs, snapshot, transcript, sessionForPids, recordUsage, usageHistory, findTranscriptAnywhere };
