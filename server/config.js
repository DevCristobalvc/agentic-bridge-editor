'use strict';
// Paths, port and the local API token shared by the hub, the MCP bridge and the hooks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.BRIDGE_DATA_DIR || path.join(HOME, '.agentic-bridge');
const PORT = Number(process.env.BRIDGE_PORT || 4004);

for (const d of ['', 'rooms', 'uploads', 'inbox', 'unread', 'agents']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}

const TOKEN_FILE = path.join(DATA_DIR, 'token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN);
}
module.exports = {
  HOME,
  ROOT,
  DATA_DIR,
  PORT,
  TOKEN,
  WEB_DIR: path.join(ROOT, 'web'),
  CREW_DIR: process.env.CLAUDE_STATUSLINE_CREW_DIR || path.join(HOME, '.claude', 'crew'),
  AGY_DIR: path.join(HOME, '.gemini', 'antigravity-cli'),
  AGY_MCP_FILE: path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
  // The process this hub was started from may carry CLAUDE_CONFIG_DIR; children get their own.
  LAUNCH_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
};
