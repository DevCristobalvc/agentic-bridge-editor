'use strict';
// Access from other devices (your phone): a second listener on the network, apart from the local
// one on 127.0.0.1, where every request needs a login. It stays off until you turn it on in
// Settings and set a password. A device that signs in gets a long random cookie; only its hash is
// kept here, and each device can be signed out from the PC. The local API token never leaves the
// PC: remote pages work with the cookie alone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'remote.json');
const COOKIE = 'ab_device';
const MAX_AGE_S = 30 * 86400;
const DEFAULT_PORT = Number(process.env.BRIDGE_REMOTE_PORT || 4014);

const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
const cfg = Object.assign({ enabled: false, port: DEFAULT_PORT, salt: null, hash: null, devices: [] }, load());
function save() { fs.writeFileSync(FILE, JSON.stringify(cfg, null, 1)); }
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; save(); }, 5000); }

// IPv4 addresses on this PC that a phone on the same network (or a VPN like Tailscale) can reach.
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

let listenState = { listening: false, error: null };
function setListenState(s) { listenState = Object.assign({}, listenState, s); }

function status() {
  return {
    enabled: !!cfg.enabled,
    port: cfg.port,
    hasPassword: !!cfg.hash,
    listening: listenState.listening,
    error: listenState.error,
    urls: addresses().map((a) => ({ name: a.name, url: 'http://' + a.address + ':' + cfg.port })),
    devices: cfg.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen || null, ip: d.ip || null })),
  };
}

function configure(b) {
  if ('port' in b) {
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail(400, 'Puerto inválido (1024-65535).');
    cfg.port = port;
  }
  if ('enabled' in b) {
    if (b.enabled && !cfg.hash) throw fail(400, 'Primero define una contraseña.');
    cfg.enabled = !!b.enabled;
  }
  save();
  return status();
}

function setPassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) throw fail(400, 'La contraseña debe tener al menos 8 caracteres.');
  cfg.salt = crypto.randomBytes(16).toString('hex');
  cfg.hash = crypto.scryptSync(s, cfg.salt, 64).toString('hex');
  // A new password signs every device out.
  cfg.devices = [];
  save();
  return status();
}

function passwordOk(pw) {
  if (!cfg.hash || !cfg.salt) return false;
  const got = crypto.scryptSync(String(pw || ''), cfg.salt, 64);
  const want = Buffer.from(cfg.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- login throttling ----------
const perIp = new Map(); // ip -> { n, until }
let recent = [];         // timestamps of failures, from anywhere
const IP_MAX = 5;
const GLOBAL_MAX = 20;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function throttled(ip) {
  const now = Date.now();
  recent = recent.filter((t) => now - t < WINDOW_MS);
  const e = perIp.get(ip);
  if (e && e.until > now) return Math.ceil((e.until - now) / 60000);
  if (recent.length >= GLOBAL_MAX) return Math.ceil((recent[0] + WINDOW_MS - now) / 60000);
  return 0;
}

function noteFailure(ip) {
  const now = Date.now();
  recent.push(now);
  const e = perIp.get(ip) || { n: 0, until: 0 };
  e.n += 1;
  if (e.n >= IP_MAX) { e.until = now + WINDOW_MS; e.n = 0; }
  perIp.set(ip, e);
}

// ---------- devices ----------
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function deviceOf(req) {
  const tok = cookies(req)[COOKIE];
  if (!tok || !/^[a-f0-9]{64}$/.test(tok)) return null;
  const h = sha(tok);
  const d = cfg.devices.find((x) => x.hash === h);
  if (!d || Date.now() - d.createdAt > MAX_AGE_S * 1000) return null;
  if (Date.now() - (d.lastSeen || 0) > 60000) { d.lastSeen = Date.now(); d.ip = clientIp(req); saveSoon(); }
  return d;
}

function isHttps(req) {
  return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function cookieHeader(req, value, maxAge) {
  return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : '');
}

function deviceName(ua) {
  const s = String(ua || '');
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'Dispositivo';
  const br = /EdgA?\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'navegador';
  return os + ' · ' + br;
}

// Returns the Set-Cookie value for a successful login, or throws.
function login(req, password) {
  const ip = clientIp(req);
  const wait = throttled(ip);
  if (wait) throw fail(429, 'Demasiados intentos. Espera ' + wait + ' min y vuelve a intentar.');
  if (!passwordOk(password)) {
    noteFailure(ip);
    console.log('[remoto] contraseña incorrecta desde ' + ip);
    throw fail(401, 'Contraseña incorrecta.');
  }
  perIp.delete(ip);
  const tok = crypto.randomBytes(32).toString('hex');
  const d = { id: crypto.randomBytes(6).toString('hex'), hash: sha(tok), name: deviceName(req.headers['user-agent']), createdAt: Date.now(), lastSeen: Date.now(), ip };
  cfg.devices = cfg.devices.filter((x) => Date.now() - x.createdAt < MAX_AGE_S * 1000).concat([d]).slice(-20);
  save();
  console.log('[remoto] nuevo dispositivo: ' + d.name + ' desde ' + ip);
  return cookieHeader(req, tok, MAX_AGE_S);
}

function logout(req) {
  const d = deviceOf(req);
  if (d) { cfg.devices = cfg.devices.filter((x) => x !== d); save(); }
  return cookieHeader(req, 'x', 0);
}

function revoke(id) {
  const before = cfg.devices.length;
  cfg.devices = cfg.devices.filter((d) => d.id !== id);
  save();
  return before !== cfg.devices.length;
}

// A browser request from another site never gets in: when it says where it comes from, it must
// be this same host (directly, or the public name a tunnel forwards).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch (e) { return false; }
  const names = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((h) => String(h).split(',')[0].trim().toLowerCase());
  return names.includes(host);
}

// Things that stay on the PC even for a signed-in device.
function forbidden(method, pathname) {
  return pathname.startsWith('/api/remote') || /^\/api\/secrets\/[^/]+\/reveal$/.test(pathname);
}

module.exports = { status, configure, setPassword, login, logout, revoke, deviceOf, sameOrigin, forbidden, setListenState, config: () => cfg };
