#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2852 acceptance tests for lib/house-rooms.js and the additive
// `room_kinds` module-registry field.
//
// The three acceptance criteria from the issue, tested by name below:
//   1. A new user can create, rename, archive rooms.
//   2. Calendar events can be tagged room_id and filtered to
//      "events happening in HALL today".
//   3. Room data can be pulled with `room` joined as a column on the
//      listing (what the Gazette needs to print "6:00 — Blake call —
//      HALL" instead of inventing the location).
//
// Plus the two things the issue calls out as constraints rather than
// features: rooms are per-owner (no global registry), and the module
// gate is additive (existing 16-field manifests stay valid).

'use strict';

const Database = require('better-sqlite3');
const userModel = require('../lib/user-model');
const houseRooms = require('../lib/house-rooms');
const modules = require('../lib/modules');
const validator = require('../lib/registry-validate');

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

console.log('PHA-2852 house rooms tests\n');

const db = new Database(':memory:');
userModel.migrate(db);
houseRooms.migrate(db);

const alice = userModel.provisionOrClaim(db, 'alice', 'header_trust', 'alice', []);
const bob = userModel.provisionOrClaim(db, 'bob', 'header_trust', 'bob', []);

// ---- schema -------------------------------------------------------------
console.log('Schema');
{
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('house_rooms','house_room_members')"
  ).all().map(r => r.name).sort();
  assertEq(tables, ['house_room_members', 'house_rooms'], 'both tables created');

  const cols = db.prepare('PRAGMA table_info(house_rooms)').all().map(c => c.name);
  assertEq(cols, ['id', 'owner_user_id', 'slug', 'label', 'icon', 'ordering', 'archived_at', 'created_at'],
    'house_rooms columns match the issue spec exactly');

  const memberCols = db.prepare('PRAGMA table_info(house_room_members)').all();
  const roleCol = memberCols.find(c => c.name === 'room_role');
  assert(roleCol && /resident/.test(String(roleCol.dflt_value)), 'house_room_members.room_role defaults to resident');

  const eventCols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  assert(eventCols.includes('room_id'), 'events.room_id column added additively');

  // migrate() must be safe to re-run — it fires on every boot.
  houseRooms.migrate(db);
  ok('migrate() is idempotent on a second call');
}

// ---- acceptance 1: create / rename / archive -----------------------------
console.log('\nAcceptance 1: a new user can create, rename, archive rooms');
let hall;
{
  hall = houseRooms.createRoom(db, alice.id, { slug: 'hall', label: 'Hall', icon: '🚪' });
  assertEq(hall.slug, 'hall', 'create: room created with the requested slug');
  assertEq(hall.role, 'owner', 'create: creator is reported as owner');
  assertEq(hall.archived, false, 'create: new room is not archived');

  // Slug derived from the label when omitted.
  const porch = houseRooms.createRoom(db, alice.id, { label: 'Back Porch' });
  assertEq(porch.slug, 'back-porch', 'create: slug derived from label when omitted');
  assert(porch.ordering > hall.ordering, 'create: ordering auto-increments per owner');

  const renamed = houseRooms.updateRoom(db, alice.id, 'hall', { label: 'Front Hall' });
  assertEq(renamed.label, 'Front Hall', 'rename: label updated');
  assertEq(renamed.slug, 'hall', 'rename: slug is stable across a label rename');

  const archived = houseRooms.archiveRoom(db, alice.id, 'back-porch');
  assertEq(archived.archived, true, 'archive: soft-deleted via archived_at');
  assert(archived.archived_at, 'archive: archived_at is stamped');
  const active = houseRooms.listRooms(db, alice.id, {}).map(r => r.slug);
  assertEq(active, ['hall'], 'archive: archived room drops out of the default listing');
  const all = houseRooms.listRooms(db, alice.id, { includeArchived: true }).map(r => r.slug);
  assertEq(all.sort(), ['back-porch', 'hall'], 'archive: still visible with includeArchived');

  // Archiving is idempotent; the DELETE verb may be retried.
  const again = houseRooms.archiveRoom(db, alice.id, 'back-porch');
  assertEq(again.archived_at, archived.archived_at, 'archive: idempotent, timestamp not re-stamped');

  const restored = houseRooms.updateRoom(db, alice.id, 'back-porch', { archived: false });
  assertEq(restored.archived, false, 'un-archive: PATCH { archived: false } restores by slug');
  houseRooms.archiveRoom(db, alice.id, 'back-porch');
}

