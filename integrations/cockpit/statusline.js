'use strict';
// Cockpit statusline for Claude Code & Antigravity (AGY).
// Reads the statusline JSON payload on stdin, prints a responsive status bar.
// Must never throw: a crashing statusline renders as a broken bar.

const fs = require('fs');
const os = require('os');
const path = require('path');
const tty = require('tty');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache', 'statusline');
const CACHE_V = 3;
const CTX_LIMIT = Number(process.env.CLAUDE_STATUSLINE_CTX_LIMIT || 1000000);
const DUMP_PAYLOAD = process.env.CLAUDE_STATUSLINE_DEBUG === '1';

// ---------- terminal width detection ----------
function getTerminalWidth() {
  if (process.env.COLUMNS && Number(process.env.COLUMNS) > 0) {
    return Number(process.env.COLUMNS);
  }
  if (process.stdout && process.stdout.columns) {
    return process.stdout.columns;
  }
  if (process.stderr && process.stderr.columns) {
    return process.stderr.columns;
  }
  try {
    const conPath = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
    const fd = fs.openSync(conPath, 'r+');
    const ws = new tty.WriteStream(fd);
    const cols = ws.columns;
    fs.closeSync(fd);
    if (cols && cols > 0) return cols;
  } catch (e) {}
  return 120;
}

// ---------- color ----------
const NO_COLOR = !!process.env.NO_COLOR;
const rgb = (r, g, b) => (s) => (NO_COLOR ? String(s) : '\x1b[38;2;' + r + ';' + g + ';' + b + 'm' + s + '\x1b[0m');
const C = {
  model: rgb(199, 146, 234),
  session: rgb(255, 203, 107),
  dir: rgb(130, 170, 255),
  branch: rgb(195, 232, 141),
  stack: rgb(137, 221, 255),
  dim: rgb(110, 120, 135),
  label: rgb(150, 160, 175),
  val: rgb(220, 224, 232),
  good: rgb(152, 195, 121),
  warn: rgb(229, 192, 123),
  bad: rgb(224, 108, 117),
  cost: rgb(229, 192, 123),
  add: rgb(152, 195, 121),
  del: rgb(224, 108, 117),
  bridge: rgb(167, 139, 250),
};

const SEP = C.dim('   │   ');
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ---------- formatting (strictly max 2 decimals) ----------
function formatDec(val, maxDec = 2) {
  if (!Number.isFinite(val)) return '0';
  const factor = Math.pow(10, maxDec);
  const rounded = Math.round(val * factor) / factor;
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDec,
  });
}

function tok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return formatDec(n / 1000, 2) + 'k';
  return formatDec(n / 1000000, 2) + 'M';
}

function dur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? String(s % 60).padStart(2, '0') + 's' : '');
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

