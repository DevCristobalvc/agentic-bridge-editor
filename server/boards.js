'use strict';
// Whiteboards (Excalidraw scenes). A project's board lives in its folder as
// .bridge/board.excalidraw, so it travels with the repo and opens on excalidraw.com too;
// free boards live in ~/.agentic-bridge/boards. Agents can pin notes through the MCP bridge:
// they wait in the scene's `bridgePending` list until an open board turns them into elements.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { readJson, writeJson, uid, clip } = require('./util');
const store = require('./store');

const DIR = path.join(DATA_DIR, 'boards');
fs.mkdirSync(DIR, { recursive: true });

function emptyScene(name) {
  return { type: 'excalidraw', version: 2, source: 'agentic-bridge', elements: [], appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {}, bridge: { name: name || 'Pizarra', createdAt: Date.now() } };
}

function project(id) { return store.projects.get().find((p) => p.id === id) || null; }

// ref: "p:<projectId>" for a project's board, "b_<id>" for a free one.
function resolve(ref) {
  const r = String(ref || '');
  if (r.startsWith('p:')) {
    const p = project(r.slice(2));
    if (!p) throw Object.assign(new Error('Proyecto no encontrado'), { status: 404 });
    return { ref: r, file: path.join(p.path, '.bridge', 'board.excalidraw'), name: p.name, kind: 'project', projectId: p.id };
  }
  if (!/^b_[a-f0-9]{10}$/.test(r)) throw Object.assign(new Error('Pizarra inválida'), { status: 400 });
  return { ref: r, file: path.join(DIR, r + '.excalidraw'), kind: 'free' };
}

function stat(file) { try { return fs.statSync(file); } catch (e) { return null; } }

function list() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => /^b_[a-f0-9]{10}\.excalidraw$/.test(n)); } catch (e) {}
  for (const n of names) {
    const file = path.join(DIR, n);
    const scene = readJson(file, null);
    const st = stat(file);
    out.push({ ref: n.replace(/\.excalidraw$/, ''), kind: 'free', name: (scene && scene.bridge && scene.bridge.name) || 'Pizarra', updatedAt: st ? st.mtimeMs : 0, elements: scene ? (scene.elements || []).filter((e) => !e.isDeleted).length : 0 });
  }
  for (const p of store.projects.get()) {
    const st = stat(path.join(p.path, '.bridge', 'board.excalidraw'));
    out.push({ ref: 'p:' + p.id, kind: 'project', name: p.name, projectId: p.id, path: p.path, updatedAt: st ? st.mtimeMs : 0, exists: !!st });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function create(name) {
  const ref = uid('b');
  writeJson(path.join(DIR, ref + '.excalidraw'), emptyScene(String(name || 'Pizarra').slice(0, 80)));
  return { ref, name: name || 'Pizarra' };
}

function read(ref) {
  const b = resolve(ref);
  const st = stat(b.file);
  const scene = (st && readJson(b.file, null)) || emptyScene(b.name);
  return { ref: b.ref, kind: b.kind, projectId: b.projectId || null, name: b.name || (scene.bridge && scene.bridge.name) || 'Pizarra', updatedAt: st ? st.mtimeMs : 0, scene };
}

function write(ref, scene) {
  const b = resolve(ref);
  if (!scene || !Array.isArray(scene.elements)) throw Object.assign(new Error('Escena inválida'), { status: 400 });
  const prev = readJson(b.file, null);
  const out = Object.assign({ type: 'excalidraw', version: 2, source: 'agentic-bridge' }, scene);
  out.bridge = Object.assign({}, (prev && prev.bridge) || { createdAt: Date.now() }, scene.bridge || {});
  // Notes that arrived while this scene was open survive the save unless it consumed them.
  const consumed = new Set((scene.bridgeConsumed || []).map(String));
  out.bridgePending = ((prev && prev.bridgePending) || []).filter((n) => !consumed.has(n.id));
  delete out.bridgeConsumed;
  writeJson(b.file, out);
  return { ref: b.ref, updatedAt: stat(b.file).mtimeMs, pending: out.bridgePending.length };
}

function rename(ref, name) {
  const b = resolve(ref);
  if (b.kind !== 'free') throw Object.assign(new Error('La pizarra de un proyecto lleva su nombre'), { status: 400 });
  const scene = readJson(b.file, null) || emptyScene(name);
  scene.bridge = Object.assign({}, scene.bridge, { name: String(name || 'Pizarra').slice(0, 80) });
  writeJson(b.file, scene);
  return { ref: b.ref, name: scene.bridge.name };
}

function remove(ref) {
  const b = resolve(ref);
  if (b.kind !== 'free') throw Object.assign(new Error('La pizarra de un proyecto se borra con el proyecto'), { status: 400 });
  try { fs.unlinkSync(b.file); } catch (e) {}
  return true;
}

// A sticky note from an agent or a session, applied by the next client that has the board open.
function addNote(ref, { text, author, tone }) {
  const b = resolve(ref);
  const scene = readJson(b.file, null) || emptyScene(b.name);
  const note = { id: uid('n'), text: clip(String(text || '').trim(), 1200), author: clip(String(author || ''), 60), tone: tone || null, at: Date.now() };
  if (!note.text) throw Object.assign(new Error('La nota está vacía'), { status: 400 });
  scene.bridgePending = (scene.bridgePending || []).concat([note]);
  writeJson(b.file, scene);
  return note;
}

// Plain text of a board, for agents: every text element, top to bottom, plus pending notes.
function textOf(ref) {
  const { scene, name } = read(ref);
  const texts = (scene.elements || []).filter((e) => !e.isDeleted && e.type === 'text' && e.text && e.text.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x).map((e) => e.text.trim());
  const frames = (scene.elements || []).filter((e) => !e.isDeleted && e.type === 'frame' && e.name).map((e) => e.name);
  return { name, frames, texts, pending: (scene.bridgePending || []).map((n) => (n.author ? n.author + ': ' : '') + n.text) };
}

module.exports = { list, create, read, write, rename, remove, addNote, textOf, resolve };
