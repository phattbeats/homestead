// Homestead — shared lists primitive (PHA-2586).
//
// Homestead is a household app. Chores / tasks are the
// "who-owns-this-due-when" primitive (`lib/user-model.js` tasks
// table + /api/tasks). Lists are the running, unordered, multiple-
// contributor primitive: groceries, packing lists, "to-do before the
// trip", "things the landlord owes us". They share the same
// household scope as tasks but are independent — the chores module
// does NOT own or read lists; the lists module is the source of
// truth here, and the chores `requires: ['lists']` declaration in
// `lib/modules.js` is a future-evidence promise that we'll have a
// real lists surface by the time chores depends on it (today the
// two are siblings, not parent/child).
//
// Constitutional compliance baked in here:
//   * Scope-gated reads (read:lists) and writes (write:lists) —
//     see server.js wiring.
//   * Scope phrasings live in lib/scope-display.js (the locked
//     PHA-2201 §3 vocabulary); this file does NOT define phrases.
//   * Every public listing is ORDER BY (the list's stable position
//     field, then created_at) + LIMIT — enforced by the unit
//     tests in scripts/test-lists.js.
//   * Tests must not INSERT list rows out-of-band. Schema
//     migration + the seed in seed() are the only places rows
//     are created; tests go through the public functions.

'use strict';

const crypto = require('crypto');

// Title cap so a misbehaving client can't 500 us with a megabyte of
// whitespace. Real bounds are enforced at the HTTP boundary too.
const TITLE_MAX = 200;
const NOTE_MAX = 1000;
const ITEMS_DEFAULT_LIMIT = 100;
const ITEMS_MAX_LIMIT = 500;

let _db = null;

function migrate(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'list'
                          CHECK(kind IN ('list','groceries','packing')),
      icon        TEXT NOT NULL DEFAULT '📝',
      position    INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lists_active ON lists(archived, position, created_at);

    CREATE TABLE IF NOT EXISTS list_items (
      id          TEXT PRIMARY KEY,
      list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      quantity    TEXT,
      checked     INTEGER NOT NULL DEFAULT 0,
      checked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      checked_at  TEXT,
      added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_list_items_list
      ON list_items(list_id, checked, position, created_at);
  `);
}

// seed() provisions a "Groceries" list for a brand-new install.
// Homestead is single-site; one seeded list is enough to demonstrate
// the primitive end-to-end. Additional lists are created by users
// from the Lists tab.
//
// The seed is idempotent: if a Groceries list already exists we skip.
// We match by name + kind because the list id is a UUID and shouldn't
// leak across reinstalls. Uses crypto.randomUUID() because the lists
// table is TEXT PRIMARY KEY (same pattern as walls.js / PHA-2150).
function seed(db) {
  if (!db) db = _db;
  if (!db) return;
  const existing = db.prepare(
    "SELECT id FROM lists WHERE name = ? AND kind = 'groceries' LIMIT 1"
  ).get('Groceries');
  if (existing) return;
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO lists (id, name, kind, icon, position)
    VALUES (?, 'Groceries', 'groceries', '🛒', 1)
  `).run(id);
  return db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
}

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/^\s+|\s+$/g, '');
  return s.length ? s : null;
}

