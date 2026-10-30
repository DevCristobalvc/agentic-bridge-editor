'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { return fallback; }
}

// Write to a temp file and rename, so a crash never leaves half a JSON file behind.
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

function statSig(p) {
  try { const st = fs.statSync(p); return st.mtimeMs + ':' + st.size; } catch (e) { return null; }
}

// Memoize fn(p) on the file's mtime+size, so an unchanged file costs one stat.
function memoByFile(fn) {
  const cache = new Map();
  return (p) => {
    const sig = statSig(p);
    if (!sig) return null;
    const hit = cache.get(p);
    if (hit && hit.sig === sig) return hit.val;
    const val = fn(p);
    cache.set(p, { sig, val });
    return val;
  };
}

function uid(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(5).toString('hex');
}

function uuid() { return crypto.randomUUID(); }

function slug(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sin-nombre';
}

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Read the last `window` bytes of a file as text, dropping the first (partial) line.
function readTail(file, size, window) {
  const start = Math.max(0, size - window);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readJson, writeJson, statSig, memoByFile, uid, uuid, slug, clip, readTail };
