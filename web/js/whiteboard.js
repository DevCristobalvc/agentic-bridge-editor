// Whiteboards: the real Excalidraw editor (React, loaded on demand) inside the Preact app.
// A project's board is also its kanban: one frame per status column and one card per task in
// todo.md. Dragging a card to another column writes the new status to todo.md; when an agent
// changes todo.md, the card moves by itself. Everything else on the canvas is free drawing.
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { api, on } from './api.js';
import { Icon, toast, promptDialog } from './ui.js';

const LANES = [
  { key: 'todo', name: 'Por hacer' },
  { key: 'doing', name: 'En curso' },
  { key: 'blocked', name: 'Bloqueadas' },
  { key: 'done', name: 'Hechas' },
];
const LANE_W = 300;
const LANE_H = 520;
const LANE_GAP = 48;
const CARD_W = 268;
const CARD_H = 96;
const CARD_GAP = 14;
const PAD_TOP = 24;
const VIOLET = '#7048e8';
const CARD_BG = '#ffffff';
const NOTE_BG = '#e5dbff';

const clientId = Math.random().toString(36).slice(2);
const rand = () => Math.floor(Math.random() * 2 ** 31);
const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 10);

// ---------- loading Excalidraw ----------
let libPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No pude cargar ' + src));
    document.head.appendChild(s);
  });
}
export function loadExcalidraw() {
  if (window.ExcalidrawLib) return Promise.resolve(window.ExcalidrawLib);
  if (!libPromise) {
    window.EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw/';
    libPromise = (window.React ? Promise.resolve() : loadScript('/vendor/react.js'))
      .then(() => (window.ReactDOM ? null : loadScript('/vendor/react-dom.js')))
      .then(() => loadScript('/vendor/excalidraw/excalidraw.production.min.js'))
      .then(() => window.ExcalidrawLib);
  }
  return libPromise;
}

function appTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ---------- storage backends ----------
// Saves carry the version this tab last saw; the hub refuses (412) a save over a newer file.
function boardStore(ref) {
  const url = '/api/boards/' + encodeURIComponent(ref);
  let base = null;
  return {
    load: () => api.get(url).then((b) => { base = b.updatedAt; return { name: b.name, scene: b.scene, projectId: b.projectId }; }),
    save: (scene, consumed) => api.put(url, { scene: Object.assign({}, scene, { bridgeConsumed: consumed }), clientId, base }).then((r) => { base = r.updatedAt; return r; }),
    matches: (data) => data && data.ref === ref,
  };
}
function fileStore(path) {
  return {
    load: () => api.get('/api/fs/read?path=' + encodeURIComponent(path)).then((f) => {
      let scene = null;
      try { scene = JSON.parse(f.content || '{}'); } catch (e) { throw new Error('El archivo no es una escena de Excalidraw válida'); }
      return { name: f.name.replace(/\.excalidraw$/, ''), scene, eol: f.eol, bom: f.bom };
    }),
    save: (scene) => api.put('/api/fs/write', { path, content: JSON.stringify(scene, null, 2), eol: 'lf' }),
    matches: () => false,
  };
}

// ---------- three-way merge for changes made elsewhere (another tab, an agent's note) ----------
function merge(local, remote, base) {
  const L = new Map(local.map((e) => [e.id, e]));
  const R = new Map(remote.map((e) => [e.id, e]));
  const out = [];
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id);
    const r = R.get(id);
    if (l && r) out.push(r.version > l.version ? r : l);
    else if (r) { if (!base.has(id)) out.push(r); } // new over there; skip if we deleted it here
    else if (l) { if (!(base.has(id) && base.get(id) === l.version)) out.push(l); } // keep unless deleted over there
  }
  return out;
}

