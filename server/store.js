'use strict';
// Small JSON-backed collections kept in memory and written through to ~/.agentic-bridge.

const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./config');
const { readJson, writeJson } = require('./util');
const { DEFAULT_ROLES } = require('./roles');

// Everything the browser should hear about goes through here; index.js fans it out over WS.
const bus = new EventEmitter();
bus.setMaxListeners(100);

function collection(name, initial) {
  const file = path.join(DATA_DIR, name + '.json');
  let value = readJson(file, null);
  if (value == null) value = typeof initial === 'function' ? initial() : initial;
  return {
    get: () => value,
    set(next) {
      value = next;
      writeJson(file, value);
      bus.emit('event', { type: name, data: value });
      return value;
    },
    update(fn) { return this.set(fn(value)); },
  };
}

const aliases = collection('aliases', {});       // sessionId -> display name
const prefs = collection('prefs', {});           // humanName, deliverOnStop, ...
const roles = collection('roles', () => DEFAULT_ROLES.map((r) => Object.assign({}, r)));
const projects = collection('projects', []);
const usage = collection('usage', {});           // configDir -> normalized rate limits

module.exports = { bus, aliases, prefs, roles, projects, usage };
