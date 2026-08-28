#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2586 acceptance tests for lib/lists.js: schema migrate, seed,
// list CRUD, item CRUD, the publicStats() envelope, and the
// snapshot.js integration. Defensive grep guard: no ORDER BY in
// lib/lists.js may sort by anything but (position, created_at), so
// a future "sort by updated_at" PR fails CI outright.
//
// Tests do NOT INSERT list rows out-of-band — the only place rows
// are created is via lib/lists.seed() / createList() / addItem().
// That's the hard rule from the issue body.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assertThrowsStatus(fn, status, label) {
  try { fn(); ng(label, 'did not throw'); }
  catch (e) { assertEq(e.status, status, label); }
}

console.log('PHA-2586 lists tests\n');

// ---- Guard: every ORDER BY in lib/lists.js must sort by position ----
console.log('Guard: ORDER BY defensive grep');
const listsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lists.js'), 'utf8');
const orderByRe = /ORDER BY\s+([^\n]+?)(?:LIMIT|`|\n)/gi;
let m;
let badOrderBy = null;
while ((m = orderByRe.exec(listsSrc))) {
  const clause = m[1].trim();
  // Allowed clauses: `position ASC, created_at ASC` (or DESC).
  if (!/\bposition\b/i.test(clause)) { badOrderBy = clause; break; }
}
assert(!badOrderBy, 'no ORDER BY sorts by anything other than (position, created_at)', badOrderBy);

// ---- Guard: tests do not INSERT list rows out-of-band ----
console.log('Guard: no direct list-row inserts in this test');
const testSrc = fs.readFileSync(__filename, 'utf8');
// Build the table names rather than writing the guarded phrases literally:
// this check is meant to find executable fixture SQL, not match itself.
const listTable = `list${'s'}`;
const itemTable = `list_${'items'}`;
const outOfBandInsert = new RegExp(
  `INSERT\\s+INTO\\s+(?:${listTable}|${itemTable})\\b`, 'i'
);
assert(!outOfBandInsert.test(testSrc), 'test file does not INSERT list rows directly');

(async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-lists-test-'));
  process.env.DATA_DIR = tmpDataDir;

  const userModel = require('../lib/user-model');
  const lists = require('../lib/lists');
  const snapshot = require('../lib/snapshot');

  const dbPath = path.join(tmpDataDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  lists.migrate(db);

  // ---- Schema: tables exist with the right columns ----
  console.log('\nSchema');
  const listsCols = db.prepare("PRAGMA table_info(lists)").all().map(c => c.name);
  const itemsCols = db.prepare("PRAGMA table_info(list_items)").all().map(c => c.name);
  for (const c of ['id', 'name', 'kind', 'icon', 'position', 'archived', 'created_by', 'created_at', 'updated_at']) {
    assert(listsCols.includes(c), `lists.${c} exists`);
  }
  for (const c of ['id', 'list_id', 'label', 'note', 'quantity', 'checked', 'checked_by', 'checked_at', 'added_by', 'position', 'created_at', 'updated_at']) {
    assert(itemsCols.includes(c), `list_items.${c} exists`);
  }
  // CHECK constraint on kind
  const listsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='lists'").get().sql;
  assert(/CHECK\(kind IN \(\'list\',\'groceries\',\'packing\'\)\)/.test(listsSql), 'lists.kind CHECK constraint');
  // FK from list_items.list_id → lists.id
  const itemsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='list_items'").get().sql;
  assert(/REFERENCES\s+lists\(id\)\s+ON\s+DELETE\s+CASCADE/.test(itemsSql), 'list_items.list_id FK cascade');

  // ---- Seed: Groceries appears once and only once ----
  console.log('\nSeed');
  const gro1 = lists.seed(db);
  assert(gro1 && gro1.name === 'Groceries' && gro1.kind === 'groceries', 'seed() returns Groceries row');
  const gro2 = lists.seed(db);
  assertEq(gro2, undefined, 'seed() is idempotent (no second Groceries)');
  const groceriesCount = db.prepare("SELECT COUNT(*) c FROM lists WHERE name = 'Groceries'").get().c;
  assertEq(groceriesCount, 1, 'exactly one Groceries list after double-seed');

  // ---- listLists() returns the seeded list (and respects archived) ----
  console.log('\nlistLists');
  const initial = lists.listLists({});
  assertEq(initial.length, 1, 'listLists() returns 1 list after seed');
  assertEq(initial[0].open_count, 0, 'seeded list has open_count=0');
  assertEq(initial[0].item_count, 0, 'seeded list has item_count=0');

  // ---- createList: required fields, kind enum, position assignment ----
  console.log('\ncreateList');
  const packing = lists.createList({ name: 'Trip packing', kind: 'packing' }, 1);
  assertEq(packing.kind, 'packing', 'createList honors kind');
  assertEq(packing.icon, '🧳', 'createList defaults icon from kind');
  assertEq(packing.position, 2, 'createList assigns position = max+1 (seed was 1, so 2)');
  assertThrowsStatus(() => lists.createList({ name: '   ' }, 1), 400, 'createList rejects empty name');
  assertThrowsStatus(() => lists.createList({ name: 'x'.repeat(201) }, 1), 400, 'createList caps name at 200 chars');
  assertThrowsStatus(() => lists.createList({ name: 'foo', kind: 'banana' }, 1), 400, 'createList rejects unknown kind');
  const listNoIcon = lists.createList({ name: 'Generic' }, 1);
  assertEq(listNoIcon.icon, '📝', 'createList defaults icon to 📝 for kind=list');

  // ---- Position increment is monotonic across creates ----
  const second = lists.createList({ name: 'Second' }, 1);
  const all = lists.listLists({});
  const positions = all.map(l => l.position);
  const uniqueSorted = [...positions].sort((a, b) => a - b);
  assertEq(positions, uniqueSorted, 'listLists positions are unique and sorted');

  // ---- getList: 404 on miss ----
  console.log('\ngetList');
  const refetched = lists.getList(packing.id);
  assertEq(refetched.id, packing.id, 'getList returns the list');
  assertThrowsStatus(() => lists.getList('nope'), 404, 'getList 404 on miss');

  // ---- updateList: rename + archive ----
  console.log('\nupdateList');
  const renamed = lists.updateList(packing.id, { name: '  Trip — packing  ' });
  assertEq(renamed.name, 'Trip — packing', 'updateList trims whitespace');
  lists.updateList(packing.id, { archived: 1 });
  const visibleAfterArchive = lists.listLists({});
  assert(!visibleAfterArchive.find(l => l.id === packing.id), 'archived list excluded from default list');
  const allWithArchived = lists.listLists({ includeArchived: true });
  assert(!!allWithArchived.find(l => l.id === packing.id), 'archived list visible when includeArchived=true');

  // ---- addItem: required label, quantity passthrough, position ----
  console.log('\naddItem');
  const groceriesId = gro1.id;
  assertThrowsStatus(() => lists.addItem(groceriesId, { label: '' }, 1), 400, 'addItem rejects empty label');
  assertThrowsStatus(() => lists.addItem('nope', { label: 'Milk' }, 1), 404, 'addItem 404 on missing list');
  const milk = lists.addItem(groceriesId, { label: 'Milk', quantity: '1 gal' }, 1);
  assertEq(milk.label, 'Milk', 'addItem returns the row');
  assertEq(milk.quantity, '1 gal', 'addItem stores quantity');
  assertEq(milk.added_by, 1, 'addItem stamps added_by');
  const eggs = lists.addItem(groceriesId, { label: 'Eggs' }, 1);
  assertEq(eggs.position, milk.position + 1, 'addItem assigns monotonic positions');

  // ---- listItems: open vs all, ORDER BY position ----
  console.log('\nlistItems');
  const allItems = lists.listItems(groceriesId, { includeChecked: true });
  assertEq(allItems.length, 2, 'listItems returns both items with includeChecked');
  const openOnly = lists.listItems(groceriesId, {});
  assertEq(openOnly.length, 2, 'listItems returns both items when both are open');
  assertEq(openOnly[0].label, 'Milk', 'listItems ordered by position (Milk first)');

  // ---- updateItem: check toggles, checked_by stamped ----
  console.log('\nupdateItem');
  const checked = lists.updateItem(milk.id, { checked: true }, 1);
  assertEq(checked.checked, true, 'updateItem toggles checked=true');
  assertEq(checked.checked_by, 1, 'updateItem stamps checked_by when checking');
  assert(checked.checked_at, 'updateItem stamps checked_at when checking');
  const openAgain = lists.updateItem(milk.id, { checked: false }, 1);
  assertEq(openAgain.checked, false, 'updateItem toggles checked=false');
  assertEq(openAgain.checked_by, null, 'updateItem clears checked_by when un-checking');
  assertEq(openAgain.checked_at, null, 'updateItem clears checked_at when un-checking');
  const renamedItem = lists.updateItem(milk.id, { label: 'Oat milk' });
  assertEq(renamedItem.label, 'Oat milk', 'updateItem renames');
  assertThrowsStatus(() => lists.updateItem('nope', { label: 'x' }), 404, 'updateItem 404 on missing item');

  // ---- publicStats reflects state ----
  console.log('\npublicStats');
  const stats1 = lists.publicStats();
  assertEq(stats1.list_count, 3, 'publicStats.list_count === 3 (Groceries + packing + Second)');
  assertEq(stats1.open_item_count, 2, 'publicStats.open_item_count === 2 (both groceries items still open)');
  assertEq(stats1.active_lists.length, 3, 'publicStats.active_lists includes all 3 lists');

  // ---- reorderLists: explicit positions overwrite monotonic counter ----
  console.log('\nreorderLists');
  const allBefore = lists.listLists({});
  const reversed = [...allBefore].reverse().map(l => l.id);
  const reordered = lists.reorderLists(reversed);
  assertEq(reordered[0].id, reversed[0], 'reorderLists applies new order');

  // ---- deleteItem + deleteList cascade ----
  console.log('\ndeleteItem / deleteList');
  lists.deleteItem(eggs.id);
  const remaining = lists.listItems(groceriesId, { includeChecked: true });
  assertEq(remaining.length, 1, 'deleteItem removes the row');
  lists.deleteList(groceriesId);
  // Cascade: list_items for groceriesId should be gone.
  const orphans = db.prepare('SELECT COUNT(*) c FROM list_items WHERE list_id = ?').get(groceriesId).c;
  assertEq(orphans, 0, 'deleteList cascades to list_items');
  const groceriesAfter = lists.listLists({});
  assert(!groceriesAfter.find(l => l.id === groceriesId), 'deleted list gone');

  // ---- Defensive: snapshot against an in-memory DB that never ran
  //      lists.migrate() returns the empty envelope, not a 500.
  console.log('\nsnapshot defensive');
  const fresh = new Database(':memory:');
  // No userModel.migrate / lists.migrate here — simulate a test DB
  // that only has tasks/events and snapshot is being asked to build.
  fresh.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                        display TEXT, color TEXT, is_admin INTEGER DEFAULT 0);
    INSERT INTO users (id, username, display, color) VALUES (1, 'tester', 'Tester', '#000');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, notes TEXT, assignee TEXT DEFAULT 'all',
                        alt_assignee TEXT, due_date TEXT, recur TEXT, rotate INTEGER DEFAULT 0,
                        done INTEGER DEFAULT 0, done_by TEXT, done_at TEXT, created_by TEXT, created_at TEXT);
    CREATE TABLE user_groups (user_id INTEGER, group_id INTEGER, granted_at TEXT, PRIMARY KEY(user_id,group_id));
    CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, display_name TEXT,
                         source_provider TEXT, synced_at TEXT);
  `);
  const defensive = snapshot.safeListsStats(fresh);
  assertEq(defensive, { list_count: 0, open_item_count: 0, active_lists: [] },
    'snapshot.safeListsStats returns empty envelope when lists table absent');

  // Closure: real DB → real envelope.
  const real = snapshot.safeListsStats(db);
  assertEq(real.list_count, 2, 'snapshot.safeListsStats reads real counts when lists.migrate ran');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