function hhmm(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function formatUsd(val) {
  if (!Number.isFinite(val)) return '$0.00';
  return '$' + val.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseQuotaBucket(b) {
  if (!b || typeof b !== 'object') return null;
  let usedPct = null;
  let remPct = null;

  if (typeof b.remaining_fraction === 'number') {
    remPct = Math.max(0, Math.min(100, b.remaining_fraction * 100));
    usedPct = Math.max(0, 100 - remPct);
  } else if (typeof b.used_percentage === 'number') {
    usedPct = Math.max(0, Math.min(100, b.used_percentage));
    remPct = Math.max(0, 100 - usedPct);
  } else if (typeof b.remaining_percentage === 'number') {
    remPct = Math.max(0, Math.min(100, b.remaining_percentage));
    usedPct = Math.max(0, 100 - remPct);
  } else if (typeof b.utilization === 'number') {
    usedPct = Math.max(0, Math.min(100, b.utilization));
    remPct = Math.max(0, 100 - usedPct);
  } else if (typeof b.percentUsed === 'number') {
    usedPct = Math.max(0, Math.min(100, b.percentUsed));
    remPct = Math.max(0, 100 - usedPct);
  }

  if (usedPct === null && remPct === null) return null;

  let resetDate = null;
  const rawReset = b.resets_at || b.reset_time || b.resetsAt || b.resetAt;
  if (rawReset) {
    if (typeof rawReset === 'number') {
      resetDate = new Date(rawReset < 1e11 ? rawReset * 1000 : rawReset);
    } else if (typeof rawReset === 'string') {
      const parsed = Date.parse(rawReset);
      if (!isNaN(parsed)) resetDate = new Date(parsed);
    }
  } else if (typeof b.reset_in_seconds === 'number' && b.reset_in_seconds > 0) {
    resetDate = new Date(Date.now() + b.reset_in_seconds * 1000);
  }

  return { usedPct, remPct, resetDate };
}

function renderQuotaBadge(label, parsed) {
  if (!parsed) return null;
  const frac = Math.min(1, Math.max(0, parsed.usedPct / 100));
  const remFrac = Math.min(1, Math.max(0, parsed.remPct / 100));
  const usedColor = frac >= 0.85 ? C.bad : frac >= 0.6 ? C.warn : C.good;
  const remColor = remFrac <= 0.15 ? C.bad : remFrac <= 0.4 ? C.warn : C.good;

  let s = C.label(label + ' ') + gauge(frac, 5) + ' ' +
    usedColor(formatDec(parsed.usedPct, 2) + '% us') + C.dim(' · ') +
    remColor(formatDec(parsed.remPct, 2) + '% rest');
  if (parsed.resetDate) {
    const tm = hhmm(parsed.resetDate);
    if (tm) s += C.dim(' ↻' + tm);
  }
  return s;
}

function shortPath(p) {
  if (!p) return '?';
  let s = String(p).replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  if (s.toLowerCase().startsWith(home.toLowerCase())) s = '~' + s.slice(home.length);
  const parts = s.split('/').filter(Boolean);
  if (parts.length > 3) s = (s.startsWith('~') ? '~/.../' : '.../') + parts.slice(-2).join('/');
  return s;
}

function gauge(frac, width = 6, color = null) {
  const clamped = Math.max(0, Math.min(1, frac));
  const filled = Math.round(clamped * width);
  const col = color || (clamped >= 0.85 ? C.bad : clamped >= 0.6 ? C.warn : C.good);
  return col('█'.repeat(filled)) + C.dim('░'.repeat(width - filled));
}

// ---------- git branch ----------
function gitBranch(startDir) {
  try {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 12; i++) {
      const g = path.join(dir, '.git');
      let st = null;
      try { st = fs.statSync(g); } catch (e) {}
      if (st) {
        let gitDir = g;
        if (st.isFile()) {
          const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 7) + ' (detached)';
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch (e) {}
  return null;
}

// ---------- tech stack ----------
const JS_FRAMEWORKS = [
  ['next', 'next'], ['nuxt', 'nuxt'], ['@nestjs/core', 'nest'], ['astro', 'astro'],
  ['@remix-run/react', 'remix'], ['svelte', 'svelte'], ['vue', 'vue'],
  ['react-native', 'rn'], ['react', 'react'], ['express', 'express'], ['vite', 'vite'],
];
function detectStackUncached(dir) {
  const labels = [];
  const has = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch (e) { return false; } };
  if (has('package.json')) {
    let pkg = {};
    try {
      const fd = fs.openSync(path.join(dir, 'package.json'), 'r');
      const buf = Buffer.allocUnsafe(65536);
      const n = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      pkg = JSON.parse(buf.slice(0, n).toString('utf8'));
    } catch (e) {}
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    let fw = null;
    for (let i = 0; i < JS_FRAMEWORKS.length; i++) {
      if (deps[JS_FRAMEWORKS[i][0]]) { fw = JS_FRAMEWORKS[i][1]; break; }
    }
    labels.push(fw || 'node');
    if (deps.typescript || has('tsconfig.json')) labels.push('ts');
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) labels.push('python');
  if (has('go.mod')) labels.push('go');
  if (has('Cargo.toml')) labels.push('rust');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) labels.push('java');
  if (has('composer.json')) labels.push('php');
  if (has('Gemfile')) labels.push('ruby');
  try {
    if (fs.readdirSync(dir).some((f) => /\.(csproj|sln|fsproj)$/i.test(f))) labels.push('dotnet');
  } catch (e) {}
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) labels.push('docker');
  if (has('main.tf') || has('terraform.tf')) labels.push('tf');
  return labels.slice(0, 3);
}
function detectStack(dir) {
  if (!dir) return [];
  const cacheFile = path.join(CACHE_DIR, 'stack.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {}
  let sig = '';
  try { sig = String(fs.statSync(dir).mtimeMs); } catch (e) { return []; }
  const hit = map[dir];
  if (hit && hit.sig === sig) return hit.labels;
  const labels = detectStackUncached(dir);
  map[dir] = { sig: sig, labels: labels };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(map));
  } catch (e) {}
  return labels;
}