// ---- slug rules ---------------------------------------------------------
console.log('\nSlug rules');
{
  assertThrowsStatus(() => houseRooms.createRoom(db, alice.id, { slug: 'hall', label: 'Dup' }), 409,
    'duplicate active slug is 409, not a raw constraint 500');
  assertThrowsStatus(() => houseRooms.createRoom(db, alice.id, { slug: 'Hall', label: 'Caps' }), 400,
    'uppercase slug rejected');
  assertThrowsStatus(() => houseRooms.createRoom(db, alice.id, { slug: 'proposals', label: 'X' }), 400,
    'reserved slug "proposals" rejected (would be shadowed by the literal route)');
  assertThrowsStatus(() => houseRooms.createRoom(db, alice.id, { label: '   ' }), 400,
    'blank label rejected');
  assertThrowsStatus(() => houseRooms.createRoom(db, alice.id, { label: 'x'.repeat(61) }), 400,
    'over-long label rejected');

  // The partial unique index is what allows this: 'back-porch' is
  // archived, so the slug is free again.
  const reused = houseRooms.createRoom(db, alice.id, { slug: 'back-porch', label: 'Back Porch II' });
  assertEq(reused.label, 'Back Porch II', 'archived slug can be reused by a new room');
  const bothPorches = houseRooms.listRooms(db, alice.id, { includeArchived: true })
    .filter(r => r.slug === 'back-porch').length;
  assertEq(bothPorches, 2, 'both the archived and the new room survive on the same slug');
  // …and the active one is what a bare slug resolves to.
  assertEq(houseRooms.getRoom(db, alice.id, 'back-porch').label, 'Back Porch II',
    'slug resolution prefers the active room over the archived one');
  houseRooms.archiveRoom(db, alice.id, houseRooms.getRoom(db, alice.id, 'back-porch').id);
}

// ---- per-owner isolation (no global room registry) ----------------------
console.log('\nPer-owner isolation: each user owns their rooms independently');
{
  const bobHall = houseRooms.createRoom(db, bob.id, { slug: 'hall', label: 'Hall' });
  assert(bobHall.id !== hall.id, 'two users can each own a room with the same slug');
  assertEq(houseRooms.listRooms(db, bob.id, {}).map(r => r.slug), ['hall'],
    'bob sees only his own room');
  assertEq(houseRooms.resolveRoom(db, bob.id, hall.id), null,
    "another user's room id does not resolve (404, not 403 — no slug enumeration)");
  assertThrowsStatus(() => houseRooms.updateRoom(db, bob.id, hall.id, { label: 'Hijacked' }), 404,
    "cannot rename another user's room");
  assertEq(houseRooms.getRoom(db, alice.id, 'hall').label, 'Front Hall',
    "alice's room is untouched by bob's attempt");
}

// ---- members: owner manages, members read -------------------------------
console.log('\nMembers: owner manages, members read');
{
  const members = houseRooms.addMember(db, alice.id, 'hall', { username: 'bob' });
  assertEq(members.map(m => m.username), ['alice', 'bob'], 'owner row is listed first, then the resident');
  assertEq(members.find(m => m.username === 'bob').room_role, 'resident',
    'room_role defaults to resident');

  assertEq(houseRooms.getRoom(db, bob.id, hall.id).role, 'resident',
    'member can READ the room they were added to');
  assert(houseRooms.listRooms(db, bob.id, {}).some(r => r.id === hall.id),
    "member sees the room in their own listing");
  assertThrowsStatus(() => houseRooms.updateRoom(db, bob.id, hall.id, { label: 'Nope' }), 403,
    'member cannot WRITE — 403 not_room_owner (they can see it, so 404 would be a lie)');
  assertThrowsStatus(() => houseRooms.addMember(db, bob.id, hall.id, { username: 'alice' }), 403,
    'member cannot manage membership');

  assertThrowsStatus(() => houseRooms.removeMember(db, alice.id, 'hall', alice.id), 400,
    "owner's own member row cannot be removed");
  assertThrowsStatus(() => houseRooms.addMember(db, alice.id, 'hall', { username: 'nobody' }), 404,
    'adding an unknown user is 404');
  assertThrowsStatus(() => houseRooms.addMember(db, alice.id, 'hall', { username: 'bob', room_role: 'landlord' }), 400,
    'unknown room_role rejected');
  assertThrowsStatus(() => houseRooms.addMember(db, alice.id, 'hall', { username: 'bob', room_role: 'owner' }), 400,
    "'owner' is not assignable to a non-owner (ownership transfer is not this endpoint)");

  // Re-adding is an upsert, not a duplicate-key 500.
  const again = houseRooms.addMember(db, alice.id, 'hall', { username: 'bob' });
  assertEq(again.length, 2, 'adding an existing member is an idempotent upsert');

  const after = houseRooms.removeMember(db, alice.id, 'hall', bob.id);
  assertEq(after.map(m => m.username), ['alice'], 'owner can remove a resident');
  assertThrowsStatus(() => houseRooms.getRoom(db, bob.id, hall.id), 404,
    'removed member loses read access');
}

