'use strict';
// Headless agents: each room agent is a persistent Claude session driven turn by turn with
// `claude -p --output-format stream-json`, resumed by its own session id so it keeps memory.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { DATA_DIR } = require('./config');
const { claudeArgv, childEnv } = require('./claude');
const { clip } = require('./util');
const sessions = require('./sessions');

const running = new Map(); // agent key -> child process

// Headless turns cannot ask for permission, so every agent may at least look around and use
// the Bridge tools. Anything that changes state still follows the role's permission mode.
const BASE_ALLOWED = [
  'Read', 'Glob', 'Grep', 'LS', 'mcp__agentic-bridge',
  'Bash(ls:*)', 'Bash(pwd)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'PowerShell(Get-ChildItem:*)', 'PowerShell(Get-Content:*)', 'PowerShell(Get-Location)', 'PowerShell(git status:*)', 'PowerShell(git diff:*)', 'PowerShell(git log:*)',
];

function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.notebook_path || input.command || input.pattern || input.url || input.description || '';
  return clip(String(v).replace(/\s+/g, ' '), 90);
}

function buildArgs(agent, sysFile, resume) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', sysFile,
    '--permission-mode', agent.permissionMode || 'acceptEdits'];
  if (resume) args.push('--resume', agent.sessionUuid);
  else args.push('--session-id', agent.sessionUuid, '-n', agent.name);
  if (agent.model) args.push('--model', agent.model);
  // Variadic flag: keep it last. The prompt itself goes through stdin.
  const allowed = [...new Set(BASE_ALLOWED.concat(agent.allowedTools || []))];
  args.push('--allowedTools', ...allowed);
  return args;
}

function spawnTurn({ key, agent, roomId, systemPrompt, prompt, onEvent, resume }) {
  return new Promise((resolve) => {
    const sysFile = path.join(DATA_DIR, 'agents', agent.id + '.md');
    fs.writeFileSync(sysFile, systemPrompt);
    const env = childEnv(agent.configPath, { BRIDGE_SESSION_ID: agent.sessionUuid, BRIDGE_AGENT_ID: agent.id, BRIDGE_ROOM_ID: roomId });
    const started = Date.now();
    let proc;
    try {
      const [file, argv] = claudeArgv(buildArgs(agent, sysFile, resume));
      proc = spawn(file, argv, { cwd: agent.cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ text: '', cost: 0, isError: true, error: e.message, tools: [], durationMs: 0 });
      return;
    }
    running.set(key, proc);
    let buf = '';
    let stderr = '';
    let result = null;
    let sawInit = false;
    const tools = [];
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type === 'system' && o.subtype === 'init') { sawInit = true; onEvent({ kind: 'start' }); }
        else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          for (const b of o.message.content) {
            if (b.type === 'tool_use') {
              tools.push(b.name);
              onEvent({ kind: 'tool', name: b.name, text: summarize(b.input) });
            } else if (b.type === 'text' && b.text) onEvent({ kind: 'text', text: clip(b.text, 140) });
          }
        } else if (o.type === 'rate_limit_event' && o.rate_limit_info) {
          sessions.recordUsage(agent.configDir, o.rate_limit_info, 'agent');
        } else if (o.type === 'result') result = o;
      }
    });
    proc.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
    proc.on('error', (e) => { stderr += '\n' + e.message; });
    proc.on('close', (code) => {
      running.delete(key);
      const killed = proc.__killed;
      resolve({
        text: result && typeof result.result === 'string' ? result.result : '',
        cost: (result && result.total_cost_usd) || 0,
        isError: killed || !result || !!result.is_error,
        error: killed ? 'detenido por el usuario' : !result ? (stderr.trim() || 'salió con código ' + code) : result.is_error ? String(result.result || result.subtype) : null,
        tools,
        sawInit,
        missingSession: !result && /no conversation found/i.test(stderr),
        durationMs: Date.now() - started,
      });
    });
  });
}

async function runTurn(opts) {
  const res = await spawnTurn(Object.assign({}, opts, { resume: !!opts.agent.started }));
  // A resume can fail if the first turn never created the session; start it fresh once.
  if (res.missingSession && opts.agent.started) return spawnTurn(Object.assign({}, opts, { resume: false }));
  return res;
}

function isRunning(key) { return running.has(key); }

function kill(key) {
  const proc = running.get(key);
  if (!proc) return false;
  proc.__killed = true;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  else proc.kill('SIGTERM');
  return true;
}

function killAll() { for (const key of running.keys()) kill(key); }

module.exports = { runTurn, isRunning, kill, killAll };