// listView(row, opts?) — shape returned to API consumers. Matches
// the §7 snapshot contract's `lists` envelope category.
function listView(row, opts) {
  opts = opts || {};
  const itemCount = _db.prepare(
    'SELECT COUNT(*) AS c FROM list_items WHERE list_id = ?'
  ).get(row.id).c;
  const openCount = _db.prepare(
    'SELECT COUNT(*) AS c FROM list_items WHERE list_id = ? AND checked = 0'
  ).get(row.id).c;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    icon: row.icon,
    position: row.position,
    archived: !!row.archived,
    item_count: itemCount,
    open_count: openCount,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function itemView(row) {
  return {
    id: row.id,
    list_id: row.list_id,
    label: row.label,
    note: row.note || '',
    quantity: row.quantity || null,
    checked: !!row.checked,
    checked_by: row.checked_by,
    checked_at: row.checked_at,
    added_by: row.added_by,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---- Lists -------------------------------------------------------------

function listLists(opts) {
  opts = opts || {};
  const where = ['archived = ?'];
  const params = [opts.includeArchived ? 1 : 0];
  const rows = _db.prepare(`
    SELECT * FROM lists
    WHERE ${where.join(' AND ')}
    ORDER BY position ASC, created_at ASC
    LIMIT ?
  `).all(...params, opts.limit || 200);
  return rows.map((r) => listView(r));
}

function getList(id) {
  const row = _db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'list_not_found');
  return listView(row);
}

function createList(body, userId) {
  const name = trimOrNull(body && body.name);
  if (!name) throw httpError(400, 'name_required');
  if (name.length > TITLE_MAX) throw httpError(400, 'name_too_long');
  const kind = (body && body.kind) || 'list';
  if (!['list', 'groceries', 'packing'].includes(kind)) {
    throw httpError(400, 'invalid_kind');
  }
  const icon = (body && body.icon) || (
    kind === 'groceries' ? '🛒' : kind === 'packing' ? '🧳' : '📝'
  );
  // Next position = current max + 1 (NULLIF so an empty table → 0).
  const maxPos = _db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM lists'
  ).get().p;
  const id = crypto.randomUUID();
  _db.prepare(`
    INSERT INTO lists (id, name, kind, icon, position, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, kind, icon, maxPos + 1, userId || null);
  return getList(id);
}

function updateList(id, body) {
  const cur = _db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  if (!cur) throw httpError(404, 'list_not_found');
  const next = { ...cur, ...body };
  if (next.name !== cur.name) {
    const t = trimOrNull(next.name);
    if (!t) throw httpError(400, 'name_required');
    if (t.length > TITLE_MAX) throw httpError(400, 'name_too_long');
    next.name = t;
  }
  if (next.kind && !['list', 'groceries', 'packing'].includes(next.kind)) {
    throw httpError(400, 'invalid_kind');
  }
  _db.prepare(`
    UPDATE lists SET name=?, kind=?, icon=?, archived=?, updated_at=datetime('now')
    WHERE id=?
  `).run(next.name, next.kind, next.icon || cur.icon, next.archived ? 1 : 0, id);
  return getList(id);
}

function deleteList(id) {
  _db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  return { ok: true };
}

function reorderLists(orderedIds) {
  if (!Array.isArray(orderedIds)) throw httpError(400, 'ordered_ids_required');
  const tx = _db.transaction((ids) => {
    for (let i = 0; i < ids.length; i++) {
      _db.prepare('UPDATE lists SET position = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(i, ids[i]);
    }
  });
  tx(orderedIds);
  return listLists({});
}

// ---- Items -------------------------------------------------------------

function listItems(listId, opts) {
  opts = opts || {};
  const list = _db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!list) throw httpError(404, 'list_not_found');
  const where = ['list_id = ?'];
  const params = [listId];
  if (!opts.includeChecked) where.push('checked = 0');
  const limit = Math.min(opts.limit || ITEMS_DEFAULT_LIMIT, ITEMS_MAX_LIMIT);
  const rows = _db.prepare(`
    SELECT * FROM list_items
    WHERE ${where.join(' AND ')}
    ORDER BY position ASC, created_at ASC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(itemView);
}

function addItem(listId, body, userId) {
  const list = _db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!list) throw httpError(404, 'list_not_found');
  const label = trimOrNull(body && body.label);
  if (!label) throw httpError(400, 'label_required');
  if (label.length > TITLE_MAX) throw httpError(400, 'label_too_long');
  const note = (body && body.note) || '';
  if (String(note).length > NOTE_MAX) throw httpError(400, 'note_too_long');
  const quantity = trimOrNull(body && body.quantity);
  const maxPos = _db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM list_items WHERE list_id = ?'
  ).get(listId).p;
  const id = crypto.randomUUID();
  _db.prepare(`
    INSERT INTO list_items (id, list_id, label, note, quantity, position, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, listId, label, note, quantity, maxPos + 1, userId || null);
  // Bump the parent list's updated_at so list orderings can sort by it.
  _db.prepare(`UPDATE lists SET updated_at = datetime('now') WHERE id = ?`).run(listId);
  return itemView(_db.prepare('SELECT * FROM list_items WHERE id = ?').get(id));
}

function updateItem(itemId, body, callerId) {
  const cur = _db.prepare('SELECT * FROM list_items WHERE id = ?').get(itemId);
  if (!cur) throw httpError(404, 'item_not_found');
  const next = { ...cur, ...body };
  if (next.label !== cur.label) {
    const t = trimOrNull(next.label);
    if (!t) throw httpError(400, 'label_required');
    if (t.length > TITLE_MAX) throw httpError(400, 'label_too_long');
    next.label = t;
  }
  if (next.note !== cur.note && String(next.note || '').length > NOTE_MAX) {
    throw httpError(400, 'note_too_long');
  }
  const newChecked = next.checked ? 1 : 0;
  let checkedBy = cur.checked_by;
  let checkedAt = cur.checked_at;
  if (newChecked !== cur.checked) {
    checkedBy = newChecked ? (callerId || null) : null;
    checkedAt = newChecked ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null;
  }
  _db.prepare(`
    UPDATE list_items
       SET label=?, note=?, quantity=?, checked=?, checked_by=?, checked_at=?, updated_at=datetime('now')
     WHERE id=?
  `).run(next.label, next.note || '', trimOrNull(next.quantity), newChecked, checkedBy, checkedAt, itemId);
  _db.prepare(`UPDATE lists SET updated_at = datetime('now') WHERE id = ?`).run(cur.list_id);
  return itemView(_db.prepare('SELECT * FROM list_items WHERE id = ?').get(itemId));
}

function deleteItem(itemId) {
  const cur = _db.prepare('SELECT list_id FROM list_items WHERE id = ?').get(itemId);
  if (!cur) return { ok: true };
  _db.prepare('DELETE FROM list_items WHERE id = ?').run(itemId);
  _db.prepare(`UPDATE lists SET updated_at = datetime('now') WHERE id = ?`).run(cur.list_id);
  return { ok: true };
}

// publicStats() powers the home page chip / snapshot envelope.
// Keeps the shape stable even when the table is empty.
function publicStats() {
  const listCount = _db.prepare('SELECT COUNT(*) AS c FROM lists WHERE archived = 0').get().c;
  const openItemCount = _db.prepare(
    'SELECT COUNT(*) AS c FROM list_items WHERE checked = 0'
  ).get().c;
  const recent = _db.prepare(`
    SELECT l.id, l.name, l.icon, l.kind,
           (SELECT COUNT(*) FROM list_items WHERE list_id = l.id AND checked = 0) AS open_count
      FROM lists l
     WHERE l.archived = 0
     ORDER BY l.position ASC, l.created_at ASC
     LIMIT 5
  `).all();
  return {
    list_count: listCount,
    open_item_count: openItemCount,
    active_lists: recent,
  };
}

module.exports = {
  migrate,
  seed,
  listLists,
  getList,
  createList,
  updateList,
  deleteList,
  reorderLists,
  listItems,
  addItem,
  updateItem,
  deleteItem,
  publicStats,
  // exposed for unit tests
  listView,
  itemView,
};