// ---- first-run proposals ------------------------------------------------
console.log('\nSeed: first-run proposals (accept-all-or-edit-and-accept)');
{
  assertEq(houseRooms.DEFAULT_ROOM_PROPOSALS.map(p => p.slug), ['hall', 'den', 'kitchen'],
    'DEFAULT_ROOM_PROPOSALS is [hall, den, kitchen] as specified');

  // A brand-new user with zero rooms: nothing is written until they accept.
  const carol = userModel.provisionOrClaim(db, 'carol', 'header_trust', 'carol', []);
  const before = houseRooms.listProposals(db, carol.id);
  assertEq(before.room_count, 0, 'proposals do not write anything on read');
  assertEq(before.pending.length, 3, 'all three stubs pending for a new user');

  const accepted = houseRooms.acceptProposals(db, carol.id, undefined);
  assertEq(accepted.created.map(r => r.slug), ['hall', 'den', 'kitchen'],
    'accept-all creates all three in proposal order');
  assertEq(accepted.skipped, [], 'accept-all skips nothing on a fresh account');

  // Re-running the tutorial must not 409 — it reports skips instead.
  const rerun = houseRooms.acceptProposals(db, carol.id, undefined);
  assertEq(rerun.created, [], 're-accepting creates nothing');
  assertEq(rerun.skipped, ['hall', 'den', 'kitchen'], 're-accepting reports all three as skipped');

  // Edit-and-accept: a user renames the stubs before accepting.
  const dave = userModel.provisionOrClaim(db, 'dave', 'header_trust', 'dave', []);
  const edited = houseRooms.acceptProposals(db, dave.id, [
    { slug: 'hall', label: 'Entryway' },
    { label: 'Game Room' },
  ]);
  assertEq(edited.created.map(r => [r.slug, r.label]), [['hall', 'Entryway'], ['game-room', 'Game Room']],
    'edit-and-accept honors both a relabeled stub and a wholly new room');
  assertEq(houseRooms.listProposals(db, dave.id).pending.map(p => p.slug), ['den', 'kitchen'],
    'a partially-accepted tutorial still offers the untouched stubs');

  assertThrowsStatus(() => houseRooms.acceptProposals(db, dave.id, 'hall'), 400,
    'non-array rooms payload rejected');
  assertThrowsStatus(() => houseRooms.acceptProposals(db, dave.id, [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }]), 400,
    'more rooms than proposals rejected — this is the tutorial, not bulk import');
}

