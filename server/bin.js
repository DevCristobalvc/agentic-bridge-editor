'use strict';
// Finding command-line tools and running them. Native .exe files run directly; tools that only
// ship a .cmd wrapper (az, npm-installed CLIs) go through cmd.exe, always with fixed arguments.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const ORDER = isWin ? ['.exe', '.cmd', '.bat'] : [''];
const cache = new Map();

function isFile(f) { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }

function which(name, extra) {
  const key = name + '|' + (extra || []).join('|');
  if (cache.has(key)) return cache.get(key);
  let found = (extra || []).find(isFile) || null;
  if (!found) {
    for (const raw of String(process.env.PATH || '').split(path.delimiter)) {
      const dir = raw.replace(/^"|"$/g, '');
      if (!dir) continue;
      found = ORDER.map((ext) => path.join(dir, name + ext)).find(isFile) || null;
      if (found) break;
    }
  }
  cache.set(key, found);
  return found;
}

function forget() { cache.clear(); }

function quoteArg(a) {
  return /[\s"&|<>^()%!]/.test(a) ? '"' + String(a).replace(/"/g, '""') + '"' : String(a);
}

// spawn-style [file, args, extraOptions] for a resolved binary.
function argv(bin, args) {
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    // cmd.exe expands %VAR% (and !VAR!) even inside quotes, and quotes can't be escaped
    // reliably: an argument carrying any of these never reaches a .cmd wrapper.
    const bad = args.find((a) => /[%!"\r\n]/.test(String(a)));
    if (bad !== undefined) throw Object.assign(new Error('Argumento no permitido para ' + path.basename(bin) + ': ' + String(bad).slice(0, 40)), { status: 400 });
    const line = '"' + [bin].concat(args).map(quoteArg).join(' ') + '"';
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { windowsVerbatimArguments: true }];
  }
  return [bin, args, {}];
}

// Run a tool and collect its output. Never rejects: { ok, code, stdout, stderr, missing }.
function run(name, args, opts) {
  const o = opts || {};
  const bin = o.bin || which(name, o.extra);
  if (!bin) return Promise.resolve({ ok: false, code: null, stdout: '', stderr: '', missing: true });
  let file;
  let list;
  let extra;
  try { [file, list, extra] = argv(bin, args || []); } catch (e) { return Promise.resolve({ ok: false, code: null, stdout: '', stderr: e.message }); }
  return new Promise((resolve) => {
    const child = execFile(file, list, Object.assign({
      timeout: o.timeout || 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: o.env || process.env, cwd: o.cwd,
    }, extra), (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && err.killed) });
    });
    // Some CLIs wait on an open stdin before answering; there is never input to give them.
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(); }
  });
}

module.exports = { which, run, argv, forget, isFile };