// ---------- controller: one per mounted board ----------
class Board {
  constructor({ store, title, onStatus, onTaskChange, projectId }) {
    this.store = store;
    this.title = title || 'Pizarra';
    this.onStatus = onStatus;
    this.onTaskChange = onTaskChange;
    this.projectId = projectId || null;
    this.api = null;
    this.lib = null;
    this.root = null;
    this.savedVersion = -1;
    this.base = new Map();
    this.saveTimer = null;
    this.syncTimer = null;
    this.tasks = null;
    this.inflight = new Map();
    this.rejected = new Set();
    this.consumed = [];
    this.savePromise = null;
    this.destroyed = false;
    // Closing the browser tab with unsaved strokes: ask the browser to wait while they are saved.
    this.onUnload = (e) => { if (this.isDirty()) { this.save(true); e.preventDefault(); e.returnValue = ''; } };
  }

  isDirty() {
    if (!this.api || !this.lib) return false;
    return this.consumed.length > 0 || this.lib.getSceneVersion(this.api.getSceneElementsIncludingDeleted()) !== this.savedVersion;
  }

  async mount(lib, el) {
    this.lib = lib;
    const data = await this.store.load();
    if (this.destroyed) return;
    const scene = data.scene || {};
    this.pending = scene.bridgePending || [];
    const elements = lib.restoreElements(scene.elements || [], null);
    this.base = new Map(elements.map((e) => [e.id, e.version]));
    this.savedVersion = lib.getSceneVersion(elements);
    const R = window.React;
    const props = {
      initialData: {
        elements,
        files: scene.files || {},
        appState: Object.assign({ viewBackgroundColor: '#ffffff', currentItemFontFamily: 1, currentItemStrokeColor: '#1e1e1e', currentItemRoughness: 1 }, scene.appState || {}, { theme: appTheme(), collaborators: new Map() }),
        scrollToContent: true,
        libraryItems: this.libraryItems(lib),
      },
      // window.__abBoard: handle for the browser end-to-end tests.
      excalidrawAPI: (a) => { this.api = a; window.__abBoard = this; setTimeout(() => this.afterReady(), 0); },
      onChange: (els, appState) => this.changed(els, appState),
      langCode: 'es-ES',
      theme: appTheme(),
      name: this.title,
      UIOptions: { canvasActions: { toggleTheme: false, loadScene: true, saveToActiveFile: false, export: { saveFileToDisk: true } } },
      renderTopRightUI: () => this.topRight(R),
    };
    this.props = props;
    this.root = window.ReactDOM.createRoot(el);
    this.root.render(R.createElement(lib.Excalidraw, props));
    window.addEventListener('beforeunload', this.onUnload);
  }

  topRight(R) {
    const btn = (label, title, onClick, primary) => R.createElement('button', { type: 'button', className: 'wb-btn' + (primary ? ' primary' : ''), title, onClick }, label);
    const items = [];
    if (this.projectId) {
      items.push(btn('+ Tarea', 'Nueva tarea en todo.md (aparece en «Por hacer»)', () => this.addTask(), true));
      items.push(btn('Selección → tarea', 'Convierte la nota o el texto seleccionado en una tarea de todo.md', () => this.selectionToTask()));
    }
    items.push(btn('+ Nota', 'Pega una nota adhesiva en el centro de la vista', () => this.addNoteHere()));
    return R.createElement('div', { className: 'wb-bar' }, ...items);
  }

