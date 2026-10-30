#!/usr/bin/env node
'use strict';
// Agentic Bridge inbox hook, registered for UserPromptSubmit and Stop (and PostToolUse when the
// person turns on mid-turn delivery in Settings).
// UserPromptSubmit: pending Bridge messages ride along as context for the new prompt.
// PostToolUse: they arrive between two tool calls, while the session is still working.
// Stop: if messages arrived while the session worked, it is asked to answer before stopping.
// It must never break a session: on any problem it exits 0 without output.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.BRIDGE_DATA_DIR || path.join(os.homedir(), '.agentic-bridge');

// Runs on every prompt and every stop in every connected session: clear the safety timer as
// soon as stdin ends and exit explicitly, so nothing left open delays the session.
function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => resolve(raw), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(raw); });
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj), () => process.exit(0));
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
  if (event === 'PostToolUse') {
    // Runs after every tool call: a subagent must not swallow its parent's mail, and with
    // nothing pending (the unread counter the hub keeps) there is no network call at all.
    if (input.agent_id || /[\\/]subagents[\\/]/.test(String(input.transcript_path || ''))) return;
    let pending = 0;
    try { pending = Number(fs.readFileSync(path.join(DATA_DIR, 'unread', sid.replace(/[^\w.-]/g, '_')), 'utf8')) || 0; } catch (e) {}
    if (!pending) return;
  }

  let base;
  let token;
  try {
    base = 'http://127.0.0.1:' + JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hub.json'), 'utf8')).port;
    token = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
  } catch (e) { return; }

  let messages = [];
  try {
    const res = await fetch(base + '/api/bridge/inbox/' + encodeURIComponent(sid) + '?consume=1&event=' + (event === 'Stop' ? 'stop' : event === 'PostToolUse' ? 'tool' : 'prompt'), {
      headers: { 'x-bridge-token': token },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    messages = (await res.json()).messages || [];
  } catch (e) { return; }
  if (!messages.length) return;

  const body = 'Mensajes nuevos de Agentic Bridge (' + messages.length + '):\n\n' + messages.map(fmt).join('\n\n');
  if (event === 'Stop') {
    emit({
      decision: 'block',
      reason: body + '\n\nSi alguno requiere respuesta, contesta con la herramienta bridge_send (to: "#sala" o "@nombre"). Si no requieren nada, termina sin más.',
    });
  } else if (event === 'PostToolUse') {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: body + '\n\nLlegaron mientras trabajabas. Si alguno requiere respuesta, contesta con bridge_send (to: "#sala" o "@nombre") y sigue con tu tarea; no la abandones por estos mensajes salvo que te lo pidan expresamente.',
      },
    });
  } else {
    emit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: body + '\n\nPara responder usa la herramienta bridge_send (to: "#sala" o "@nombre").',
      },
    });
  }
  return true;
})().catch(() => false).then((wrote) => { if (!wrote) process.exit(0); });
