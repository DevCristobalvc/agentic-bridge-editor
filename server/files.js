'use strict';
// File and folder browsing for the viewer. Local-only API: the token gate in index.js applies.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HOME } = require('./config');

const MAX_TEXT = 1.5 * 1024 * 1024;
const MAX_ENTRIES = 3000;
const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const MIME = Object.assign({ pdf: 'application/pdf', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8' }, IMAGE);

function ext(p) { return path.extname(p).slice(1).toLowerCase(); }

function resolve(p) {
  if (!p) return HOME;
  const s = String(p).replace(/^~(?=$|[\\/])/, HOME);
  return path.resolve(s);
}

function list(dir) {
  const abs = resolve(dir);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw Object.assign(new Error('No es una carpeta'), { status: 400 });
  const names = fs.readdirSync(abs);
  const entries = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const full = path.join(abs, name);
    let s;
    try { s = fs.statSync(full); } catch (e) { continue; }
    entries.push({ name, path: full, type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? null : s.size, mtime: s.mtimeMs, ext: s.isDirectory() ? '' : ext(name), hidden: name.startsWith('.') });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries, truncated: names.length > MAX_ENTRIES, sep: path.sep };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function read(file) {
  const abs = resolve(file);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw Object.assign(new Error('Es una carpeta'), { status: 400 });
  const e = ext(abs);
  const base = { path: abs, name: path.basename(abs), size: st.size, mtime: st.mtimeMs, ext: e };
  if (IMAGE[e]) return Object.assign(base, { kind: 'image', mime: IMAGE[e] });
  if (e === 'pdf') return Object.assign(base, { kind: 'pdf', mime: 'application/pdf' });
  const fd = fs.openSync(abs, 'r');
  try {
    const len = Math.min(st.size, MAX_TEXT);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    const slice = buf.subarray(0, n);
    if (looksBinary(slice)) return Object.assign(base, { kind: 'binary' });
    const raw = slice.toString('utf8');
    const bom = raw.charCodeAt(0) === 0xfeff;
    const content = bom ? raw.slice(1) : raw;
    // Remembered so an edit in the browser (which normalizes to \n) is saved back faithfully.
    return Object.assign(base, { kind: 'text', content, bom, eol: /\r\n/.test(content) ? 'crlf' : 'lf', truncated: st.size > MAX_TEXT });
  } finally {
    fs.closeSync(fd);
  }
}

function rawStream(file) {
  const abs = resolve(file);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('No es un archivo'), { status: 400 });
  return { stream: fs.createReadStream(abs), mime: MIME[ext(abs)] || 'application/octet-stream', size: st.size };
}

function write(file, content, opts) {
  const abs = resolve(file);
  let out = String(content);
  if (opts && opts.eol === 'crlf') out = out.replace(/\r?\n/g, '\r\n');
  if (opts && opts.bom) out = '﻿' + out;
  fs.writeFileSync(abs, out);
  return read(abs);
}

function roots(extra) {
  const out = [
    { label: 'Inicio', path: HOME, icon: 'home' },
    { label: 'Escritorio', path: path.join(HOME, 'Desktop'), icon: 'monitor' },
    { label: 'Documentos', path: path.join(HOME, 'Documents'), icon: 'file' },
  ];
  const seen = new Set(out.map((r) => r.path.toLowerCase()));
  for (const r of extra || []) {
    if (!r.path || seen.has(r.path.toLowerCase())) continue;
    seen.add(r.path.toLowerCase());
    out.push(r);
  }
  return out.filter((r) => { try { return fs.statSync(r.path).isDirectory(); } catch (e) { return false; } });
}

// VS Code's executable, found without going through cmd.exe (a path with "&" would run code).
function vscodeExe() {
  if (process.platform !== 'win32') return 'code';
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
  ];
  try {
    // `where code` finds the bin\code.cmd shim; Code.exe sits one folder up.
    const out = require('child_process').execFileSync('where', ['code.cmd'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(path.dirname(line.trim())), 'Code.exe'));
  } catch (e) {}
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function open(target, app) {
  const abs = resolve(target);
  if (app === 'vscode') {
    const exe = vscodeExe();
    if (!exe) throw Object.assign(new Error('No encontré VS Code instalado'), { status: 404 });
    spawn(exe, [abs], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    const isDir = fs.statSync(abs).isDirectory();
    spawn('explorer.exe', isDir ? [abs] : ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { list, read, write, rawStream, roots, open, resolve };
