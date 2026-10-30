'use strict';
// Antigravity CLI (agy): where it lives, its conversations and which of them are running.
// Conversations are SQLite files; the summaries table gives titles, and each step is a protobuf
// blob from which the user prompts, replies and tool calls are read by field path.

const fs = require('fs');
const path = require('path');
const { AGY_DIR } = require('./config');
const bin = require('./bin');
const { memoByFile, clip } = require('./util');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }

const SUMMARIES = path.join(AGY_DIR, 'conversation_summaries.db');
const PRESENCE = path.join(AGY_DIR, 'presence');
const CONVERSATIONS = path.join(AGY_DIR, 'conversations');

function agyBin() {
  return bin.which('agy', [path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')]);
}

function installed() { return !!agyBin(); }

function settings() {
  try { return JSON.parse(fs.readFileSync(path.join(AGY_DIR, 'settings.json'), 'utf8')); } catch (e) { return {}; }
}

function uriToPath(u) {
  try {
    const p = decodeURIComponent(String(u).replace(/^file:\/\/\/?/, ''));
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : '/' + p.replace(/^\/+/, '');
  } catch (e) { return String(u); }
}

function openDb(file) {
  if (!sqlite) return null;
  try { return new sqlite.DatabaseSync(file, { readOnly: true }); } catch (e) { return null; }
}

const readSummaries = memoByFile((file) => {
  const db = openDb(file);
  if (!db) return [];
  try {
    return db.prepare('select conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, last_user_input_time, killed from conversation_summaries').all()
      .map((r) => {
        let ws = [];
        try { ws = JSON.parse(r.workspace_uris || '[]'); } catch (e) {}
        return {
          id: r.conversation_id,
          title: r.title || r.preview || '',
          preview: r.preview || '',
          steps: Number(r.step_count) || 0,
          updatedAt: Date.parse(r.last_modified_time) || null,
          lastInputAt: Date.parse(r.last_user_input_time) || null,
          workspaces: ws.map(uriToPath),
          status: String(r.status || '').replace(/^CASCADE_RUN_STATUS_/, '').toLowerCase(),
          killed: !!r.killed,
        };
      });
  } catch (e) { return []; } finally { try { db.close(); } catch (e) {} }
});

function conversations() {
  if (!fs.existsSync(SUMMARIES)) return [];
  return readSummaries(SUMMARIES) || [];
}

// A running agy holds a byte-range lock on its (empty) presence file: reading it fails with EBUSY.
function isLive(id) {
  const lock = path.join(PRESENCE, id + '.lock');
  let fd = null;
  try {
    fd = fs.openSync(lock, 'r');
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
}

function liveIds() {
  let names = [];
  try { names = fs.readdirSync(PRESENCE); } catch (e) { return []; }
  return names.filter((n) => n.endsWith('.lock')).map((n) => n.slice(0, -5)).filter(isLive);
}

function lockBirth(id) {
  try { const s = fs.statSync(path.join(PRESENCE, id + '.lock')); return s.birthtimeMs || s.mtimeMs; } catch (e) { return 0; }
}

// ---------- protobuf by field path ----------
function varint(b, i) {
  let r = 0;
  let s = 0;
  let x;
  do { x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80 && i < b.length);
  return [r, i];
}

// First length-delimited value found at a path of field numbers, e.g. [19, 2].
function at(buf, fields) {
  let b = buf;
  for (let depth = 0; depth < fields.length; depth++) {
    let i = 0;
    let hit = null;
    while (i < b.length) {
      let key;
      [key, i] = varint(b, i);
      const f = Math.floor(key / 8);
      const wt = key & 7;
      if (wt === 0) [, i] = varint(b, i);
      else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else if (wt === 2) {
        let len;
        [len, i] = varint(b, i);
        if (i + len > b.length) return null;
        if (f === fields[depth]) { hit = b.subarray(i, i + len); break; }
        i += len;
      } else return null;
    }
    if (!hit) return null;
    b = hit;
  }
  return Buffer.from(b).toString('utf8');
}

function toolArg(json) {
  let o = null;
  try { o = JSON.parse(json || ''); } catch (e) { return String(json || ''); }
  const v = o && (o.CommandLine || o.AbsolutePath || o.TargetFile || o.Url || o.Query || o.SearchPath || o.Message);
  return String(v || json || '').replace(/\s+/g, ' ');
}

function transcript(id, limit) {
  const file = path.join(CONVERSATIONS, String(id).replace(/[^\w-]/g, '') + '.db');
  const db = openDb(file);
  if (!db) return { entries: [], truncated: false, error: sqlite ? 'No pude abrir la conversación' : 'Esta versión de Node no trae node:sqlite' };
  const entries = [];
  try {
    for (const r of db.prepare('select idx, step_type, step_payload from steps order by idx').all()) {
      const b = r.step_payload ? Buffer.from(r.step_payload) : null;
      if (!b) continue;
      if (r.step_type === 14) {
        const t = at(b, [19, 2]);
        if (t && t.trim()) entries.push({ role: 'user', text: t.trim() });
      } else if (r.step_type === 15) {
        const t = at(b, [20, 1]);
        if (t && t.trim()) entries.push({ role: 'assistant', text: t.trim() });
      } else {
        const name = at(b, [5, 4, 2]);
        if (name) entries.push({ role: 'tool', name, text: clip(at(b, [5, 30]) || toolArg(at(b, [5, 4, 3])), 160) });
      }
    }
  } catch (e) {
    return { entries, truncated: false, error: e.message };
  } finally { try { db.close(); } catch (e) {} }
  const max = limit || 2000;
  return { entries: entries.slice(-max), truncated: entries.length > max };
}

function models() {
  return bin.run('agy', ['models'], { bin: agyBin(), timeout: 15000 }).then((r) => (r.ok ? r.stdout.split(/\r?\n/)
    .map((s) => s.trim()).filter((s) => s && !/^(available|models?)\b/i.test(s))
    .map((s) => { const [id, label] = s.split('\t'); return { value: id.trim(), label: (label || id).trim() }; }) : []));
}

module.exports = { agyBin, installed, settings, conversations, isLive, liveIds, lockBirth, transcript, models, available: () => !!sqlite };
