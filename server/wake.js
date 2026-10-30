'use strict';
// Wakes an idle Claude Code session that runs in a terminal outside the editor. Claude Code's own
// push mechanism (channels) is an organization-level switch that Team and Enterprise plans ship
// turned off, so on Windows Bridge attaches to the session's console and types a short, fixed
// prompt, the way a person would: only when the input box is on screen and empty (see
// console-wake.ps1). The room messages themselves are never typed; the inbox hook delivers them
// as context when that prompt is submitted.

const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'console-wake.ps1');
const inflight = new Set();

function external(pid, text, opts) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !pid) return resolve({ ok: false, reason: 'unsupported' });
    if (inflight.has(pid)) return resolve({ ok: false, reason: 'busy' });
    inflight.add(pid);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-TargetPid', String(pid), '-TextB64', Buffer.from(String(text), 'utf8').toString('base64')];
    if (opts && opts.dryRun) args.push('-DryRun');
    execFile('powershell.exe', args, { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      inflight.delete(pid);
      const line = String(stdout || '').trim().split(/\r?\n/).pop();
      try { resolve(JSON.parse(line)); } catch (e) { resolve({ ok: false, reason: err ? 'error: ' + err.message.split('\n')[0] : 'output' }); }
    });
  });
}

module.exports = { external };
