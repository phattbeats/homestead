#!/usr/bin/env node
// PHA-1872 acceptance tests for the entity graph (Phase A: schema + read API).
//
// Follows the style of scripts/test-user-model.js / scripts/test-health-checker.js:
// plain node assert-style harness, no test framework. Schema/DB-level tests
// drive lib/sync/_schema.js directly against a temp SQLite file. API tests
// boot the real server.js app (DATA_DIR pointed at a temp dir) and hit it
// over real HTTP with fetch, using the header-trust auth path (matching how
// server.js already authenticates in production behind SWAG) so no cookie
// jar management is needed.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const entityGraph = require('../lib/sync/_schema');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-entgraph-test-'));
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
function insertEdge(db, { id, from_id, to_id, type, source_service, source_id = null, deep_link = null, meta = {}, created_by = 'manual', stale = 0 }) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT OR IGNORE INTO entity_edges
      (id, from_id, to_id, type, source_service, source_id, deep_link, meta_json, weight, created_by, created_at, updated_at, stale)
      VALUES (?,?,?,?,?,?,?,?,1.0,?,?,?,?)`)
    .run(id, from_id, to_id, type, source_service, source_id, deep_link, JSON.stringify(meta), created_by, now, now, stale);
}

// ---- boot a real server.js instance against a temp DATA_DIR ----
function bootServer(dataDir) {
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  delete require.cache[require.resolve('../server.js')];
  delete require.cache[require.resolve('../lib/user-model')];
  delete require.cache[require.resolve('../lib/health-checker')];
  delete require.cache[require.resolve('../lib/sync/_schema')];
  const app = require('../server.js');
  process.env.DATA_DIR = prevDataDir;
  return app;
}
function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
async function req(base, method, urlPath, body) {
  const r = await fetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-authentik-username': 'brandon',
      'x-authentik-groups': 'household',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* no body */ }
  return { status: r.status, body: json };
}

console.log('PHA-1872 entity-graph tests\n');

(async () => {

// ---- Test 1: schema migration idempotent ----
console.log('Test 1: schema migration idempotent (migrate twice, no error)');
{
  const { db, tmpDir } = freshDb();
  let threw = false;
  try { entityGraph.migrate(db); } catch (e) { threw = true; console.error(e); }
  assert(!threw, 'second migrate() call does not throw');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'entit%'`).all().map(t => t.name);
  assert(tables.includes('entities') && tables.includes('entity_edges') &&
         tables.includes('entity_aliases') && tables.includes('entity_review_queue'), 'all 4 tables present');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: entity_edges idempotent UNIQUE constraint ----