// ---- acceptance 2 + 3: room-tagged, room-filtered, room-joined events ----
console.log('\nAcceptance 2/3: events tagged to a room, filtered and joined');
{
  const den = houseRooms.createRoom(db, alice.id, { slug: 'den', label: 'Den' });
  const insert = db.prepare(
    'INSERT INTO events (title,date,time,notes,owner,created_by,room_id) VALUES (?,?,?,?,?,?,?)'
  );
  insert.run('Blake call', '2026-08-30', '06:00', '', 'all', 'alice', hall.id);
  insert.run('Movie night', '2026-08-30', '20:00', '', 'all', 'alice', den.id);
  insert.run('Trash out', '2026-08-31', '07:00', '', 'all', 'alice', hall.id);
  insert.run('Untagged', '2026-08-30', '09:00', '', 'all', 'alice', null);

  // "events happening in HALL today"
  const today = houseRooms.listEventsInRoom(db, alice.id, 'hall', { from: '2026-08-30', to: '2026-08-30' });
  assertEq(today.map(e => e.title), ['Blake call'], 'filters to events in HALL on one day');
  assertEq(today[0].room_label, 'Front Hall', 'room joined on as a column (room_label)');
  assertEq(today[0].room_slug, 'hall', 'room joined on as a column (room_slug)');

  const allHall = houseRooms.listEventsInRoom(db, alice.id, 'hall', {});
  assertEq(allHall.map(e => e.title), ['Blake call', 'Trash out'], 'unbounded room query returns the room\'s events in date order');

  // Tagging validation on write.
  assertEq(houseRooms.resolveRoomIdForWrite(db, alice.id, 'hall'), hall.id,
    'write path resolves a slug to a room id');
  assertEq(houseRooms.resolveRoomIdForWrite(db, alice.id, null), null,
    'write path treats null as an explicit clear');
  assertThrowsStatus(() => houseRooms.resolveRoomIdForWrite(db, alice.id, 'nowhere'), 404,
    'tagging an unknown room is 404');
  assertThrowsStatus(() => houseRooms.resolveRoomIdForWrite(db, bob.id, hall.id), 404,
    "tagging another user's room is 404");

  // An archived room stays taggable/queryable — history, not an error.
  houseRooms.archiveRoom(db, alice.id, 'den');
  assertEq(houseRooms.listEventsInRoom(db, alice.id, 'den', {}).map(e => e.title), ['Movie night'],
    'events in an archived room are still readable');
  houseRooms.updateRoom(db, alice.id, 'den', { archived: false });

  // joinRoomColumns decorates a plain listing, and refuses to leak
  // labels of rooms the caller cannot see.
  const rows = db.prepare('SELECT * FROM events WHERE date = ? ORDER BY time').all('2026-08-30');
  const forAlice = houseRooms.joinRoomColumns(db, alice.id, rows);
  assertEq(forAlice.map(e => e.room_label), ['Front Hall', null, 'Den'],
    'joinRoomColumns decorates tagged rows and leaves untagged ones null');
  const forBob = houseRooms.joinRoomColumns(db, bob.id, rows);
  assertEq(forBob.map(e => e.room_label), [null, null, null],
    "joinRoomColumns does not leak another user's room labels");
  assertEq(houseRooms.joinRoomColumns(db, alice.id, []), [], 'joinRoomColumns tolerates an empty listing');
}

// ---- module gate: additive room_kinds -----------------------------------
console.log('\nModule gate: room_kinds is additive');
{
  assertEq(validator.REQUIRED_FIELDS.length, 16,
    'REQUIRED_FIELDS is still exactly 16 — the PHA-2201 contract is unbroken');
  assert(!validator.REQUIRED_FIELDS.includes('room_kinds'), 'room_kinds is not a required field');

  assertEq(modules.getRoomKinds('calendar'), ['house_room'], 'calendar declares house_room');
  assertEq(modules.getRoomKinds('chores'), ['house_room'], 'chores declares house_room');
  assertEq(modules.getRoomKinds('lists'), ['house_room'], 'lists declares house_room');
  assertEq(modules.getRoomKinds('wall'), [], 'a module without the field reports no room kinds');
  assertEq(modules.getRoomKinds('nope'), [], 'unknown key reports no room kinds');
  assertEq(modules.modulesForRoomKind('house_room'), ['lists', 'calendar', 'chores'],
    'reverse lookup returns declaring modules in registry order');

  // The live registry still validates, and a pre-PHA-2852 manifest
  // (16 fields, no room_kinds) is still a valid entry.
  assertEq(validator.validateRegistry(null), null, 'live registry passes validation with the new field');
  const legacy = {
    key: 'legacy_app', name: 'Legacy', description: 'Pre-2852 manifest.', icon: '📦',
    room: null, requires: [], tier: 'advanced', version: '1.0.0', author: 'third-party',
    url: 'https://legacy.example.com/manifest', open_mode: 'tab', scopes: [], mcp: false,
    webhooks: [], entity_kinds: [], default_enabled: false,
  };
  assertEq(validator.validateEntryShape(legacy), null, 'a 16-field manifest with no room_kinds still validates');

  const badKind = { ...legacy, room_kinds: ['house-room'] };
  assert(validator.validateEntryShape(badKind) instanceof Error,
    'a typo\'d room kind is rejected rather than silently ignored');
  const badType = { ...legacy, room_kinds: 'house_room' };
  assert(validator.validateEntryShape(badType) instanceof Error,
    'room_kinds must be an array when present');
  assertEq(validator.validateEntryShape({ ...legacy, room_kinds: [] }), null,
    'an explicit empty room_kinds is valid');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
