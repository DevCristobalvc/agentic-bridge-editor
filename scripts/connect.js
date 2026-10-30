'use strict';
// npm run connect — wires every Claude account on this machine (and Antigravity) to the Bridge.

const { connectAll } = require('../server/connect');

connectAll().then(({ results }) => {
  for (const r of results) {
    console.log((r.ok ? '✔ ' : '✖ ') + r.configDir);
    for (const line of r.log) console.log('    ' + line);
  }
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
