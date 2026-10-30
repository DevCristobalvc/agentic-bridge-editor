'use strict';
// Encrypted credentials. Each value is sealed with AES-256-GCM under a master key; on Windows the
// master key itself is protected with DPAPI (CurrentUser): copies of these files are useless on
// another machine or to another Windows user. Bridge never hands values to agents (no /api/bridge
// route, no room, no MCP tool): they leave only on an explicit reveal in the editor or as env vars
// of a terminal the person opens. A program running as this same Windows user could still unlock
// them, as with any secret stored for that user.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./config');
const { readJson, writeJson, uid } = require('./util');
const { bus } = require('./store');

const KEY_FILE = path.join(DATA_DIR, 'secrets.key');
const FILE = path.join(DATA_DIR, 'secrets.json');
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

function dpapi(op, b64) {
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();"
    + '$b=[Convert]::FromBase64String($i);$o=[Security.Cryptography.ProtectedData]::' + op + "($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($o))";
  return new Promise((resolve, reject) => {
    const p = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error('DPAPI: ' + (String(stderr || '').trim().split('\n')[0] || err.message)));
      else resolve(String(stdout).trim());
    });
    p.stdin.end(b64);
  });
}

let masterKey = null;
let loading = null;
async function key() {
  if (masterKey) return masterKey;
  if (loading) return loading;
  loading = (async () => {
    // A key file that exists but can't be read or unlocked is an error, never a reason to make a
    // new key: that would leave every stored credential undecryptable for good.
    if (fs.existsSync(KEY_FILE)) {
      const stored = readJson(KEY_FILE, null);
      if (!stored || !stored.key) throw Object.assign(new Error('No pude leer ' + KEY_FILE + '; las credenciales quedan bloqueadas hasta restaurarlo.'), { status: 500 });
      masterKey = stored.scheme === 'dpapi' ? Buffer.from(await dpapi('Unprotect', stored.key), 'base64') : Buffer.from(stored.key, 'base64');
    } else {
      if (all().length) throw Object.assign(new Error('Falta ' + KEY_FILE + ' y hay credenciales guardadas: restáuralo para poder abrirlas.'), { status: 500 });
      const fresh = crypto.randomBytes(32);
      if (process.platform === 'win32') writeJson(KEY_FILE, { scheme: 'dpapi', key: await dpapi('Protect', fresh.toString('base64')) });
      else { writeJson(KEY_FILE, { scheme: 'file', key: fresh.toString('base64') }); try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) {} }
      masterKey = fresh;
    }
    return masterKey;
  })();
  try { return await loading; } finally { loading = null; }
}

function seal(k, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function open(k, sealed) {
  const [iv, tag, enc] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function all() { return readJson(FILE, []); }
function persist(list) {
  writeJson(FILE, list);
  bus.emit('event', { type: 'secrets', data: list.map(publicView) });
}

function mask(len) { return '•'.repeat(Math.min(12, Math.max(4, len))); }

function publicView(s) {
  return { id: s.id, name: s.name, service: s.service || '', note: s.note || '', hint: s.hint || '', length: s.length || 0, createdAt: s.createdAt, updatedAt: s.updatedAt, usedAt: s.usedAt || null };
}

function list() { return all().map(publicView); }

function check(name) {
  if (!NAME_RE.test(name)) throw Object.assign(new Error('El nombre debe ser una variable de entorno válida (letras, números y _; p. ej. GITHUB_TOKEN).'), { status: 400 });
}

async function save(input) {
  const name = String(input.name || '').trim();
  check(name);
  // Unlock the key first (the first time runs PowerShell): read the list only afterwards, so two
  // saves in that window can't write back each other's stale copy.
  const k = typeof input.value === 'string' && input.value.length ? await key() : null;
  const items = all();
  const now = Date.now();
  const existing = input.id ? items.find((s) => s.id === input.id) : null;
  if (items.some((s) => s.name === name && (!existing || s.id !== existing.id))) throw Object.assign(new Error('Ya existe una credencial con ese nombre'), { status: 409 });
  const entry = existing || { id: uid('sec'), createdAt: now };
  entry.name = name;
  entry.service = String(input.service || '').slice(0, 60);
  entry.note = String(input.note || '').slice(0, 400);
  if (typeof input.value === 'string' && input.value.length) {
    entry.value = seal(k, input.value);
    entry.length = input.value.length;
    // A hint to tell tokens apart without revealing them: only a well-known type prefix
    // (ghp_, sk-, xoxb-…) and the length.
    const prefix = (/^([A-Za-z]{2,5}[_-])/.exec(input.value) || [])[1] || '';
    entry.hint = prefix + mask(input.value.length) + ' (' + input.value.length + ')';
  } else if (!existing) {
    throw Object.assign(new Error('Falta el valor'), { status: 400 });
  }
  entry.updatedAt = now;
  persist(existing ? items.map((s) => (s.id === entry.id ? entry : s)) : items.concat([entry]));
  return publicView(entry);
}

function remove(id) {
  const items = all();
  const next = items.filter((s) => s.id !== id);
  persist(next);
  return next.length !== items.length;
}

async function reveal(id) {
  const k = await key();
  const s = all().find((x) => x.id === id);
  if (!s) throw Object.assign(new Error('Credencial no encontrada'), { status: 404 });
  return { id: s.id, name: s.name, value: open(k, s.value) };
}

// name -> value for the given ids, to hand to a terminal as environment variables.
async function envFor(ids) {
  if (!ids || !ids.length) return {};
  const k = await key();
  const items = all();
  const out = {};
  const now = Date.now();
  for (const id of ids) {
    const s = items.find((x) => x.id === id);
    if (!s) continue;
    out[s.name] = open(k, s.value);
    s.usedAt = now;
  }
  persist(items);
  return out;
}

module.exports = { list, save, remove, reveal, envFor };
