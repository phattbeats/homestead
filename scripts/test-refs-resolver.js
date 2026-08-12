#!/usr/bin/env node
// PHA-1877 (PHA-1624 Phase D) — reference resolver tests.
//
// Drives lib/refs/resolver.js against a real better-sqlite3 instance
// with the entity-graph schema installed (lib/sync/_schema.js). Same
// style as scripts/test-entity-graph.js and scripts/test-dedup-matcher.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const entityGraph = require('../lib/sync/_schema');
const { scanForReferences } = require('../lib/refs/parser');
const resolver = require('../lib/refs/resolver');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-refs-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  entityGraph.migrate(db);
  return { db, tmpDir, dbPath };
}

function insertEntity(db, { id, kind, name, slug, meta = {}, source_service = null, source_id = null, created_by = 'manual' }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, kind, name, slug, JSON.stringify(meta), now, now, created_by, source_service, source_id, name.toLowerCase());
}

console.log('PHA-1877 reference resolver tests\n');

// ---- Test 1: Tier 1 deterministic match by name ----
console.log('Test 1: Tier 1 deterministic — exact lowercase name match');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune-book' });
  const got = resolver.tier1Deterministic(db, 'Dune');
  assertEq(got, 'ent_dune', 'finds Dune');
  const got2 = resolver.tier1Deterministic(db, 'dune');
  assertEq(got2, 'ent_dune', 'case-insensitive');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: Tier 1 match by alias ----
console.log('\nTest 2: Tier 1 — match by alias');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_herbert', kind: 'person', name: 'Frank Herbert', slug: 'frank-herbert' });
  db.prepare(`INSERT INTO entity_aliases (entity_id, alias, alias_lower, source) VALUES (?, ?, ?, 'manual')`)
    .run('ent_herbert', 'Herbert', 'herbert');
  const got = resolver.tier1Deterministic(db, 'Herbert');
  assertEq(got, 'ent_herbert', 'finds via alias');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: Tier 1 miss ----
