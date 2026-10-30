'use strict';
// npm run check — syntax-checks every server, integration and web module.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dirs = ['server', 'integrations', 'scripts', 'web/js'];
const files = [];
function walk(d) {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(name)) files.push(p);
  }
}
dirs.forEach((d) => walk(path.join(root, d)));

let failed = 0;
for (const f of files) {
  // Browser modules are ES modules; check them as such.
  const isWeb = f.includes(path.join('web', 'js'));
  try {
    if (isWeb) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f), stdio: ['pipe', 'pipe', 'pipe'] });
    else execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error('✖ ' + path.relative(root, f) + '\n' + String(e.stderr || e.message));
  }
}
console.log(failed ? failed + ' archivo(s) con errores' : '✔ ' + files.length + ' archivos sin errores de sintaxis');
process.exit(failed ? 1 : 0);
