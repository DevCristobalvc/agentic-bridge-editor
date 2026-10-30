'use strict';
// The other accounts a developer lives in: GitHub, Vercel, Azure, Docker, npm, Git, SSH and
// friends. Each provider is read from its own CLI (no tokens are read or stored by Bridge);
// signing in or out runs the CLI's own interactive flow in an integrated terminal.

const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');
const { bus } = require('./store');
const bin = require('./bin');

const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const lastLine = (s) => { const l = lines(s); return l[l.length - 1] || ''; };
const jsonOf = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

const PROVIDERS = [
  {
    id: 'github', name: 'GitHub', icon: 'github', bin: 'gh', install: 'winget install --id GitHub.cli', docs: 'https://cli.github.com/manual/gh_auth_login',
    login: 'gh auth login --web', logout: 'gh auth logout',
    async detect() {
      const r = await bin.run('gh', ['auth', 'status', '--json', 'hosts']);
      const j = jsonOf(r.stdout);
      if (j && j.hosts) {
        const accounts = [];
        for (const [host, list] of Object.entries(j.hosts)) {
          for (const a of list) accounts.push({ id: a.login, label: a.login, detail: host + (a.scopes ? ' · ' + a.scopes : ''), active: !!a.active, ok: a.state === 'success' });
        }
        return { state: accounts.some((a) => a.ok) ? 'connected' : 'disconnected', accounts, switchable: accounts.length > 1 };
      }
      const txt = r.stdout + '\n' + r.stderr;
      const m = /Logged in to (\S+) account (\S+)/.exec(txt) || /Logged in to (\S+) as (\S+)/.exec(txt);
      return m ? { state: 'connected', accounts: [{ id: m[2], label: m[2], detail: m[1], active: true, ok: true }] } : { state: 'disconnected', accounts: [] };
    },
  },
  {
    id: 'vercel', name: 'Vercel', icon: 'triangle', bin: 'vercel', install: 'npm i -g vercel', docs: 'https://vercel.com/docs/cli',
    login: 'vercel login', logout: 'vercel logout',
    async detect() {
      const r = await bin.run('vercel', ['whoami'], { timeout: 20000 });
      const user = r.ok ? lastLine(r.stdout) : '';
      let team = null;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'config.json'), 'utf8'));
        team = cfg.currentTeam || null;
      } catch (e) {}
      return user ? { state: 'connected', accounts: [{ id: user, label: user, detail: team ? 'equipo ' + team : 'cuenta personal', active: true, ok: true }] } : { state: 'disconnected', accounts: [], note: r.timedOut ? 'Vercel no respondió a tiempo' : null };
    },
  },
  {
    id: 'azure', name: 'Azure', icon: 'cloud', bin: 'az', install: 'winget install --id Microsoft.AzureCLI', docs: 'https://learn.microsoft.com/cli/azure/authenticate-azure-cli',
    login: 'az login', logout: 'az logout',
    async detect() {
      const r = await bin.run('az', ['account', 'show', '-o', 'json'], { timeout: 20000 });
      const j = r.ok ? jsonOf(r.stdout) : null;
      if (!j) return { state: 'disconnected', accounts: [] };
      return {
        state: 'connected',
        accounts: [{ id: j.id, label: (j.user && j.user.name) || 'cuenta', detail: j.name + ' · ' + (j.tenantDisplayName || j.tenantId || ''), active: true, ok: true }],
        details: [['Suscripción', j.name], ['Tenant', j.tenantDisplayName || j.tenantId], ['Entorno', j.environmentName]],
        subscriptions: true,
      };
    },
  },
  {
    id: 'docker', name: 'Docker', icon: 'box', bin: 'docker', install: 'winget install --id Docker.DockerDesktop', docs: 'https://docs.docker.com/reference/cli/docker/login/',
    login: 'docker login', logout: 'docker logout',
    async detect() {
      const r = await bin.run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.docker', 'config.json'), 'utf8')); } catch (e) {}
      const registries = Object.keys(cfg.auths || {}).map((h) => h.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, ''));
      const running = r.ok && !!r.stdout.trim();
      return {
        state: running ? 'connected' : 'stopped',
        accounts: registries.map((h) => ({ id: h, label: h, detail: 'registro con credenciales' + (cfg.credsStore ? ' (' + cfg.credsStore + ')' : ''), active: true, ok: true })),
        details: [['Motor', running ? 'Docker ' + r.stdout.trim() + ' corriendo' : 'detenido'], ['Contexto', cfg.currentContext || 'default']],
      };
    },
  },
  {
    id: 'npm', name: 'npm', icon: 'package', bin: 'npm', install: 'winget install --id OpenJS.NodeJS.LTS', docs: 'https://docs.npmjs.com/cli/commands/npm-login',
    login: 'npm login', logout: 'npm logout',
    async detect() {
      const [who, reg] = await Promise.all([bin.run('npm', ['whoami'], { timeout: 15000 }), bin.run('npm', ['config', 'get', 'registry'], { timeout: 10000 })]);
      const user = who.ok ? lastLine(who.stdout) : '';
      const registry = lastLine(reg.stdout) || 'https://registry.npmjs.org/';
      return user ? { state: 'connected', accounts: [{ id: user, label: user, detail: registry, active: true, ok: true }] } : { state: 'disconnected', accounts: [], details: [['Registro', registry]] };
    },
  },
  {
    id: 'git', name: 'Git', icon: 'branch', bin: 'git', install: 'winget install --id Git.Git', docs: 'https://git-scm.com/book/es/v2/Inicio---Sobre-el-Control-de-Versiones-Configurando-Git-por-primera-vez',
    async detect() {
      const get = (k) => bin.run('git', ['config', '--global', '--get', k], { timeout: 5000 }).then((r) => lastLine(r.stdout));
      const [name, email, helper, version] = await Promise.all([get('user.name'), get('user.email'), get('credential.helper'), bin.run('git', ['--version'], { timeout: 5000 }).then((r) => lastLine(r.stdout))]);
      return {
        state: name || email ? 'connected' : 'disconnected',
        accounts: name || email ? [{ id: 'identity', label: name || '(sin nombre)', detail: email || '(sin correo)', active: true, ok: true }] : [],
        details: [['Versión', version.replace(/^git version /, '')], ['Credenciales', helper || 'sin helper']],
        identity: { name, email },
      };
    },
  },
  {
    id: 'ssh', name: 'Claves SSH', icon: 'key', bin: 'ssh-keygen', docs: 'https://docs.github.com/es/authentication/connecting-to-github-with-ssh',
    login: 'ssh-keygen -t ed25519', loginLabel: 'Generar clave',
    async detect() {
      const dir = path.join(HOME, '.ssh');
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.pub')); } catch (e) {}
      const accounts = files.map((f) => {
        const parts = (fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\s+/));
        return { id: f, label: f.replace(/\.pub$/, ''), detail: (parts[0] || '').replace(/^ssh-/, '') + (parts[2] ? ' · ' + parts.slice(2).join(' ') : ''), active: true, ok: true, copy: parts.slice(0, 2).join(' ') };
      });
      return { state: accounts.length ? 'connected' : 'disconnected', accounts, details: [['Carpeta', dir]] };
    },
  },
  {
    id: 'kubernetes', name: 'Kubernetes', icon: 'layers', bin: 'kubectl', docs: 'https://kubernetes.io/docs/reference/kubectl/',
    async detect() {
      const r = await bin.run('kubectl', ['config', 'get-contexts', '-o', 'name'], { timeout: 8000 });
      const cur = await bin.run('kubectl', ['config', 'current-context'], { timeout: 8000 });
      const current = lastLine(cur.stdout);
      const accounts = lines(r.stdout).map((c) => ({ id: c, label: c, detail: c === current ? 'contexto actual' : '', active: c === current, ok: true }));
      return { state: accounts.length ? 'connected' : 'disconnected', accounts };
    },
  },
  { id: 'aws', name: 'AWS', icon: 'cloud', bin: 'aws', install: 'winget install --id Amazon.AWSCLI', login: 'aws configure sso', logout: 'aws sso logout',
    async detect() { const r = await bin.run('aws', ['sts', 'get-caller-identity', '--output', 'json'], { timeout: 15000 }); const j = r.ok ? jsonOf(r.stdout) : null; return j ? { state: 'connected', accounts: [{ id: j.Arn, label: j.Arn.split('/').pop(), detail: 'cuenta ' + j.Account, active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
  { id: 'gcloud', name: 'Google Cloud', icon: 'cloud', bin: 'gcloud', install: 'winget install --id Google.CloudSDK', login: 'gcloud auth login', logout: 'gcloud auth revoke',
    async detect() { const r = await bin.run('gcloud', ['config', 'list', '--format=json'], { timeout: 15000 }); const j = r.ok ? jsonOf(r.stdout) : null; const acc = j && j.core && j.core.account; return acc ? { state: 'connected', accounts: [{ id: acc, label: acc, detail: 'proyecto ' + (j.core.project || '—'), active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
  { id: 'supabase', name: 'Supabase', icon: 'database', bin: 'supabase', install: 'npm i -g supabase', login: 'supabase login', logout: 'supabase logout',
    async detect() { const r = await bin.run('supabase', ['projects', 'list'], { timeout: 15000 }); return { state: r.ok ? 'connected' : 'disconnected', accounts: [] }; } },
  { id: 'netlify', name: 'Netlify', icon: 'globe', bin: 'netlify', install: 'npm i -g netlify-cli', login: 'netlify login', logout: 'netlify logout',
    async detect() { const r = await bin.run('netlify', ['status'], { timeout: 15000 }); const m = /Email:\s*(\S+)/.exec(r.stdout); return m ? { state: 'connected', accounts: [{ id: m[1], label: m[1], active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
  { id: 'cloudflare', name: 'Cloudflare', icon: 'cloud', bin: 'wrangler', install: 'npm i -g wrangler', login: 'wrangler login', logout: 'wrangler logout',
    async detect() { const r = await bin.run('wrangler', ['whoami'], { timeout: 15000 }); const m = /associated with the email (\S+?)\.?\s/.exec(r.stdout); return m ? { state: 'connected', accounts: [{ id: m[1], label: m[1], active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
  { id: 'firebase', name: 'Firebase', icon: 'zap', bin: 'firebase', install: 'npm i -g firebase-tools', login: 'firebase login', logout: 'firebase logout',
    async detect() { const r = await bin.run('firebase', ['login:list'], { timeout: 15000 }); const m = /Logged in as (\S+)/.exec(r.stdout); return m ? { state: 'connected', accounts: [{ id: m[1], label: m[1], active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
  { id: 'fly', name: 'Fly.io', icon: 'send', bin: 'flyctl', install: 'winget install --id flyctl', login: 'flyctl auth login', logout: 'flyctl auth logout',
    async detect() { const r = await bin.run('flyctl', ['auth', 'whoami'], { timeout: 15000 }); const u = r.ok ? lastLine(r.stdout) : ''; return u ? { state: 'connected', accounts: [{ id: u, label: u, active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
  { id: 'railway', name: 'Railway', icon: 'zap', bin: 'railway', install: 'npm i -g @railway/cli', login: 'railway login', logout: 'railway logout',
    async detect() { const r = await bin.run('railway', ['whoami'], { timeout: 15000 }); const m = /Logged in as (.+)/.exec(r.stdout); return m ? { state: 'connected', accounts: [{ id: m[1], label: m[1].trim(), active: true, ok: true }] } : { state: 'disconnected', accounts: [] }; } },
];

const status = new Map(); // id -> view
const running = new Map(); // id -> promise

function baseView(p) {
  return { id: p.id, name: p.name, icon: p.icon, install: p.install || null, docs: p.docs || null, login: p.login || null, loginLabel: p.loginLabel || null, logout: p.logout || null };
}

function view(p) {
  const s = status.get(p.id);
  return Object.assign(baseView(p), s || { installed: !!bin.which(p.bin), state: 'unknown', accounts: [] });
}

function list() { return PROVIDERS.map(view); }

function emit() { bus.emit('event', { type: 'connections', data: list() }); }

function refreshOne(p) {
  if (running.has(p.id)) return running.get(p.id);
  const job = (async () => {
    const installed = !!bin.which(p.bin);
    status.set(p.id, Object.assign({}, status.get(p.id) || {}, { installed, state: installed ? 'checking' : 'missing', accounts: (status.get(p.id) || {}).accounts || [] }));
    emit();
    let out = { state: 'missing', accounts: [] };
    if (installed) {
      try { out = await p.detect(); } catch (e) { out = { state: 'error', accounts: [], note: e.message }; }
    }
    status.set(p.id, Object.assign({ installed, checkedAt: Date.now(), details: [], note: null }, out));
    emit();
  })();
  running.set(p.id, job);
  return job.finally(() => running.delete(p.id));
}

async function refresh(id) {
  bin.forget();
  const targets = id ? PROVIDERS.filter((p) => p.id === id) : PROVIDERS;
  await Promise.all(targets.map(refreshOne));
  return id ? view(targets[0]) : list();
}

function stale() {
  const oldest = Math.min(...PROVIDERS.map((p) => (status.get(p.id) || {}).checkedAt || 0));
  return Date.now() - oldest > 5 * 60 * 1000;
}

function find(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error('Proveedor desconocido'), { status: 404 });
  return p;
}

// ---------- provider-specific actions (fixed commands, validated arguments) ----------
async function azureSubscriptions() {
  const r = await bin.run('az', ['account', 'list', '-o', 'json'], { timeout: 20000 });
  const j = r.ok ? jsonOf(r.stdout) : null;
  if (!j) throw Object.assign(new Error('No pude listar las suscripciones de Azure'), { status: 502 });
  return j.map((s) => ({ id: s.id, name: s.name, tenant: s.tenantDisplayName || s.tenantId, isDefault: !!s.isDefault, state: s.state }));
}

async function azureUse(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Suscripción inválida'), { status: 400 });
  const r = await bin.run('az', ['account', 'set', '--subscription', id], { timeout: 20000 });
  if (!r.ok) throw Object.assign(new Error(lastLine(r.stderr) || 'az account set falló'), { status: 502 });
  return refresh('azure');
}

async function githubSwitch(user) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(String(user))) throw Object.assign(new Error('Usuario inválido'), { status: 400 });
  const r = await bin.run('gh', ['auth', 'switch', '--user', user], { timeout: 15000 });
  if (!r.ok) throw Object.assign(new Error(lastLine(r.stderr) || 'gh auth switch falló'), { status: 502 });
  return refresh('github');
}

async function gitIdentity({ name, email }) {
  const set = async (k, v) => {
    if (v == null) return;
    const val = String(v).trim().slice(0, 120);
    if (/[\r\n%!"]/.test(val)) throw Object.assign(new Error('El valor no puede llevar saltos de línea ni los caracteres % ! "'), { status: 400 });
    const r = await bin.run('git', ['config', '--global', k, val], { timeout: 5000 });
    if (!r.ok) throw Object.assign(new Error(lastLine(r.stderr) || 'git config falló'), { status: 502 });
  };
  await set('user.name', name);
  await set('user.email', email);
  return refresh('git');
}

module.exports = { list, refresh, stale, find, azureSubscriptions, azureUse, githubSwitch, gitIdentity };
