'use strict';
// The shells the editor can open: PowerShell, PowerShell 7, Git Bash, CMD and WSL.

const fs = require('fs');
const path = require('path');
const bin = require('./bin');

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

// Git for Windows: bin\bash.exe is the launcher that sets up the MSYS environment.
function gitBash() {
  const direct = [path.join(PF, 'Git', 'bin', 'bash.exe'), path.join(PF86, 'Git', 'bin', 'bash.exe'), path.join(LOCAL, 'Programs', 'Git', 'bin', 'bash.exe')].find(bin.isFile);
  if (direct) return direct;
  const git = bin.which('git');
  if (!git) return null;
  for (let dir = path.dirname(git), i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'bin', 'bash.exe');
    if (bin.isFile(candidate) && fs.existsSync(path.join(dir, 'git-bash.exe'))) return candidate;
  }
  return null;
}

let wslChecked = null;
function wslReady() {
  if (wslChecked !== null) return wslChecked;
  const exe = bin.which('wsl');
  if (!exe) return (wslChecked = false);
  // wsl.exe exists on every Windows 11; only offer it when a distribution is installed.
  const dir = path.join(LOCAL, 'Packages');
  try { wslChecked = fs.readdirSync(dir).some((n) => /CanonicalGroup|Debian|SUSE|Kali|WhitewaterFoundry|Fedora|Ubuntu|Alpine/i.test(n)); } catch (e) { wslChecked = false; }
  if (!wslChecked) {
    try { wslChecked = fs.readdirSync('C:\\ProgramData\\Microsoft\\Windows\\WSL').length > 0; } catch (e) {}
  }
  return wslChecked;
}

function list() {
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return [{ id: 'sh', label: path.basename(sh), icon: 'terminal', file: sh, args: ['-l'] }];
  }
  const out = [{ id: 'powershell', label: 'PowerShell', icon: 'terminal', file: 'powershell.exe', args: ['-NoLogo'] }];
  const pwsh = bin.which('pwsh', [path.join(PF, 'PowerShell', '7', 'pwsh.exe')]);
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', icon: 'terminal', file: pwsh, args: ['-NoLogo'] });
  const bash = gitBash();
  if (bash) out.push({ id: 'gitbash', label: 'Git Bash', icon: 'git', file: bash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } });
  out.push({ id: 'cmd', label: 'Símbolo del sistema', icon: 'square-terminal', file: process.env.ComSpec || 'cmd.exe', args: [] });
  if (wslReady()) out.push({ id: 'wsl', label: 'WSL', icon: 'penguin', file: bin.which('wsl'), args: [] });
  return out;
}

function find(id) {
  const all = list();
  return all.find((s) => s.id === id) || all[0];
}

module.exports = { list, find, gitBash };
