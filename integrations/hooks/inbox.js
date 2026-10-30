#!/usr/bin/env node
'use strict';
// Agentic Bridge inbox hook, registered for UserPromptSubmit and Stop.
// UserPromptSubmit: pending Bridge messages ride along as context for the new prompt.
// Stop: if messages arrived while the session worked, it is asked to answer before stopping.
// It must never break a session: on any problem it exits 0 without output.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.BRIDGE_DATA_DIR || path.join(os.homedir(), '.agentic-bridge');

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    const done = () => resolve(raw);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', done);
    setTimeout(done, 1500);
  });
}

function fmt(m) {
  const d = new Date(m.at);
  const hh = isNaN(d) ? '' : ' · ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return '— #' + m.room + ' · ' + m.from + hh + '\n' + m.text + (m.attachments && m.attachments.length ? '\nAdjuntos: ' + m.attachments.join(', ') : '');
}

(async () => {
  let input = {};
  try { input = JSON.parse((await readStdin()).replace(/^﻿/, '') || '{}'); } catch (e) { return; }
  const sid = input.session_id;
  const event = input.hook_event_name;
  if (!sid || (event === 'Stop' && input.stop_hook_active)) return;

  let base;
  let token;
  try {
    base = 'http://127.0.0.1:' + JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hub.json'), 'utf8')).port;
    token = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
  } catch (e) { return; }

  let messages = [];
  try {
    const res = await fetch(base + '/api/bridge/inbox/' + encodeURIComponent(sid) + '?consume=1&event=' + (event === 'Stop' ? 'stop' : 'prompt'), {
      headers: { 'x-bridge-token': token },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    messages = (await res.json()).messages || [];
  } catch (e) { return; }
  if (!messages.length) return;

  const body = '📨 Mensajes nuevos de Agentic Bridge (' + messages.length + '):\n\n' + messages.map(fmt).join('\n\n');
  if (event === 'Stop') {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: body + '\n\nSi alguno requiere respuesta, contesta con la herramienta bridge_send (to: "#sala" o "@nombre"). Si no requieren nada, termina sin más.',
    }));
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: body + '\n\nPara responder usa la herramienta bridge_send (to: "#sala" o "@nombre").',
      },
    }));
  }
})().catch(() => {});
