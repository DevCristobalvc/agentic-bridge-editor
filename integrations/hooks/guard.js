#!/usr/bin/env node
'use strict';
// Agentic Bridge guard hook (PreToolUse). Enforces the guards of the nearest project contract
// (.bridge/contract.json): no edits to protected paths, no forbidden commands.
// Outside a contracted project it does nothing. Exit code 2 blocks the tool and tells Claude why.

const fs = require('fs');
const path = require('path');

// Runs before every guarded tool call in every connected session, so it must finish in
// milliseconds: the safety timer is cleared as soon as stdin ends, and the process exits
// explicitly instead of waiting on anything left open.
function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => resolve(raw), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(raw); });
  });
}

function findContract(start) {
  let dir = start;
  for (let i = 0; i < 15 && dir; i++) {
    const f = path.join(dir, '.bridge', 'contract.json');
    try {
      if (fs.statSync(f).isFile()) return { root: dir, contract: JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) };
    } catch (e) {}
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

// Gitignore-like: a pattern without "/" matches the file name at any depth.
function matchesPath(rel, pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p.includes('/')) return globToRegex(p).test(path.posix.basename(rel));
  return globToRegex(p).test(rel);
}

function matchesCommand(cmd, pattern) {
  const p = String(pattern);
  const re = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (re) { try { return new RegExp(re[1], re[2] || 'i').test(cmd); } catch (e) { return false; } }
  return cmd.toLowerCase().includes(p.toLowerCase());
}

// Exit code 2 blocks the tool; stderr carries the reason. Let the process end on its own so
// the reason is flushed before exit.
function block(reason) {
  process.exitCode = 2;
  process.stderr.write(reason);
  return true;
}

(async () => {
  let input;
  try { input = JSON.parse((await readStdin()).replace(/^﻿/, '') || '{}'); } catch (e) { return; }
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const target = ti.file_path || ti.notebook_path || null;
  const found = findContract(target ? path.dirname(path.resolve(cwd, target)) : cwd) || findContract(cwd);
  if (!found) return;
  const { root, contract } = found;
  const guards = contract.guards || {};
  const name = contract.project || path.basename(root);

  if (target) {
    const rel = path.relative(root, path.resolve(cwd, target)).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const hit = (guards.protectedPaths || []).find((g) => matchesPath(rel, g));
      if (hit) return block('Bloqueado por el contrato de "' + name + '": `' + rel + '` es una ruta protegida (patrón `' + hit + '`). Si de verdad hay que cambiarla, pídelo en la sala del equipo y espera aprobación del humano.');
    }
  }

  const cmd = typeof ti.command === 'string' ? ti.command : null;
  if (cmd && /^(Bash|PowerShell)$/.test(tool)) {
    const hit = (guards.forbiddenCommands || []).find((g) => matchesCommand(cmd, g));
    if (hit) return block('Bloqueado por el contrato de "' + name + '": el comando coincide con `' + hit + '`, que está prohibido. Busca otra forma o pide aprobación al humano en la sala del equipo.');
  }
  return false;
})().catch(() => {}).then(() => {
  // Nothing should be left open; this unref'd timer only guards against surprises.
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
});
