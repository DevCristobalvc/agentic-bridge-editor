// API client, live store and WebSocket feed.
import { useEffect, useRef, useState } from '/vendor/htm-preact.js';

export const TOKEN = document.querySelector('meta[name="bridge-token"]').content;

async function request(method, url, body, opts = {}) {
  const headers = { 'x-bridge-token': TOKEN };
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers['content-type'] = body.type || 'application/octet-stream';
    if (opts.filename) headers['x-filename'] = encodeURIComponent(opts.filename);
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b, o) => request('POST', u, b === undefined ? {} : b, o),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

export const withToken = (url) => url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
export const rawFileUrl = (p) => withToken('/api/fs/raw?path=' + encodeURIComponent(p));

// ---------- store ----------
const state = {
  ready: false,
  connected: false,
  me: null,
  prefs: {},
  integration: null,
  accounts: [],
  sessions: [],
  rooms: [],
  projects: [],
  projectDetails: {},
  roles: [],
  terminals: [],
  usage: {},
  vault: [],
  shells: [],
  antigravity: null,
  secrets: [],
  connections: [],
  boards: [],
  activity: {},       // roomId -> memberId -> { state, text }
  roomMessages: {},   // roomId -> messages (only for rooms that were opened)
  overlay: null,      // { render, kind }
  toasts: [],
};
const subs = new Set();
const listeners = new Map();
let version = 0;

export const getState = () => state;
export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  version++;
  for (const f of subs) f();
}

// Re-renders when the selected value changes. Selecting the whole state re-renders on any change.
export function useStore(selector) {
  const [, force] = useState(0);
  const sel = useRef(selector);
  sel.current = selector;
  useEffect(() => {
    let prev = sel.current(state);
    let prevVersion = version;
    const f = () => {
      const next = sel.current(state);
      const changed = next === state ? prevVersion !== version : next !== prev;
      prev = next;
      prevVersion = version;
      if (changed) force((x) => x + 1);
    };
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return selector(state);
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
function fire(type, data) { for (const fn of listeners.get(type) || []) fn(data); }

// ---------- events from the hub ----------
function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item].concat(list);
  const next = list.slice();
  next[i] = item;
  return next;
}

function handle(ev) {
  const { type, data } = ev;
  switch (type) {
    case 'sessions': setState({ sessions: data }); break;
    case 'room': setState((s) => ({ rooms: upsert(s.rooms, data).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) })); break;
    case 'room:deleted': setState((s) => ({ rooms: s.rooms.filter((r) => r.id !== data.id) })); break;
    case 'room:message': setState((s) => {
      const list = s.roomMessages[data.roomId];
      if (!list || list.some((m) => m.id === data.message.id)) return {};
      return { roomMessages: Object.assign({}, s.roomMessages, { [data.roomId]: list.concat([data.message]) }) };
    }); break;
    case 'activity': setState((s) => {
      const room = Object.assign({}, s.activity[data.roomId] || {});
      if (data.state === 'idle') delete room[data.memberId];
      else room[data.memberId] = { state: data.state, text: data.text };
      return { activity: Object.assign({}, s.activity, { [data.roomId]: room }) };
    }); break;
    case 'terminals': setState({ terminals: data }); break;
    case 'projects': setState({ projects: data }); break;
    case 'project': if (data) setState((s) => ({
      projectDetails: Object.assign({}, s.projectDetails, { [data.id]: data }),
      projects: upsert(s.projects, Object.assign({}, data, { board: undefined, contractMd: undefined })),
    })); break;
    case 'roles': setState({ roles: data }); break;
    case 'prefs': setState({ prefs: data }); break;
    case 'usage': setState({ usage: data }); break;
    case 'vault': setState({ vault: data }); break;
    case 'integration': setState({ integration: data }); break;
    case 'secrets': setState({ secrets: data }); break;
    case 'connections': setState({ connections: data }); break;
    case 'boards': setState({ boards: data }); break;
    case 'unread': setState((s) => ({ sessions: s.sessions.map((x) => (x.id === data.sessionId ? Object.assign({}, x, { unread: data.count }) : x)) })); break;
    default: break;
  }
  fire(type, data);
}

let ws = null;
let retry = 0;
let everOpened = false;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?t=' + encodeURIComponent(TOKEN));
  ws.onopen = () => {
    const resync = everOpened;
    everOpened = true;
    retry = 0;
    setState({ connected: true });
    if (resync) boot(); // resync whatever we missed while disconnected
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    setState({ connected: false });
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

export async function boot() {
  const s = await api.get('/api/state');
  // Keep every room the user already opened in sync after a reconnect.
  const opened = Object.keys(state.roomMessages);
  const roomMessages = {};
  for (const id of opened) {
    try { roomMessages[id] = (await api.get('/api/rooms/' + id)).messages; } catch (e) {}
  }
  const activity = {};
  for (const r of s.rooms) activity[r.id] = r.activity || {};
  setState(Object.assign({}, s, { ready: true, activity, roomMessages }));
  if (!ws) connect();
}

export async function loadRoom(id) {
  const room = await api.get('/api/rooms/' + id);
  setState((s) => ({
    roomMessages: Object.assign({}, s.roomMessages, { [id]: room.messages }),
    rooms: upsert(s.rooms, Object.assign({}, room, { messages: undefined })),
    activity: Object.assign({}, s.activity, { [id]: room.activity || {} }),
  }));
  return room;
}

export async function loadProject(id) {
  const p = await api.get('/api/projects/' + id);
  setState((s) => ({ projectDetails: Object.assign({}, s.projectDetails, { [id]: p }) }));
  return p;
}

export async function upload(file, name) {
  return api.post('/api/uploads', file, { filename: name || file.name || 'pegado.png' });
}
