#!/usr/bin/env node
'use strict';
// abe-on: brings Agentic Bridge up from any terminal. If the hub is already answering it just
// opens the editor; otherwise it starts the hub in the background (no window, log in
// ~/.agentic-bridge/hub.log), waits until it answers and opens the browser.
//   abe-on            start if needed and open the editor
//   abe-on --no-open  start if needed, without opening the browser

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.BRIDGE_DATA_DIR || path.join(os.homedir(), '.agentic-bridge');
const PORT = Number(process.env.BRIDGE_PORT || 4004);
const LOG = path.join(DATA_DIR, 'hub.log');
const open = !process.argv.includes('--no-open');

function hubPort() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hub.json'), 'utf8')).port) || PORT; } catch (e) { return PORT; }
}

async function answers(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (e) { return false; }
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd.exe', ['/c', 'start', '', url], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}

function startHub() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fd = fs.openSync(LOG, 'a');
  fs.writeSync(fd, '\n--- abe-on ' + new Date().toISOString() + ' ---\n');
  // A hub started from inside a Claude Code session must not pass that session's variables on
  // to the sessions it opens.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_CODE_|^CLAUDECODE$/.test(k)) env[k] = v;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

(async () => {
  let port = hubPort();
  const url = () => 'http://127.0.0.1:' + port;
  if (await answers(port)) {
    console.log('Agentic Bridge ya está corriendo en ' + url());
  } else {
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
      console.error('Faltan las dependencias. Ejecuta "npm install" en ' + ROOT + ' y vuelve a intentarlo.');
      process.exit(1);
    }
    const pid = startHub();
    process.stdout.write('Levantando Agentic Bridge');
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      process.stdout.write('.');
      port = hubPort();
      up = await answers(port);
    }
    process.stdout.write('\n');
    if (!up) {
      console.error('El hub no respondió en 20 s. Revisa el registro: ' + LOG);
      process.exit(1);
    }
    console.log('Agentic Bridge listo en ' + url() + ' (pid ' + pid + ', registro en ' + LOG + ')');
  }
  if (open) openBrowser(url());
})();