  afterReady() {
    if (!this.api || this.destroyed) return;
    this.applyPending();
    if (this.tasks) this.sync();
    // Open with everything in view, like a board on a wall.
    setTimeout(() => {
      if (!this.api || this.destroyed) return;
      const els = this.api.getSceneElements();
      if (!els.length) return;
      this.api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.86, animate: false });
      // leave room for the toolbar that floats over the top of the canvas
      const st = this.api.getAppState();
      this.api.updateScene({ appState: { scrollY: st.scrollY + 28 / ((st.zoom && st.zoom.value) || 1) } });
    }, 60);
  }

  setTheme(theme) {
    if (!this.root || !this.lib) return;
    this.props = Object.assign({}, this.props, { theme });
    this.root.render(window.React.createElement(this.lib.Excalidraw, this.props));
  }

  refresh() { if (this.api && this.api.refresh) this.api.refresh(); }

  // ---------- saving ----------
  changed(els, appState) {
    if (!this.lib || this.destroyed) return;
    const v = this.lib.getSceneVersion(els);
    if (v !== this.savedVersion) {
      this.onStatus && this.onStatus('editing');
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 900);
    }
    const busy = appState.selectedElementsAreBeingDragged || appState.draggingElement || appState.resizingElement || appState.editingElement;
    if (this.tasks && !busy) {
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => this.sync(), 450);
    }
  }

  // One save at a time; a save asked for while another runs follows it. `force` saves even while
  // the board is being torn down (leaving the view must not lose the last strokes).
  save(force, attempt) {
    if (!this.api || (this.destroyed && !force)) return Promise.resolve();
    if (this.savePromise) return this.savePromise.then(() => (this.isDirty() ? this.save(force) : null));
    const job = (async () => {
      const els = this.api.getSceneElements();
      const version = this.lib.getSceneVersion(this.api.getSceneElementsIncludingDeleted());
      const consumed = this.consumed.slice();
      const scene = JSON.parse(this.lib.serializeAsJSON(els, this.api.getAppState(), this.api.getFiles(), 'local'));
      scene.source = 'agentic-bridge';
      this.onStatus && this.onStatus('saving');
      try {
        await this.store.save(scene, consumed);
        this.consumed = this.consumed.filter((id) => !consumed.includes(id));
        this.savedVersion = version;
        this.base = new Map(els.map((e) => [e.id, e.version]));
        return 'ok';
      } catch (e) {
        if (e.status === 412 && (attempt || 0) < 3) return 'conflict';
        this.onStatus && this.onStatus('error');
        toast('No pude guardar la pizarra: ' + e.message, 'bad');
        return 'error';
      }
    })();
    this.savePromise = job.finally(() => { this.savePromise = null; });
    return this.savePromise.then(async (result) => {
      if (result === 'conflict') {
        // Someone else saved first: take their changes, then save the combination.
        await this.remoteChanged(true);
        return this.save(force, (attempt || 0) + 1);
      }
      if (result !== 'ok') return null;
      if (this.isDirty()) {
        // Edits made while the request was in flight: save them too.
        this.onStatus && this.onStatus('editing');
        if (this.destroyed) return this.save(true);
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 400);
      } else this.onStatus && this.onStatus('saved');
      return null;
    });
  }

  // A save from another tab, or a note from an agent.
  async remoteChanged(force) {
    if (!this.api || (this.destroyed && !force)) return;
    let data;
    try { data = await this.store.load(); } catch (e) { return; }
    const remote = this.lib.restoreElements((data.scene && data.scene.elements) || [], null);
    const merged = merge(this.api.getSceneElements(), remote, this.base);
    this.base = new Map(remote.map((e) => [e.id, e.version]));
    this.pending = (data.scene && data.scene.bridgePending) || [];
    this.api.updateScene({ elements: merged });
    if (data.scene && data.scene.files) this.api.addFiles(Object.values(data.scene.files));
    this.applyPending();
  }

  // ---------- sticky notes ----------
  sticky(text, x, y, author) {
    const body = author ? text + '\n— ' + author : text;
    const [rect, label] = this.lib.convertToExcalidrawElements([{
      type: 'rectangle', id: uid('note'), x, y, width: 240, height: 120, backgroundColor: NOTE_BG, strokeColor: 'transparent', fillStyle: 'solid', roughness: 1, roundness: { type: 3 },
      label: { text: body.length > 400 ? body.slice(0, 399) + '…' : body, fontSize: 16, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', strokeColor: '#1e1e1e' },
    }], { regenerateIds: false });
    return [Object.assign({}, rect, { customData: { bridge: 'note' } }), label];
  }

  applyPending() {
    if (!this.api || !this.pending || !this.pending.length) return;
    const fresh = this.pending.filter((n) => !this.consumed.includes(n.id));
    if (!fresh.length) return;
    const els = this.api.getSceneElements();
    const lanes = els.filter((e) => e.customData && e.customData.bridge === 'lane');
    const right = lanes.length ? Math.max(...lanes.map((f) => f.x + f.width)) + 80 : 0;
    const notes = els.filter((e) => e.customData && e.customData.bridge === 'note' && e.x >= right - 1);
    let y = notes.length ? Math.max(...notes.map((n) => n.y + n.height)) + 20 : (lanes[0] ? lanes[0].y : 0);
    const add = [];
    for (const n of fresh) {
      const els2 = this.sticky(n.text, right, y, n.author);
      add.push(...els2);
      y += els2[0].height + 20;
      this.consumed.push(n.id);
    }
    this.api.updateScene({ elements: els.concat(add) });
    toast(fresh.length === 1 ? 'Nueva nota en la pizarra de ' + (fresh[0].author || 'un agente') : fresh.length + ' notas nuevas en la pizarra', 'info');
  }

  addNoteHere() {
    if (!this.api) return;
    const st = this.api.getAppState();
    const z = (st.zoom && st.zoom.value) || 1;
    const x = -st.scrollX + st.width / 2 / z - 120;
    const y = -st.scrollY + st.height / 2 / z - 60;
    const els = this.sticky('Nota', x, y);
    this.api.updateScene({ elements: this.api.getSceneElements().concat(els), appState: { selectedElementIds: { [els[0].id]: true } } });
  }

  // ---------- kanban <-> todo.md ----------
  setTasks(board) {
    this.tasks = board ? board.tasks : [];
    for (const [id, status] of this.inflight) {
      const t = this.tasks.find((x) => x.id === id);
      if (t && t.status === status) this.inflight.delete(id);
    }
    if (this.api) this.sync();
  }

  cardText(t) {
    const title = (t.title || '(sin título)').replace(/\s+/g, ' ');
    const lines = [t.id + ' · ' + (title.length > 90 ? title.slice(0, 89) + '…' : title)];
    const meta = [t.owner ? (t.owner.startsWith('@') ? t.owner : '@' + t.owner) : null, t.checks ? t.checked + '/' + t.checks + ' criterios' : null].filter(Boolean);
    if (meta.length) lines.push(meta.join(' · '));
    return lines.join('\n');
  }

  card(t, x, y, id, frameId) {
    const text = this.cardText(t);
    const [rect, label] = this.lib.convertToExcalidrawElements([{
      type: 'rectangle', id: id || uid('task'), x, y, width: CARD_W, height: CARD_H,
      strokeColor: VIOLET, backgroundColor: CARD_BG, fillStyle: 'solid', strokeWidth: 1, roughness: 1, roundness: { type: 3 },
      strokeStyle: t.status === 'blocked' ? 'dashed' : 'solid', opacity: t.status === 'done' ? 60 : 100,
      label: { text, fontSize: 16, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', strokeColor: '#1e1e1e' },
    }], { regenerateIds: false });
    return [
      Object.assign({}, rect, { frameId: frameId || null, customData: { bridge: 'task', taskId: t.id, synced: t.status, text, style: t.status } }),
      Object.assign({}, label, { frameId: frameId || null }),
    ];
  }

  lane(key, x, y) {
    const l = LANES.find((z) => z.key === key);
    const [frame] = this.lib.restoreElements([{
      type: 'frame', id: uid('lane-' + key), x, y, width: LANE_W, height: LANE_H, name: l.name, angle: 0,
      strokeColor: '#bbb', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
      groupIds: [], frameId: null, roundness: null, seed: rand(), version: 1, versionNonce: rand(), isDeleted: false, boundElements: null,
      updated: Date.now(), link: null, locked: false, customData: { bridge: 'lane', lane: key },
    }], null);
    return frame;
  }

  sync() {
    if (!this.api || !this.lib || !this.tasks || this.destroyed) return;
    const { newElementWith } = this.lib;
    let els = this.api.getSceneElementsIncludingDeleted().slice();
    const byId = new Map(els.map((e) => [e.id, e]));
    const live = () => els.filter((e) => !e.isDeleted);
    let changed = false;
    const put = (el) => { const i = els.findIndex((x) => x.id === el.id); if (i === -1) els.push(el); else els[i] = el; byId.set(el.id, el); changed = true; };

    // columns
    const lanes = new Map();
    for (const e of live()) if (e.type === 'frame' && e.customData && e.customData.bridge === 'lane' && !lanes.has(e.customData.lane)) lanes.set(e.customData.lane, e);
    if (lanes.size < LANES.length) {
      const existing = [...lanes.values()];
      const y0 = existing.length ? Math.min(...existing.map((f) => f.y)) : 0;
      let x = existing.length ? Math.max(...existing.map((f) => f.x + f.width)) + LANE_GAP : 0;
      for (const l of LANES) {
        if (lanes.has(l.key)) continue;
        const f = this.lane(l.key, existing.length ? x : LANES.indexOf(l) * (LANE_W + LANE_GAP), y0);
        if (existing.length) x += LANE_W + LANE_GAP;
        lanes.set(l.key, f);
        put(f);
      }
    }
    const laneById = new Map([...lanes.values()].map((f) => [f.id, f]));
    const laneOf = (c) => {
      if (c.frameId && laneById.has(c.frameId)) return laneById.get(c.frameId).customData.lane;
      const cx = c.x + c.width / 2;
      const cy = c.y + c.height / 2;
      for (const f of lanes.values()) if (cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height) return f.customData.lane;
      return null;
    };
    const textOf = (rect) => (rect.boundElements || []).filter((b) => b.type === 'text').map((b) => byId.get(b.id)).find(Boolean);
    const bottomOf = (key, skipId) => {
      const f = lanes.get(key);
      const inLane = live().filter((e) => e.customData && e.customData.bridge === 'task' && e.id !== skipId && laneOf(e) === key);
      return inLane.length ? Math.max(...inLane.map((c) => c.y + c.height)) + CARD_GAP : f.y + PAD_TOP;
    };
    const place = (rect, key) => {
      const f = lanes.get(key);
      const x = f.x + (LANE_W - CARD_W) / 2;
      const y = bottomOf(key, rect.id);
      const dx = x - rect.x;
      const dy = y - rect.y;
      put(newElementWith(rect, { x, y, frameId: f.id }));
      const t = textOf(rect);
      if (t) put(newElementWith(t, { x: t.x + dx, y: t.y + dy, frameId: f.id }));
      if (y + rect.height + PAD_TOP > f.y + f.height) put(newElementWith(f, { height: y + rect.height + PAD_TOP * 2 - f.y }));
    };

    // cards
    const cards = new Map();
    for (const e of live()) if (e.customData && e.customData.bridge === 'task' && !cards.has(e.customData.taskId)) cards.set(e.customData.taskId, e);
    const ids = new Set(this.tasks.map((t) => t.id));
    const moves = [];
    for (const t of this.tasks) {
      let rect = cards.get(t.id);
      if (!rect) {
        const f = lanes.get(t.status) || lanes.get('todo');
        const [r, label] = this.card(t, f.x + (LANE_W - CARD_W) / 2, bottomOf(t.status), null, f.id);
        put(r); put(label);
        if (r.y + r.height + PAD_TOP > f.y + f.height) put(newElementWith(f, { height: r.y + r.height + PAD_TOP * 2 - f.y }));
        continue;
      }
      const where = laneOf(rect);
      const synced = rect.customData.synced;
      if (t.status !== synced) {
        // todo.md changed (an agent, or a status we wrote): the card follows it.
        if (where !== t.status && lanes.has(t.status)) { place(rect, t.status); rect = byId.get(rect.id); }
        put(newElementWith(rect, { customData: Object.assign({}, rect.customData, { synced: t.status }) }));
        rect = byId.get(rect.id);
      } else if (where && where !== t.status && this.rejected.has(t.id)) {
        // todo.md refused the move (read-only file, project gone): the card goes back.
        this.rejected.delete(t.id);
        if (lanes.has(t.status)) { place(rect, t.status); rect = byId.get(rect.id); }
      } else if (where && where !== t.status && this.inflight.get(t.id) !== where) {
        // The person dragged the card to another column: write it to todo.md.
        this.inflight.set(t.id, where);
        moves.push({ taskId: t.id, status: where });
      }
      // Text and style follow the task.
      const text = this.cardText(t);
      if (rect.customData.text !== text || rect.customData.style !== t.status) {
        const old = textOf(rect);
        const [fresh, label] = this.card(t, rect.x, rect.y, rect.id, rect.frameId);
        const others = (rect.boundElements || []).filter((b) => b.type !== 'text');
        put(newElementWith(rect, {
          height: Math.max(rect.height, fresh.height), strokeStyle: fresh.strokeStyle, opacity: fresh.opacity,
          boundElements: others.concat([{ type: 'text', id: label.id }]),
          customData: Object.assign({}, rect.customData, { text, style: t.status }),
        }));
        if (old) put(newElementWith(old, { isDeleted: true }));
        put(label);
      }
    }
    // tasks that left todo.md take their card with them
    for (const [taskId, rect] of cards) {
      if (ids.has(taskId)) continue;
      put(newElementWith(rect, { isDeleted: true }));
      const t = textOf(rect);
      if (t) put(newElementWith(t, { isDeleted: true }));
    }
    // column titles carry their counts
    for (const [key, f] of lanes) {
      const n = this.tasks.filter((t) => (this.inflight.get(t.id) || t.status) === key).length;
      const name = LANES.find((l) => l.key === key).name + ' · ' + n;
      const cur = byId.get(f.id);
      if (cur.name !== name) put(newElementWith(cur, { name }));
    }
    if (changed) this.api.updateScene({ elements: els });
    if (moves.length && this.onTaskChange) this.onTaskChange(moves);
  }

  async addTask() {
    const title = await promptDialog({ title: 'Nueva tarea', label: 'Título', placeholder: 'p. ej. Validar el formulario de registro', confirm: 'Agregar a todo.md' });
    if (!title || !title.trim()) return;
    try { await api.post('/api/projects/' + this.projectId + '/tasks', { title: title.trim(), status: 'todo' }); toast('Tarea agregada a todo.md'); }
    catch (e) { toast(e.message, 'bad'); }
  }

  async selectionToTask() {
    if (!this.api) return;
    const st = this.api.getAppState();
    const els = this.api.getSceneElements();
    const sel = els.filter((e) => st.selectedElementIds[e.id]);
    const container = sel.find((e) => e.type !== 'text' && (e.boundElements || []).some((b) => b.type === 'text')) || null;
    const textEl = container ? els.find((e) => e.containerId === container.id) : sel.find((e) => e.type === 'text');
    const text = textEl ? (textEl.originalText || textEl.text || '').trim() : '';
    if (!text) { toast('Selecciona una nota o un texto para convertirlo en tarea', 'bad'); return; }
    if (container && container.customData && container.customData.bridge === 'task') { toast('Esa tarjeta ya es la tarea ' + container.customData.taskId, 'info'); return; }
    const [first, ...rest] = text.split('\n');
    try {
      const out = await api.post('/api/projects/' + this.projectId + '/tasks', { title: first.slice(0, 160), description: rest.join(' ').trim(), status: 'todo' });
      toast('Tarea ' + out.taskId + ' creada en todo.md');
    } catch (e) { toast(e.message, 'bad'); }
  }

  libraryItems(lib) {
    try {
      const make = (name, text, bg) => ({
        id: 'ab-' + name, status: 'published', created: 1,
        elements: lib.convertToExcalidrawElements([{ type: 'rectangle', x: 0, y: 0, width: 240, height: 110, backgroundColor: bg, strokeColor: bg === '#ffffff' ? VIOLET : 'transparent', fillStyle: 'solid', roughness: 1, roundness: { type: 3 }, label: { text, fontSize: 16, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', strokeColor: '#1e1e1e' } }]),
      });
      return [
        make('nota', 'Nota', NOTE_BG),
        make('decision', 'Decisión:\n…', '#d0bfff'),
        make('riesgo', 'Riesgo:\n…', '#f3d9fa'),
        make('pregunta', 'Pregunta para el equipo:\n…', '#ffffff'),
      ];
    } catch (e) { return []; }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.syncTimer);
    clearTimeout(this.saveTimer);
    window.removeEventListener('beforeunload', this.onUnload);
    // Leaving the board: let a running save finish, save what is still pending, then let
    // Excalidraw go (the detached React tree still answers getSceneElements meanwhile).
    Promise.resolve(this.savePromise).catch(() => {})
      .then(() => (this.isDirty() ? this.save(true) : null)).catch(() => {})
      .finally(() => this.unmount());
  }

  unmount() { try { this.root && this.root.unmount(); } catch (e) {} this.root = null; this.api = null; }
}

// ---------- Preact wrapper ----------
const STATUS = { saved: 'Guardado', saving: 'Guardando…', editing: 'Cambios sin guardar', error: 'No se pudo guardar' };

export function Whiteboard({ boardRef, file, title, project, fullscreen, onExitFull }) {
  const mountEl = useRef(null);
  const ctl = useRef(null);
  const [phase, setPhase] = useState('loading');
  const [status, setStatus] = useState('saved');

  useEffect(() => {
    let alive = true;
    setPhase('loading');
    const store = file ? fileStore(file) : boardStore(boardRef);
    const b = new Board({
      store, title, projectId: project ? project.id : null, onStatus: (s) => alive && setStatus(s),
      onTaskChange: (moves) => {
        for (const m of moves) {
          api.patch('/api/projects/' + project.id + '/tasks/' + encodeURIComponent(m.taskId), { status: m.status })
            .then(() => toast(m.taskId + ' → ' + LANES.find((l) => l.key === m.status).name + ' (todo.md actualizado)'))
            .catch((e) => { b.inflight.delete(m.taskId); b.rejected.add(m.taskId); b.sync(); toast('No pude mover ' + m.taskId + ': ' + e.message, 'bad'); });
        }
      },
    });
    ctl.current = b;
    if (project) b.tasks = (project.board && project.board.tasks) || [];
    loadExcalidraw().then((lib) => b.mount(lib, mountEl.current)).then(() => alive && setPhase('ready'))
      .catch((e) => alive && setPhase('error:' + e.message));
    const off = on('board', (d) => { if (d && d.clientId !== clientId && store.matches(d)) b.remoteChanged(); });
    const mo = new MutationObserver(() => b.setTheme(appTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { alive = false; off(); mo.disconnect(); b.destroy(); };
  }, [boardRef, file]);

  useEffect(() => { if (project && ctl.current) ctl.current.setTasks(project.board); }, [project && project.board]);
  useEffect(() => { const t = setTimeout(() => ctl.current && ctl.current.refresh(), 60); return () => clearTimeout(t); }, [fullscreen]);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && e.shiftKey && onExitFull) onExitFull(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  return html`<div class=${'wb-host' + (fullscreen ? ' full' : '')}>
    <div class="wb-mount" ref=${mountEl}></div>
    ${phase === 'loading' ? html`<div class="wb-loading"><div class="row"><span class="spinner"></span> Abriendo la pizarra…</div></div>` : null}
    ${phase.startsWith('error') ? html`<div class="wb-loading"><div class="col" style="align-items:center"><${Icon} name="alert" /><b>No pude abrir la pizarra</b><span class="muted">${phase.slice(6)}</span></div></div>` : null}
    ${phase === 'ready' && status !== 'saved' ? html`<div class="wb-sync">${status === 'saving' ? html`<span class="spinner"></span>` : null}${STATUS[status]}</div>` : null}
  </div>`;
}

