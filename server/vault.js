'use strict';
// The vault: notes, snippets and images shared by the human and every session, across accounts.

const { uid, clip } = require('./util');
const store = require('./store');

function list() {
  return store.vault.get().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
}

function save(input, author) {
  const now = Date.now();
  const title = String(input.title || '').trim().slice(0, 140);
  const text = String(input.text || '');
  if (!title && !text.trim() && !(input.attachments || []).length) throw Object.assign(new Error('La nota está vacía'), { status: 400 });
  const tags = (input.tags || []).map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, 12);
  if (input.id) {
    let out = null;
    store.vault.update((all) => all.map((n) => (n.id === input.id
      ? (out = Object.assign({}, n, { title: title || n.title, text, tags, attachments: input.attachments || n.attachments || [], pinned: input.pinned != null ? !!input.pinned : n.pinned, updatedAt: now }))
      : n)));
    if (!out) throw Object.assign(new Error('La nota no existe'), { status: 404 });
    return out;
  }
  const note = { id: uid('n'), title: title || clip(text.split('\n')[0], 60) || 'Sin título', text, tags, attachments: input.attachments || [], pinned: !!input.pinned, author: author || { kind: 'human', name: 'Tú' }, createdAt: now, updatedAt: now };
  store.vault.update((all) => [note].concat(all));
  return note;
}

function remove(id) {
  store.vault.update((all) => all.filter((n) => n.id !== id));
  return true;
}

function search(q, limit) {
  const needle = String(q || '').toLowerCase().trim();
  const words = needle.split(/\s+/).filter(Boolean);
  const hits = list().filter((n) => {
    if (!words.length) return true;
    const hay = (n.title + '\n' + n.text + '\n#' + n.tags.join(' #')).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return hits.slice(0, limit || 20);
}

module.exports = { list, save, remove, search };