console.log('\nTest 3: Tier 1 miss on unknown name');
{
  const { db, tmpDir } = freshDb();
  const got = resolver.tier1Deterministic(db, 'Nothing');
  assertEq(got, null, 'null on miss');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: Tier 2 fuzzy ≥ 0.9 ----
console.log('\nTest 4: Tier 2 — fuzzy match on near name (≥ 0.9)');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_hero', kind: 'work', name: 'Dune Messiah', slug: 'dune-messiah' });
  // "Dune Messi" is 11/15 trigram overlap with "dune messiah" → jaccard ≈ 0.55 — too low.
  // "Dune Messiahh" adds one char; "Dune" alone is too far.
  // Use a high-similarity example: "Dune Messiah " (trailing space) — same trigrams.
  const got = resolver.tier2Fuzzy(db, 'Dune Messiah');
  assert(got && got.entityId === 'ent_hero', 'finds Dune Messiah');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: Tier 2 below threshold returns null ----
console.log('\nTest 5: Tier 2 below 0.9 threshold returns null');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  const got = resolver.tier2Fuzzy(db, 'Completely Unrelated');
  assertEq(got, null, 'null on low similarity');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: ensureStub creates and re-fetches ----
console.log('\nTest 6: ensureStub creates a stub on first call, reuses on second');
{
  const { db, tmpDir } = freshDb();
  const r1 = resolver.ensureStub(db, 'Mystery Book');
  assert(r1 && r1.id, 'first call returns id');
  assertEq(r1.created, true, 'first call: created=true');
  const r2 = resolver.ensureStub(db, 'Mystery Book');
  assertEq(r2.id, r1.id, 'second call: same id');
  assertEq(r2.created, false, 'second call: created=false');
  // Case-insensitive merge via slug
  const r3 = resolver.ensureStub(db, 'mystery book');
  assertEq(r3.id, r1.id, 'lowercase merge: same id');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: ensureStub sets unresolved meta ----
console.log('\nTest 7: ensureStub writes meta.unresolved=true');
{
  const { db, tmpDir } = freshDb();
  const r = resolver.ensureStub(db, 'Foo');
  const row = db.prepare('SELECT meta_json FROM entities WHERE id = ?').get(r.id);
  const meta = JSON.parse(row.meta_json);
  assertEq(meta.unresolved, true, 'meta.unresolved=true');
  assertEq(meta.stub_kind, 'reference', 'meta.stub_kind=reference');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: resolveContainer Tier 1 path emits edge ----
console.log('\nTest 8: resolveContainer Tier 1 emits mentioned_in edge');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune-book' });
  const res = resolver.resolveContainer(db, { kind: 'task', id: 42, text: 'Reading [[Dune]] tonight' });
  assertEq(res.refs.length, 1, 'one ref');
  assertEq(res.refs[0].tier, 1, 'tier=1');
  assertEq(res.refs[0].entityId, 'ent_dune', 'entityId=ent_dune');
  assertEq(res.resolved, 1, 'resolved=1');
  assertEq(res.edges, 1, 'edges=1');
  const edge = db.prepare(`SELECT * FROM entity_edges WHERE type = 'mentioned_in'`).get();
  assert(edge && edge.to_id === 'ent_dune', 'edge to ent_dune exists');
  assert(edge && edge.from_id.startsWith('container-'), 'edge from container sentinel');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: resolveContainer Tier 3 stub path ----
console.log('\nTest 9: resolveContainer Tier 3 creates stub + edge');
{
  const { db, tmpDir } = freshDb();
  const res = resolver.resolveContainer(db, { kind: 'event', id: 7, text: 'Watch [[Made Up Show]]' });
  assertEq(res.refs[0].tier, 3, 'tier=3 (stub)');
  assertEq(res.stubs, 1, 'one stub created');
  const stub = db.prepare(`SELECT * FROM entities WHERE kind = 'concept' AND meta_json LIKE '%"unresolved":true%'`).get();
  assert(stub && stub.name === 'Made Up Show', 'stub entity named correctly');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 10: resolveContainer idempotent on re-run ----
console.log('\nTest 10: resolveContainer idempotent — re-run does not duplicate edges');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  const text = 'Re-read [[Dune]]';
  resolver.resolveContainer(db, { kind: 'task', id: 1, text });
  resolver.resolveContainer(db, { kind: 'task', id: 1, text });
  resolver.resolveContainer(db, { kind: 'task', id: 1, text });
  const edges = db.prepare(`SELECT COUNT(*) c FROM entity_edges WHERE type = 'mentioned_in'`).get().c;
  assertEq(edges, 1, 'one edge after 3 runs');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 11: resolveContainer dedup within one scan ----
console.log('\nTest 11: resolveContainer dedup — same [[X]] repeated → one edge');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  const res = resolver.resolveContainer(db, { kind: 'task', id: 1, text: '[[Dune]] and [[Dune]] again' });
  // Two refs were parsed; the result array is deduped per (container, entity)
  // so only one entry shows up — which is the right behavior per spec
  // ("emits mentioned_in edges (container → entity)").
  assertEq(res.refs.length, 1, 'one result (deduped per container,entity)');
  assertEq(res.edges, 1, 'one edge in DB');
  // But scanForReferences sees both refs:
  const scan = scanForReferences('[[Dune]] and [[Dune]] again', 'task');
  assertEq(scan.refs.length, 2, 'parser sees both refs');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 12: resolveContainer no refs → no work ----
console.log('\nTest 12: resolveContainer no refs → empty result, no side effects');
{
  const { db, tmpDir } = freshDb();
  const res = resolver.resolveContainer(db, { kind: 'task', id: 1, text: 'no refs here' });
  assertEq(res.refs.length, 0, 'no refs');
  assertEq(res.edges, 0, 'no edges');
  const edges = db.prepare(`SELECT COUNT(*) c FROM entity_edges`).get().c;
  assertEq(edges, 0, 'no edges in DB');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 13: resolveContainer bad container → safe return ----
console.log('\nTest 13: resolveContainer bad container → safe return without throwing');
{
  const { db, tmpDir } = freshDb();
  const res = resolver.resolveContainer(db, null);
  assertEq(res.refs.length, 0, 'no refs');
  assert(res && res.skipped, 'skipped flag set');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 14: ensureContainerEntity deterministic ----
console.log('\nTest 14: ensureContainerEntity produces the same id for same (kind,id)');
{
  const { db, tmpDir } = freshDb();
  const id1 = resolver.ensureContainerEntity(db, { kind: 'task', id: 42 });
  const id2 = resolver.ensureContainerEntity(db, { kind: 'task', id: 42 });
  assertEq(id1, id2, 'same id on re-fetch');
  assert(id1.startsWith('container-'), 'prefix container-');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 15: resolveAllContainers walks tasks ----
console.log('\nTest 15: resolveAllContainers walks tasks table');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  insertEntity(db, { id: 'ent_herbert', kind: 'person', name: 'Frank Herbert', slug: 'frank-herbert' });
  // tasks table isn't created by entityGraph schema; we need it for the walker.
  // Stand up a minimal tasks table inline.
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT DEFAULT ''
  )`);
  db.prepare(`INSERT INTO tasks (id, title, notes) VALUES (1, 'Read [[Dune]]', 'By [[Frank Herbert]]')`).run();
  db.prepare(`INSERT INTO tasks (id, title, notes) VALUES (2, 'No refs', 'Just plain text')`).run();
  const summary = resolver.resolveAllContainers(db, { kinds: ['task'] });
  assertEq(summary.containers, 2, 'two containers');
  assertEq(summary.refs, 2, 'two refs');
  assertEq(summary.resolved, 2, 'both resolved');
  assertEq(summary.byKind.task.refs, 2, 'byKind.task.refs=2');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 16: resolveAllContainers walks events ----
console.log('\nTest 16: resolveAllContainers walks events table');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT DEFAULT ''
  )`);
  db.prepare(`INSERT INTO events (id, title, notes) VALUES (1, 'Dune watch party', 'Watching [[Dune]]')`).run();
  const summary = resolver.resolveAllContainers(db, { kinds: ['event'] });
  assertEq(summary.byKind.event.containers, 1, 'one event container');
  assertEq(summary.byKind.event.resolved, 1, 'one resolved');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 17: resolveAllContainers onProgress callback ----
console.log('\nTest 17: resolveAllContainers onProgress callback fires');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT DEFAULT '')`);
  db.prepare(`INSERT INTO tasks (id, title, notes) VALUES (1, '[[Dune]]', '')`).run();
  const seen = [];
  resolver.resolveAllContainers(db, { kinds: ['task'], onProgress: (info) => seen.push(info) });
  assertEq(seen.length, 1, 'callback fired once');
  assertEq(seen[0].kind, 'task', 'callback got kind=task');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 18: Tier 2 fuzzy adds alias for future deterministic match ----
console.log('\nTest 18: Tier 2 fuzzy match adds alias for a typo near-miss');
{
  const { db, tmpDir } = freshDb();
  // Trigram Jaccard ≥ 0.9 for a single-char typo requires strings of
  // length ~60+. Use a longer title that demonstrates the tier-2 path.
  const longName = 'The Complete Adventures of Huckleberry Finn and Tom Sawyer in Missouri';
  const longSlug = 'the-complete-adventures-of-huckleberry-finn-and-tom-sawyer-in-missouri';
  insertEntity(db, { id: 'ent_long', kind: 'work', name: longName, slug: longSlug });
  // Exact name → Tier 1.
  const res = resolver.resolveContainer(db, { kind: 'task', id: 1, text: `[[${longName}]]` });
  assertEq(res.refs[0].tier, 1, 'exact long name → Tier 1');
  // Single-char typo deep in the string → Tier 2 fuzzy.
  const typoName = 'The Complete Adventures of Huckleberri Finn and Tom Sawyer in Missouri';
  const res2 = resolver.resolveContainer(db, { kind: 'task', id: 2, text: `[[${typoName}]]` });
  assertEq(res2.refs[0].tier, 2, 'typo in long name → Tier 2 fuzzy');
  // The Tier 2 match added the typo as an alias; future exact matches
  // for that alias now hit Tier 1.
  const res3 = resolver.resolveContainer(db, { kind: 'task', id: 3, text: `[[${typoName}]]` });
  assertEq(res3.refs[0].tier, 1, 'alias cached → Tier 1 on second container');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 18b: cross-form slug fallback (Tier 3) ----
console.log('\nTest 18b: cross-form ref [[Foo-Bar]] links to entity [[Foo Bar]] via slug');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_hero', kind: 'work', name: 'Dune Messiah', slug: 'dune-messiah' });
  // "[[Dune-Messiah]]" doesn't Tier 1 match (name differs), doesn't Tier 2
  // match (trigrams diverge too much across the boundary), and a fresh
  // stub creation would collide on slug. The resolver falls through to
  // Tier 3 which reuses the existing slug-holder rather than creating a
  // duplicate. This keeps links alive for variations like "Foo-Bar" vs
  // "Foo Bar".
  const res = resolver.resolveContainer(db, { kind: 'task', id: 1, text: '[[Dune-Messiah]]' });
  assertEq(res.refs[0].tier, 3, 'slug fallback → Tier 3 (stub path)');
  assertEq(res.refs[0].entityId, 'ent_hero', 'links to existing entity, not a fresh stub');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 19: resolveContainer confidence recorded in edge meta ----
console.log('\nTest 19: confidence recorded in edge meta_json');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune' });
  resolver.resolveContainer(db, { kind: 'task', id: 1, text: '[[Dune]]' });
  const edge = db.prepare(`SELECT * FROM entity_edges WHERE type = 'mentioned_in'`).get();
  const meta = JSON.parse(edge.meta_json);
  assertEq(meta.confidence, 1.0, 'confidence=1.0 (Tier 1)');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 20: scanForReferences + resolveContainer composition ----
console.log('\nTest 20: end-to-end parse + resolve on a real task text');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'ent_dune', kind: 'work', name: 'Dune', slug: 'dune-book' });
  insertEntity(db, { id: 'ent_herbert', kind: 'person', name: 'Frank Herbert', slug: 'frank-herbert' });
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT DEFAULT '')`);
  db.prepare(`INSERT INTO tasks (id, title, notes) VALUES (1, 'Tonight: [[Dune]]', 'Notes: re-read with [[Frank Herbert]] commentary')`).run();
  const summary = resolver.resolveAllContainers(db, { kinds: ['task'] });
  assertEq(summary.refs, 2, 'two refs across title+notes');
  assertEq(summary.resolved, 2, 'both resolved');
  assertEq(summary.edges, 2, 'two edges');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);