// ---------- todo.md progress ----------
const TODO_NAMES = ['todo.md', 'TODO.md', 'Todo.md'];
const TODO_HEADING = /^##\s+(?:\[([^\]\s]+)\]|([A-Za-z0-9][A-Za-z0-9._-]*)[.)]?)(?:\s+[-—:]?\s*(.*))?$/;
const TODO_STATUS = /^\s*[-*]\s*\*\*Status:?\*\*\s*(.+?)\s*$/i;

function findTodo(cwd, projectDir) {
  const dirs = [cwd, path.join(cwd, '.claude'), projectDir, path.join(projectDir, '.claude')];
  for (let i = 0; i < dirs.length; i++) {
    if (!dirs[i]) continue;
    for (let j = 0; j < TODO_NAMES.length; j++) {
      const p = path.join(dirs[i], TODO_NAMES[j]);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) {}
    }
  }
  return null;
}
function parseTodo(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  if (st.size > 262144) return null;
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  const lines = txt.split(/\r?\n/);
  const tasks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = TODO_HEADING.exec(lines[i]);
    if (m) {
      cur = { id: String(m[1] || m[2] || '').replace(/[.)]$/, ''), status: null };
      tasks.push(cur);
      continue;
    }
    if (cur && !cur.status) {
      const s = TODO_STATUS.exec(lines[i]);
      if (s) cur.status = s[1].toLowerCase().replace(/[`*\[\]]/g, '').trim();
    }
  }
  if (!tasks.length) return null;
  const isDone = (t) => /^(done|complete|completed|resolved|shipped|closed)\b/.test(t.status || '');
  const isActive = (t) => /^(in[- ]progress|wip|doing|active|started)\b/.test(t.status || '');
  const isBlocked = (t) => /^(blocked|waiting|on[- ]hold)\b/.test(t.status || '');
  const done = tasks.filter(isDone).length;
  let active = null;
  for (let i = 0; i < tasks.length && !active; i++) if (isActive(tasks[i])) active = tasks[i];
  for (let i = 0; i < tasks.length && !active; i++) if (!isDone(tasks[i])) active = tasks[i];
  return {
    file: p,
    id: active ? active.id : null,
    blocked: active ? isBlocked(active) : false,
    done: done,
    total: tasks.length,
  };
}
function todoProgress(cwd, projectDir) {
  const p = findTodo(cwd, projectDir);
  if (!p) return null;
  const cacheFile = path.join(CACHE_DIR, 'todo.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {}
  let sig = '';
  try { const st = fs.statSync(p); sig = st.mtimeMs + ':' + st.size; } catch (e) { return null; }
  const hit = map[p];
  if (hit && hit.sig === sig) return hit.val;
  const val = parseTodo(p);
  map[p] = { sig: sig, val: val };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(map));
  } catch (e) {}
  return val;
}

// ---------- multi-session crew board ----------
const CREW_DIR = process.env.CLAUDE_STATUSLINE_CREW_DIR || path.join(os.homedir(), '.claude', 'crew');
const CREW_STALE_MS = 5 * 60 * 1000;
const CREW_PRUNE_MS = 24 * 60 * 60 * 1000;

function crewFile(sessionId, ext) {
  return path.join(CREW_DIR, String(sessionId).replace(/[^\w.-]/g, '_') + (ext || '.json'));
}
function crewWaitingOn(sessionId) {
  try {
    const s = fs.readFileSync(crewFile(sessionId, '.waiting'), 'utf8').trim();
    return s ? s.slice(0, 200) : null;
  } catch (e) { return null; }
}
function crewPublish(entry) {
  if (!entry.session_id) return;
  try {
    fs.mkdirSync(CREW_DIR, { recursive: true });
    fs.writeFileSync(crewFile(entry.session_id), JSON.stringify(entry, null, 1));
  } catch (e) {}
  try {
    const now = Date.now();
    const files = fs.readdirSync(CREW_DIR);
    for (let i = 0; i < files.length; i++) {
      if (!/\.json$/.test(files[i])) continue;
      const p = path.join(CREW_DIR, files[i]);
      try {
        if (now - fs.statSync(p).mtimeMs > CREW_PRUNE_MS) {
          fs.rmSync(p, { force: true });
          fs.rmSync(p.replace(/\.json$/, '.waiting'), { force: true });
        }
      } catch (e) {}
    }
  } catch (e) {}
}
function crewPeers(selfId) {
  const out = [];
  try {
    const files = fs.readdirSync(CREW_DIR);
    for (let i = 0; i < files.length; i++) {
      if (!/\.json$/.test(files[i])) continue;
      const p = path.join(CREW_DIR, files[i]);
      let o = null;
      let mt = 0;
      try {
        mt = fs.statSync(p).mtimeMs;
        o = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) { continue; }
      if (!o || !o.session_id || o.session_id === selfId) continue;
      o._stale = Date.now() - mt > CREW_STALE_MS;
      out.push(o);
    }
  } catch (e) {}
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

// ---------- Agentic Bridge inbox ----------
// The Bridge hub keeps a count of undelivered messages per session; show it as a badge.
const BRIDGE_DIR = process.env.BRIDGE_DATA_DIR || path.join(os.homedir(), '.agentic-bridge');
function bridgeUnread(sessionId) {
  if (!sessionId) return 0;
  try {
    const n = Number(fs.readFileSync(path.join(BRIDGE_DIR, 'unread', String(sessionId).replace(/[^\w.-]/g, '_')), 'utf8'));
    return Number.isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

// ---------- transcript token accounting ----------
function transcriptStats(p, sessionId) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  const key = String(sessionId || path.basename(p)).replace(/[^\w.-]/g, '_');
  const cacheFile = path.join(CACHE_DIR, key + '.json');
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {}
  if (!c || c.v !== CACHE_V || c.offset > st.size) {
    c = { v: CACHE_V, offset: 0, totals: { in: 0, out: 0, cr: 0, cc: 0, req: 0, think: 0 }, last: null, start: null };
  }
  if (st.size > c.offset) {
    let text = '';
    try {
      const fd = fs.openSync(p, 'r');
      const len = st.size - c.offset;
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, c.offset);
      fs.closeSync(fd);
      text = buf.slice(0, n).toString('utf8');
    } catch (e) { return c; }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl !== -1) {
      const usable = text.slice(0, lastNl);
      const lines = usable.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (!c.start && o.timestamp) c.start = o.timestamp;
        const u = o.message && o.message.usage;
        if (!u) continue;
        c.totals.in += u.input_tokens || 0;
        c.totals.out += u.output_tokens || 0;
        c.totals.cr += u.cache_read_input_tokens || 0;
        c.totals.cc += u.cache_creation_input_tokens || 0;
        c.totals.think += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
        c.totals.req += 1;
        if (!o.isSidechain) {
          c.last = {
            in: u.input_tokens || 0,
            cr: u.cache_read_input_tokens || 0,
            cc: u.cache_creation_input_tokens || 0,
            out: u.output_tokens || 0,
          };
        }
      }
      c.offset += Buffer.byteLength(usable, 'utf8') + 1;
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(c));
      } catch (e) {}
    }
  }
  return c;
}

// ---------- responsive layout helper ----------
function flowItemsIntoLines(items, maxCols) {
  if (!items || !items.length) return [];
  const joined = items.join(SEP);
  if (plain(joined).length <= maxCols - 2) {
    return [joined];
  }
  const lines = [];
  let cur = [];
  let curLen = 0;
  const sepLen = plain(SEP).length;

  for (const it of items) {
    const itLen = plain(it).length;
    if (cur.length === 0) {
      cur.push(it);
      curLen = itLen;
    } else if (curLen + sepLen + itLen <= maxCols - 2) {
      cur.push(it);
      curLen += sepLen + itLen;
    } else {
      lines.push(cur.join(SEP));
      cur = [it];
      curLen = itLen;
    }
  }
  if (cur.length > 0) lines.push(cur.join(SEP));
  return lines;
}

// ---------- render ----------
function render(d) {
  const ws = d.workspace || {};
  const cwd = ws.current_dir || d.cwd || process.cwd();
  const projectDir = ws.project_dir || cwd;
  const model = (d.model && (d.model.display_name || d.model.id || d.model.name))
    || (typeof d.model === 'string' ? d.model : '')
    || d.model_name
    || 'Gemini 3.8 Flash';
  const cost = d.cost || {};

  const stats = d.transcript_path ? transcriptStats(d.transcript_path, d.session_id || d.sessionId || d.conversation_id) : null;
  const last = (stats && stats.last) || null;
  const totalTokens = stats ? (stats.totals.in + stats.totals.out + stats.totals.cr + stats.totals.cc) : 0;

  const br = gitBranch(cwd);
  const stack = detectStack(projectDir);
  const todo = todoProgress(cwd, projectDir);

  const sessionId = d.session_id || d.sessionId || d.conversation_id || d.conversationId || null;
  const myName = d.session_name || (sessionId ? String(sessionId).slice(0, 8) : null);

  // Multi-session board publish
  if (sessionId) {
    crewPublish({
      session_id: sessionId,
      name: myName || 'agy',
      cwd: cwd,
      branch: br || null,
      stack: stack,
      task: todo ? todo.id : null,
      done: todo ? todo.done : null,
      total: todo ? todo.total : null,
      blocked: !!(todo && todo.blocked),
      todo_file: todo ? todo.file : null,
      cost_usd: typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
      model: model,
      ctx_pct: d.context_window && typeof d.context_window.used_percentage === 'number'
        ? Math.max(0, Math.min(100, d.context_window.used_percentage)) : null,
      rate_limits: d.rate_limits || d.quota || null,
      config_dir: process.env.CLAUDE_CONFIG_DIR || null,
      waiting_on: crewWaitingOn(sessionId),
      updated_at: Date.now(),
    });
  }

  // -------------------------------------------------------------
  // GROUP 1: Environment & Identity
  // -------------------------------------------------------------
  const group1 = [];

  // Model & mode flags
  let modelBadge = C.model('◆ ' + model);
  if (d.effort && d.effort.level) modelBadge += C.dim(' ' + d.effort.level);
  if (d.fast_mode) modelBadge += C.warn(' ⚡fast');
  group1.push(modelBadge);

  // Session name (if present)
  if (d.session_name) {
    group1.push(C.session('❖ ' + d.session_name));
  }

  // Working Directory
  group1.push(C.dir('▸ ' + shortPath(cwd)));

  // Git Branch
  if (br) {
    group1.push(C.branch('⎇ ' + br));
  }

  // Tech Stack
  if (stack && stack.length) {
    group1.push(C.stack('⬢ ' + stack.join(' ')));
  }

  // Output Style (if custom)
  if (d.output_style && d.output_style.name && d.output_style.name !== 'default') {
    group1.push(C.dim('◇ ' + d.output_style.name));
  }

  // -------------------------------------------------------------
  // GROUP 2: Metrics, Context, Quotas & Activity
  // -------------------------------------------------------------
  const group2 = [];

  // Context Window (Rich details & max 2 decimals)
  const cw = d.context_window || {};
  const ctxLimit = Number(cw.context_window_size || cw.limit || cw.max_tokens) || CTX_LIMIT;
  const inTok = Number(cw.total_input_tokens) || 0;
  const outTok = Number(cw.total_output_tokens) || 0;
  let ctx = (inTok + outTok) || (Number(cw.used_tokens) || 0) || (Number(cw.tokens) || 0);
  if (!ctx && last) ctx = last.in + last.cr + last.cc + last.out;

  if (ctx > 0 || ctxLimit > 0) {
    const frac = ctxLimit > 0 ? Math.min(1, ctx / ctxLimit) : 0;
    const pct = typeof cw.used_percentage === 'number'
      ? cw.used_percentage
      : (frac * 100);
    const remPct = Math.max(0, 100 - pct);
    const remFrac = Math.max(0, 1 - frac);
    const usedColor = frac >= 0.85 ? C.bad : frac >= 0.6 ? C.warn : C.val;
    const remColor = remFrac <= 0.15 ? C.bad : remFrac <= 0.4 ? C.warn : C.good;

    let ctxBadge = C.label('ctx ') + gauge(frac, 6) + ' ' +
      C.val(tok(ctx)) + C.dim('/') + C.val(tok(ctxLimit)) + ' ' +
      C.dim('(') + usedColor(formatDec(pct, 2) + '% us') + C.dim(' · ') +
      remColor(formatDec(remPct, 2) + '% rest') + C.dim(')');

    if (inTok > 0 || outTok > 0) {
      ctxBadge += C.dim(' [') + C.label('↓') + C.val(tok(inTok)) +
        ' ' + C.label('↑') + C.val(tok(outTok)) + C.dim(']');
    }
    if (stats && stats.totals && stats.totals.think > 0) {
      ctxBadge += C.dim(' ') + C.label('🧠') + C.val(tok(stats.totals.think));
    }
    group2.push(ctxBadge);
  } else {
    group2.push(C.label('ctx ') + C.dim('--'));
  }

  // Quotas / Rate Limits / Credits (max 2 decimals, used % vs remaining %)
  const rl = d.quota || d.rate_limits || {};
  const modelStr = String((d.model && (d.model.id || d.model.name || d.model.display_name)) || d.model_name || '').toLowerCase();
  const isClaude = modelStr.includes('claude') || modelStr.includes('opus') || modelStr.includes('sonnet') || modelStr.includes('haiku');
  const isGemini = modelStr.includes('gemini');

  // 1. Five Hour Window (5h)
  let b5h = null;
  if (isGemini) {
    b5h = parseQuotaBucket(rl['gemini-5h'] || rl.five_hour || rl.fiveHour || rl['3p-5h'] || rl.hourly);
  } else if (isClaude) {
    b5h = parseQuotaBucket(rl.five_hour || rl.fiveHour || rl['3p-5h'] || rl['gemini-5h'] || rl.hourly);
  } else {
    b5h = parseQuotaBucket(rl['gemini-5h'] || rl.five_hour || rl.fiveHour || rl['3p-5h'] || rl.hourly);
  }
  const badge5h = renderQuotaBadge('5h', b5h);
  if (badge5h) group2.push(badge5h);

  // 2. Seven Day / Weekly Window (7d)
  let b7d = null;
  if (isGemini) {
    b7d = parseQuotaBucket(rl['gemini-weekly'] || rl.seven_day || rl.sevenDay || rl['3p-weekly'] || rl.weekly || rl.daily);
  } else if (isClaude) {
    b7d = parseQuotaBucket(
      (modelStr.includes('opus') && rl.seven_day_opus) ||
      (modelStr.includes('sonnet') && rl.seven_day_sonnet) ||
      rl.seven_day || rl.sevenDay || rl['3p-weekly'] || rl['gemini-weekly'] || rl.weekly || rl.daily
    );
  } else {
    b7d = parseQuotaBucket(rl['gemini-weekly'] || rl.seven_day || rl.sevenDay || rl['3p-weekly'] || rl.weekly || rl.daily);
  }
  const badge7d = renderQuotaBadge('7d', b7d);
  if (badge7d) group2.push(badge7d);

  // 3. Spend Limit & Credits (cr)
  const spend = rl.spend_limit || rl.spendLimit;
  if (spend) {
    const pSpend = parseQuotaBucket(spend);
    if (typeof spend.used_usd === 'number' && typeof spend.limit_usd === 'number') {
      const remUsd = Math.max(0, spend.limit_usd - spend.used_usd);
      const frac = spend.limit_usd > 0 ? Math.min(1, spend.used_usd / spend.limit_usd) : 0;
      const remColor = (1 - frac) <= 0.15 ? C.bad : (1 - frac) <= 0.4 ? C.warn : C.good;
      let s = C.label('cr ') + gauge(frac, 5) + ' ' +
        C.cost(formatUsd(spend.used_usd)) + C.dim('/') + C.val(formatUsd(spend.limit_usd)) + ' ' +
        C.dim('(') + remColor(formatUsd(remUsd) + ' rest') + C.dim(')');
      group2.push(s);
    } else if (pSpend) {
      group2.push(renderQuotaBadge('cr', pSpend));
    }
  } else if (typeof rl.credits_remaining === 'number' || typeof d.credits === 'number' || typeof rl.credits === 'number') {
    const cred = rl.credits_remaining !== undefined ? rl.credits_remaining : (d.credits !== undefined ? d.credits : rl.credits);
    group2.push(C.label('cr ') + C.val(formatDec(cred, 2)) + C.dim(' rest'));
  }

  // Prompt Cache
  const pcache = d.prompt_cache;
  if (pcache && typeof pcache.hit_ratio === 'number') {
    const dot = pcache.warm ? C.good('●') : C.dim('○');
    group2.push(C.label('cache ') + dot + ' ' + C.val(formatDec(pcache.hit_ratio * 100, 2) + '%') + C.dim(' hit'));
  }

  // Transcript Tokens
  if (stats && totalTokens > 0) {
    let statStr = C.label('Σ ') + C.val(tok(totalTokens)) + C.dim(' tok');
    if (stats.totals.req) statStr += C.dim(' · ') + C.val(stats.totals.req) + C.dim(' req');
    group2.push(statStr);
  }

  // Todo Task Progress
  if (todo && todo.total) {
    let rel = path.relative(cwd, todo.file).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) rel = path.basename(todo.file);
    const frac = todo.done / todo.total;
    const idCol = todo.blocked ? C.bad : C.val;
    let s = C.dim('▤ ') + (todo.id ? C.label('Task:') + idCol(todo.id) + ' ' : '');
    s += gauge(frac, 5, C.good) + ' ' + C.val(todo.done) + C.dim('/' + todo.total);
    group2.push(s);
  }

  // Multi-session Peers (Crew)
  const peers = crewPeers(sessionId);
  if (peers.length) {
    const mine = String(myName || '').toLowerCase();
    const onMe = mine ? peers.filter((p) => p.waiting_on && String(p.waiting_on).toLowerCase().indexOf(mine) !== -1) : [];
    if (onMe.length) {
      group2.push(C.bad('⇄ ' + onMe.map((p) => p.name || '?').join(',') + ' ⟵ wait'));
    }
    const rest = peers.filter((p) => onMe.indexOf(p) === -1).slice(0, 2);
    if (rest.length) {
      group2.push(C.dim('⇄ ') + rest.map((p) => {
        let nm = String(p.name || '?');
        if (nm.length > 10) nm = nm.slice(0, 9) + '…';
        return C.val(nm);
      }).join(C.dim(' · ')));
    }
  }

  // Agentic Bridge messages waiting for this session
  const unread = bridgeUnread(sessionId);
  if (unread > 0) group2.push(C.bridge('📨 ' + unread + ' Bridge'));

  // Spend, Lines, Duration
  if (typeof cost.total_cost_usd === 'number' && cost.total_cost_usd > 0) {
    group2.push(C.cost('$' + formatDec(cost.total_cost_usd, 2)));
  }
  const added = cost.total_lines_added;
  const removed = cost.total_lines_removed;
  if (added || removed) {
    group2.push(C.add('+' + (added || 0)) + C.dim('/') + C.del('-' + (removed || 0)));
  }
  if (typeof cost.total_duration_ms === 'number' && cost.total_duration_ms > 0) {
    group2.push(C.label('⏱ ') + C.val(dur(cost.total_duration_ms)));
  }

  // Clock
  group2.push(C.dim(hhmm(new Date())));

  // -------------------------------------------------------------
  // RESPONSIVE LAYOUT ENGINE
  // -------------------------------------------------------------
  const cols = getTerminalWidth();
  const allBadges = group1.concat(group2);

  // Preference 1: Show EVERYTHING on a SINGLE LINE if terminal width allows
  const fullSingleLine = allBadges.join(SEP);
  if (plain(fullSingleLine).length <= cols - 2) {
    return fullSingleLine;
  }

  // Preference 2: Responsively split into structured rows (renglones)
  // Row 1: Environment & Identity
  // Row 2+: Context Window, Metrics & Performance
  const lines1 = flowItemsIntoLines(group1, cols);
  const lines2 = flowItemsIntoLines(group2, cols);

  return lines1.concat(lines2).join('\n');
}

// ---------- main ----------
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (ch) => { raw += ch; });
process.stdin.on('end', () => {
  let d = {};
  try {
    const cleanRaw = raw.replace(/^\uFEFF/, '').trim();
    d = JSON.parse(cleanRaw) || {};
  } catch (e) {}
  if (DUMP_PAYLOAD) {
    try {
      fs.writeFileSync(path.join(os.homedir(), '.claude', 'statusline-last-payload.json'),
        JSON.stringify(d, null, 2));
    } catch (e) {}
  }
  let out;
  try {
    out = render(d);
  } catch (e) {
    out = C.dim('statusline error: ' + (e && e.message ? e.message : String(e)));
  }
  process.stdout.write(out + '\n');
});
process.stdin.on('error', () => { process.stdout.write('\n'); });
