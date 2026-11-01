'use strict';
// Talks to Claude Code sessions that run in a terminal outside the editor (Git Bash, Windows
// Terminal, VS Code...). Claude Code's own push mechanism (channels) is an organization-level
// switch that Team and Enterprise plans ship turned off, so on Windows Bridge attaches to the
// session's console the way a person at the keyboard would: it reads the screen, types only when
// the input box is on screen and empty, and presses Enter once the box shows the text.
//
// One PowerShell worker (console-bridge.ps1) stays running and handles the requests one at a
// time; compiling its helper once keeps every request around a tenth of a second.

const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'console-bridge.ps1');
const TIMEOUT_MS = 15000;

let worker = null;
let seq = 0;

function startWorker() {
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const w = { proc, pending: new Map(), buf: '', ready: null };
  w.ready = new Promise((resolve) => { w.onReady = resolve; });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    w.buf += chunk;
    let nl;
    while ((nl = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, nl).replace(/\r$/, '');
      w.buf = w.buf.slice(nl + 1);
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const id = line.slice(0, tab);
      if (id === 'ready') { w.onReady(true); continue; }
      const job = w.pending.get(id);
      if (!job) continue;
      w.pending.delete(id);
      clearTimeout(job.timer);
      let out;
      try { out = JSON.parse(line.slice(tab + 1)); } catch (e) { out = { ok: false, reason: 'output' }; }
      job.resolve(out);
    }
  });
  proc.stderr.on('data', () => {});
  const dead = (reason) => {
    if (worker === w) worker = null;
    w.onReady(false);
    for (const job of w.pending.values()) { clearTimeout(job.timer); job.resolve({ ok: false, reason }); }
    w.pending.clear();
  };
  proc.on('exit', () => dead('worker-exit'));
  proc.on('error', () => dead('worker-error'));
  proc.stdin.on('error', () => {});
  return w;
}

// Requests go one after another: the worker attaches to one console at a time.
let chain = Promise.resolve();
function request(op, pid, arg) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve({ ok: false, reason: 'unsupported' });
  const run = async () => {
    if (!worker) worker = startWorker();
    const w = worker;
    if (!(await w.ready)) return { ok: false, reason: 'worker-start' };
    return new Promise((resolve) => {
      const id = String(++seq);
      const timer = setTimeout(() => {
        w.pending.delete(id);
        resolve({ ok: false, reason: 'timeout' });
        try { w.proc.kill(); } catch (e) {}
      }, TIMEOUT_MS);
      w.pending.set(id, { resolve, timer });
      w.proc.stdin.write(id + '\t' + op + '\t' + Number(pid) + '\t' + Buffer.from(String(arg || ''), 'utf8').toString('base64') + '\n');
    });
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// The hub's short wake-up prompt (room messages are never typed: the inbox hook delivers them).
function external(pid, text, opts) { return request(opts && opts.dryRun ? 'probe' : 'nudge', pid, text); }
// A prompt the person wrote in the editor (or from the phone) for that session.
function prompt(pid, text) { return request('prompt', pid, text); }
function screen(pid) { return request('screen', pid, ''); }
function keys(pid, spec) { return request('keys', pid, spec); }
function stop() { if (worker) { try { worker.proc.kill(); } catch (e) {} worker = null; } }

module.exports = { external, prompt, screen, keys, stop };