console.log('\nTest 2: entity_edges UNIQUE(from,to,type,source_service,source_id) is idempotent');
{
  const { db, tmpDir } = freshDb();
  insertEntity(db, { id: 'e1', kind: 'work', name: 'Dune', slug: 'dune-1' });
  insertEntity(db, { id: 'e2', kind: 'person', name: 'Frank Herbert', slug: 'frank-herbert' });
  insertEdge(db, { id: 'edge1', from_id: 'e1', to_id: 'e2', type: 'authored_by', source_service: 'kavita', source_id: 'series-1' });
  insertEdge(db, { id: 'edge2', from_id: 'e1', to_id: 'e2', type: 'authored_by', source_service: 'kavita', source_id: 'series-1' });
  const count = db.prepare('SELECT COUNT(*) c FROM entity_edges').get().c;
  assertEq(count, 1, 're-inserting the same (from,to,type,source_service,source_id) is a no-op');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Boot the API server for the remaining tests ----
const apiTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-entgraph-api-'));
const app = bootServer(apiTmpDir);
const server = await listen(app);
const base = `http://127.0.0.1:${server.address().port}`;
// Reach into the live db the server opened so we can seed fixtures directly.
const liveDb = new Database(path.join(apiTmpDir, 'life.db'));

try {

// ---- Test 3: entity CRUD via direct DB insert + GET routes ----
console.log('\nTest 3: entity CRUD — direct DB insert visible via GET /api/entities and /api/entities/:id');
{
  insertEntity(liveDb, { id: 'ent_dune_book', kind: 'work', name: 'Dune', slug: 'dune-book',
    meta: { isbn: '978-0-441-01359-3', deep_link: 'https://kavita.phatt.vip/series/1247' },
    source_service: 'kavita', source_id: 'series-1247', created_by: 'sync:kavita' });
  const list = await req(base, 'GET', '/api/entities?kind=work');
  assertEq(list.status, 200, 'GET /api/entities → 200');
  assert(list.body.items.some(e => e.id === 'ent_dune_book'), 'listed entity includes ent_dune_book');
  assertEq(list.body.total, 1, 'total=1');

  const one = await req(base, 'GET', '/api/entities/ent_dune_book');
  assertEq(one.status, 200, 'GET /api/entities/:id → 200');
  assertEq(one.body.kind, 'work', 'kind=work');
  assertEq(one.body.source.service, 'kavita', 'source.service=kavita');
  assertEq(one.body.deep_links.kavita, 'https://kavita.phatt.vip/series/1247', 'deep_links.kavita from own meta_json');
}

// ---- Test 4: 404 for missing entity id ----
console.log('\nTest 4: GET /api/entities/:id 404s for unknown id');
{
  const r = await req(base, 'GET', '/api/entities/does-not-exist');
  assertEq(r.status, 404, '404 status');
  assertEq(r.body, { error: 'not_found' }, 'matches {error:"not_found"} convention');
}

// ---- Test 5: edges direction filtering + grouping ----
console.log('\nTest 5: GET /api/entities/:id/edges direction filtering (out/in/both) + grouping');
{
  insertEntity(liveDb, { id: 'ent_frank_herbert', kind: 'person', name: 'Frank Herbert', slug: 'frank-herbert' });
  insertEntity(liveDb, { id: 'ent_dune_audiobook', kind: 'work', name: 'Dune', slug: 'dune-audiobook' });
  insertEdge(liveDb, { id: 'edge_authored', from_id: 'ent_dune_book', to_id: 'ent_frank_herbert', type: 'authored_by', source_service: 'kavita', source_id: 'series-1247' });
  insertEdge(liveDb, { id: 'edge_authored2', from_id: 'ent_dune_audiobook', to_id: 'ent_frank_herbert', type: 'authored_by', source_service: 'audiobookshelf', source_id: 'B0725G4QK8' });

  const out = await req(base, 'GET', '/api/entities/ent_dune_book/edges?direction=out');
  assertEq(out.body.edges.length, 1, 'out direction: 1 edge from ent_dune_book');
  assertEq(out.body.edges[0].to_id, 'ent_frank_herbert', 'out edge points to Frank Herbert');
  assert(Array.isArray(out.body.grouped.authored_by) && out.body.grouped.authored_by.length === 1, 'grouped by type=authored_by');

  const inbound = await req(base, 'GET', '/api/entities/ent_frank_herbert/edges?direction=in');
  assertEq(inbound.body.edges.length, 2, 'in direction: 2 edges into Frank Herbert (book + audiobook)');

  const both = await req(base, 'GET', '/api/entities/ent_frank_herbert/edges?direction=both');
  assert(both.body.edges.length >= 2, 'both direction includes at least the 2 inbound edges');
}

// ---- Test 6: backlinks only non-stale ----
console.log('\nTest 6: GET /api/entities/:id/backlinks only returns non-stale to_id matches');
{
  insertEntity(liveDb, { id: 'ent_concept_test', kind: 'concept', name: 'Test Concept', slug: 'test-concept' });
  insertEdge(liveDb, { id: 'edge_fresh', from_id: 'ent_dune_book', to_id: 'ent_concept_test', type: 'tagged_with', source_service: 'kavita', source_id: 'series-1247', stale: 0 });
  insertEdge(liveDb, { id: 'edge_stale', from_id: 'ent_dune_audiobook', to_id: 'ent_concept_test', type: 'tagged_with', source_service: 'audiobookshelf', source_id: 'stale-src', stale: 1 });

  const bl = await req(base, 'GET', '/api/entities/ent_concept_test/backlinks');
  assertEq(bl.body.edges.length, 1, 'only the non-stale backlink is returned');
  assertEq(bl.body.edges[0].from_id, 'ent_dune_book', 'stale backlink excluded');
  assert(bl.body.grouped.tagged_with && bl.body.grouped.tagged_with.length === 1, 'backlinks grouped by type');
}

// ---- Test 7: review-queue endpoints ----
console.log('\nTest 7: review-queue endpoints (global + per-entity)');
{
  liveDb.prepare(`INSERT INTO entity_review_queue (id, kind, candidate_a, candidate_b, confidence, reason, source_service, evidence_json, status, created_at)
      VALUES ('rq1','work','ent_dune_book','ent_dune_audiobook',0.75,'fuzzy title match','sibling_detector','{}','pending', ?)`)
    .run(new Date().toISOString());
  const global = await req(base, 'GET', '/api/review-queue?status=pending');
  assertEq(global.body.items.length, 1, 'global review-queue returns the pending item');
  const perEntity = await req(base, 'GET', '/api/entities/ent_dune_book/review-queue');
  assertEq(perEntity.body.items.length, 1, 'per-entity review-queue filters to candidate_a/candidate_b');
  const noneFor = await req(base, 'GET', '/api/entities/ent_frank_herbert/review-queue');
  assertEq(noneFor.body.items.length, 0, 'unrelated entity has no review-queue items');
}

// ---- Test 8: FTS5 search matches name and alias ----
console.log('\nTest 8: search matches on name and on alias');
{
  liveDb.prepare(`INSERT INTO entity_aliases (entity_id, alias, alias_lower, source) VALUES (?,?,?,?)`)
    .run('ent_dune_book', 'dune chronicles vol 1', 'dune chronicles vol 1', 'manual');
  const byName = await req(base, 'GET', '/api/entities/search?q=dune');
  assert(byName.body.hits.some(h => h.entity.id === 'ent_dune_book'), 'name-match finds ent_dune_book');
  const byAlias = await req(base, 'GET', '/api/entities/search?q=chronicles');
  assert(byAlias.body.hits.some(h => h.entity.id === 'ent_dune_book' && h.matched_alias === 'dune chronicles vol 1'),
    'alias-match finds ent_dune_book with matched_alias set');
}

} finally {
  liveDb.close();
  server.close();
  fs.rmSync(apiTmpDir, { recursive: true, force: true });
}

// ---- Test 9 & 10: full Dune walkthrough via seed-dune.js ----
console.log('\nTest 9: seed-dune.js is idempotent and populates the walkthrough graph');
{
  const seedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-entgraph-seed-'));
  const app2 = bootServer(seedTmpDir);
  const server2 = await listen(app2);
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  const { seed } = require('../scripts/seed-dune.js');
  const seedDb = new Database(path.join(seedTmpDir, 'life.db'));
  try {
    seed(seedDb);
    seed(seedDb); // run twice: idempotency
    const entityCount = seedDb.prepare('SELECT COUNT(*) c FROM entities').get().c;
    assertEq(entityCount, 6, 'seed-dune.js creates exactly 6 entities (idempotent on 2nd run)');
    const edgeCount = seedDb.prepare('SELECT COUNT(*) c FROM entity_edges').get().c;
    assertEq(edgeCount, 10, 'seed-dune.js creates exactly 10 edges (idempotent on 2nd run)');

    console.log('\nTest 10: full Dune walkthrough — concept entity page + search (design doc §11)');
    const concept = await req(base2, 'GET', '/api/entities/ent_concept_dune');
    assertEq(concept.status, 200, 'GET ent_concept_dune → 200');
    assertEq(concept.body.name, 'Dune franchise', 'concept name = "Dune franchise"');

    const edges = await req(base2, 'GET', '/api/entities/ent_concept_dune/edges?direction=out');
    const availableAs = edges.body.grouped.available_as || [];
    assertEq(availableAs.length, 3, 'concept has 3 available_as edges (book, audiobook, film)');
    const bySvc = Object.fromEntries(availableAs.map(e => [e.source_service, e.deep_link]));
    assertEq(bySvc.kavita, 'https://kavita.phatt.vip/series/1247', 'available_as deep_link for kavita is correct');
    assertEq(bySvc.audiobookshelf, 'https://audiobookshelf.phatt.vip/item/dune-B0725G4QK8', 'available_as deep_link for audiobookshelf is correct');
    assert(!!bySvc.plex, 'available_as deep_link for plex is present');
    // tagged_with edges point INTO the concept (work -> concept), so they
    // show up on the concept's backlinks, not its outgoing edges.
    const conceptBacklinks = await req(base2, 'GET', '/api/entities/ent_concept_dune/backlinks');
    const taggedWith = conceptBacklinks.body.grouped.tagged_with || [];
    assertEq(taggedWith.length, 3, 'concept has 3 incoming tagged_with backlinks (book, audiobook, film)');

    const searchDune = await req(base2, 'GET', '/api/entities/search?q=dune&limit=20');
    const ids = searchDune.body.hits.map(h => h.entity.id);
    for (const id of ['ent_dune_book', 'ent_dune_audiobook', 'ent_dune_film_1984', 'ent_concept_dune']) {
      assert(ids.includes(id), `search "dune" returns ${id}`);
    }
  } finally {
    seedDb.close();
    server2.close();
    fs.rmSync(seedTmpDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

})().catch(err => {
  console.error('test harness threw:', err);
  process.exit(2);
});
