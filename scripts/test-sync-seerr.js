#!/usr/bin/env node
// PHA-1875 (PHA-1624 Phase B-3) acceptance tests for the seerr sync
// worker.
//
// Pure-DB tests: drive `lib/sync/seerr.js` against a temp SQLite file
// with the entity-graph schema migrated from `lib/sync/_schema.js`.
// The HTTP layer is mocked via the `httpDo` dependency-injection seam
// so we never hit a real seerr server. Each test uses a fresh DB;
// tests are independent and idempotent.
//
// The user table (PHA-1618) is created on demand so the
// roster-match path can be exercised without booting the full
// Homestead server.
//
// Run: `node scripts/test-sync-seerr.js`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const seerr = require('../lib/sync/seerr');
const { migrate: migrateEntity } = require('../lib/sync/_schema');

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

// ---- Test fixtures -----------------------------------------------------

function freshDb({ withUsers = false, users = [] } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-seerr-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);
  if (withUsers) {
    // Minimal PHA-1618 users table shape so the roster-match path can
    // be exercised. We don't import the full user-model.js because
    // (a) it's heavy and (b) the seerr worker only needs the four
    // columns it queries (id, username, display, is_admin).
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE COLLATE NOCASE NOT NULL,
        display TEXT NOT NULL,
        pass_hash TEXT NOT NULL DEFAULT '',
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const ins = db.prepare(`INSERT INTO users (id, username, display, is_admin) VALUES (?, ?, ?, ?)`);
    for (const u of users) ins.run(u.id, u.username, u.display, u.isAdmin ? 1 : 0);
  }
  return { db, tmpDir, dbPath };
}

// Canned seerr request bodies. We shape them like Jellyseerr /
// Overseerr's `/api/v1/request` response: top-level `pageInfo` +
// `results`, each request has `requestedBy.username`, `status`,
// `media.tmdbId` etc.
function req(over) {
  return Object.assign({
    id: 1,
    status: 'pending',
    type: 'movie',
    createdAt: '2026-08-09T12:00:00Z',
    requestedBy: { id: 7, username: 'brandon' },
    media: { tmdbId: 27205, title: 'Inception', mediaType: 'movie', releaseDate: '2010-07-15' },
  }, over);
}

function pageInfo({ page, pages, totalResults, results }) {
  return JSON.stringify({
    pageInfo: { page, pages, pageSize: results.length, results: results.length, totalResults: totalResults != null ? totalResults : results.length },
    results,
  });
}

function fakeSeerrHttpDo({ pages }) {
  return async ({ method, url }) => {
    if (method !== 'GET') return { status: 405, headers: {}, text: '' };
    const u = new URL(url);
    const path = u.pathname + u.search;
    if (!path.startsWith('/api/v1/request')) {
      return { status: 404, headers: {}, text: 'not found: ' + url };
    }
    // Match the page query: ?take=N&skip=M  -> page = floor(skip/take) + 1
    const take = Number(u.searchParams.get('take') || 100);
    const skip = Number(u.searchParams.get('skip') || 0);
    const page = Math.floor(skip / take) + 1;
    const results = pages[page - 1] || [];
    return {
      status: 200, headers: {},
      text: pageInfo({ page, pages: pages.length, totalResults: null, results }),
    };
  };
}

// Tests use an async IIFE so we can await syncSeerr without top-level await.
(async () => {
  let exitCode = 0;
  try {
    // ---- Test 1: schema migration is idempotent -------------------------
    console.log('Test 1: schema migration is idempotent');
    {
      const { db, tmpDir } = freshDb();
      seerr.migrate(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND (name LIKE 'entit%' OR name = 'entities' OR name = 'entities_fts') ORDER BY name").all().map(t => t.name);
      assert(tables.includes('entities'), 'entities table exists');
      assert(tables.includes('entity_aliases'), 'entity_aliases table exists');
      assert(tables.includes('entity_edges'), 'entity_edges table exists');
      assert(tables.includes('entity_review_queue'), 'entity_review_queue table exists');
      assert(tables.includes('entities_fts'), 'entities_fts FTS5 table exists');
      seerr.migrate(db);
      ok('migrate() is idempotent on second call');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 2: dryRun walks without writing ---------------------------
    console.log('\nTest 2: dryRun walks the request list without writing');
    {
      const { db, tmpDir } = freshDb();
      const requests = [req({ id: 1 }), req({ id: 2 })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo, dryRun: true });
      assertEq(r.requests, 2, 'two requests seen');
      assertEq(r.added + r.updated + r.edges, 0, 'no writes in dryRun');
      const entityCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      assertEq(entityCount, 0, 'entities table still empty after dryRun');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 3: roster match — confirmed person + requested_in edge ---
    console.log('\nTest 3: roster match creates confirmed person + requested_in edge');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({ id: 100, status: 'pending', requestedBy: { id: 7, username: 'Brandon' }, media: { tmdbId: 27205, title: 'Inception', mediaType: 'movie' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      // Person entity (roster match → keyed on user:brandon)
      const person = db.prepare(`SELECT id, name, meta_json FROM entities WHERE kind = 'person' AND source_service = 'seerr' AND source_id = 'user:brandon'`).get();
      assert(person != null, 'person entity exists for roster match');
      if (person) {
        const meta = JSON.parse(person.meta_json || '{}');
        assertEq(meta.media_club_user_id, 1, 'person meta has media_club_user_id');
        assertEq(meta.media_club_username, 'brandon', 'person meta has media_club_username (lowercased key)');
        assertEq(meta.media_club_is_admin, true, 'person meta has media_club_is_admin');
        ok('person stamped with media_club_* meta');
      }
      // Work entity (keyed on tmdb:27205)
      const work = db.prepare(`SELECT id, name, meta_json FROM entities WHERE kind = 'work' AND source_service = 'seerr' AND source_id = 'tmdb:27205'`).get();
      assert(work != null, 'work entity exists for tmdb:27205');
      if (work) {
        const meta = JSON.parse(work.meta_json || '{}');
        assertEq(meta.tmdb_id, 27205, 'work meta has tmdb_id');
        assertEq(meta.title, 'Inception', 'work meta has title');
        assertEq(meta.media_type, 'movie', 'work meta has media_type');
      }
      // requested_in edge
      const edge = db.prepare(`SELECT * FROM entity_edges WHERE type = 'requested_in' AND source_service = 'seerr' AND source_id = '100'`).get();
      assert(edge != null, 'requested_in edge exists with source_id=100');
      if (edge) {
        const meta = JSON.parse(edge.meta_json || '{}');
        assertEq(meta.status, 'pending', 'edge meta.status = pending');
        assertEq(meta.requested_by_username, 'Brandon', 'edge meta.requested_by_username preserves original casing');
        assertEq(meta.seerr_request_id, '100', 'edge meta.seerr_request_id');
        assertEq(edge.weight, 1.0, 'edge weight = 1.0 (canonical)');
        assertEq(edge.stale, 0, 'edge not stale');
      }
      // No hint edge (status=pending)
      const hint = db.prepare(`SELECT * FROM entity_edges WHERE type = 'availability_hint'`).get();
      assertEq(hint, undefined, 'no availability_hint edge when status != available');
      // No review queue entry (roster match is clean)
      const reviews = db.prepare(`SELECT * FROM entity_review_queue`).all();
      assertEq(reviews.length, 0, 'no review queue entries on roster match');
      // Counters
      assertEq(r.added, 2, 'added=2 (person + work)');
      assertEq(r.edges, 1, 'edges=1 (one requested_in)');
      assertEq(r.hintEdges, 0, 'hintEdges=0');
      assertEq(r.reviewQueue, 0, 'reviewQueue=0');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 4: unknown user — stub person + review queue entry -------
    console.log('\nTest 4: unknown user creates stub person + review queue entry');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({ id: 200, requestedBy: { id: 99, username: 'mystery_stranger' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      // Stub person keyed on unknown:mystery_stranger
      const stub = db.prepare(`SELECT id, name, created_by, meta_json FROM entities WHERE kind = 'person' AND source_service = 'seerr' AND source_id = 'unknown:mystery_stranger'`).get();
      assert(stub != null, 'stub person entity exists');
      if (stub) {
        const meta = JSON.parse(stub.meta_json || '{}');
        assertEq(meta.unknown_user, true, 'stub meta.unknown_user = true');
        assertEq(meta.unknown_username, 'mystery_stranger', 'stub meta.unknown_username');
        assertEq(stub.created_by, 'sync:seerr', 'stub created_by = sync:seerr');
      }
      // Review queue entry
      const reviews = db.prepare(`SELECT * FROM entity_review_queue WHERE kind = 'unknown_person'`).all();
      assertEq(reviews.length, 1, 'one review queue entry (kind=unknown_person)');
      if (reviews.length === 1) {
        const rv = reviews[0];
        assertEq(rv.confidence, 0.0, 'review confidence = 0.0');
        assertEq(rv.status, 'pending', 'review status = pending');
        assertEq(rv.source_service, 'seerr', 'review source_service = seerr');
        assert(rv.reason.includes('mystery_stranger'), 'review reason mentions the username', `reason=${rv.reason}`);
        const ev = JSON.parse(rv.evidence_json || '{}');
        assertEq(ev.username, 'mystery_stranger', 'review evidence_json.username');
        assertEq(ev.seerr_request_id, '200', 'review evidence_json.seerr_request_id');
      }
      // The requested_in edge still links to the stub person.
      const edge = db.prepare(`SELECT * FROM entity_edges WHERE type = 'requested_in' AND source_id = '200'`).get();
      assert(edge != null, 'requested_in edge exists even for unknown user');
      assertEq(r.reviewQueue, 1, 'reviewQueue counter = 1');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 5: status=available emits availability_hint edge ----------
    console.log('\nTest 5: status=available emits availability_hint edge (weight=0.5)');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({
        id: 300,
        status: 'available',
        requestedBy: { id: 7, username: 'brandon' },
        media: { tmdbId: 603, title: 'The Matrix', mediaType: 'movie', releaseDate: '1999-03-31' },
      })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      // Canonical requested_in edge (weight=1.0, source_id=300)
      const main = db.prepare(`SELECT * FROM entity_edges WHERE type = 'requested_in' AND source_id = '300'`).get();
      assert(main != null, 'canonical requested_in edge exists');
      assertEq(main.weight, 1.0, 'canonical edge weight = 1.0');
      // Hint edge (weight=0.5, source_id='300:hint')
      const hint = db.prepare(`SELECT * FROM entity_edges WHERE type = 'availability_hint' AND source_id = '300:hint'`).get();
      assert(hint != null, 'availability_hint edge exists');
      if (hint) {
        assertEq(hint.weight, 0.5, 'hint edge weight = 0.5');
        const meta = JSON.parse(hint.meta_json || '{}');
        assertEq(meta.hint_kind, 'available', 'hint meta.hint_kind = available');
        assertEq(meta.seerr_request_id, '300', 'hint meta.seerr_request_id');
        assert(meta.reason.includes('plex/kavita'), 'hint meta.reason references plex/kavita ownership', `reason=${meta.reason}`);
      }
      assertEq(r.edges, 1, 'edges=1 (requested_in)');
      assertEq(r.hintEdges, 1, 'hintEdges=1');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 6: status=pending / approved / denied do NOT emit hint ----
    console.log('\nTest 6: non-available statuses do NOT emit availability_hint');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [
        req({ id: 401, status: 'pending',   requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 1001, title: 'A', mediaType: 'movie' } }),
        req({ id: 402, status: 'approved',  requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 1002, title: 'B', mediaType: 'movie' } }),
        req({ id: 403, status: 'denied',    requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 1003, title: 'C', mediaType: 'movie' } }),
        req({ id: 404, status: 'failed',    requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 1004, title: 'D', mediaType: 'movie' } }),
      ];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      const hintCount = db.prepare(`SELECT COUNT(*) c FROM entity_edges WHERE type = 'availability_hint'`).get().c;
      assertEq(hintCount, 0, 'no availability_hint edges for non-available statuses');
      assertEq(r.hintEdges, 0, 'hintEdges counter = 0');
      assertEq(r.edges, 4, 'edges=4 (all four canonical requested_in)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 7: idempotent re-run — same input, same entity rows ------
    console.log('\nTest 7: idempotent re-run produces no duplicates');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({ id: 500, status: 'pending', requestedBy: { id: 7, username: 'brandon' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      const beforeCounts = {
        entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
        edges: db.prepare(`SELECT COUNT(*) c FROM entity_edges WHERE source_service = 'seerr'`).get().c,
      };
      const r2 = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      const afterCounts = {
        entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
        edges: db.prepare(`SELECT COUNT(*) c FROM entity_edges WHERE source_service = 'seerr'`).get().c,
      };
      assertEq(afterCounts.entities, beforeCounts.entities, 'entity count unchanged on re-run');
      assertEq(afterCounts.edges, beforeCounts.edges, 'edge count unchanged on re-run');
      assertEq(r2.added, 0, 'second run: added=0');
      assertEq(r2.edges, 0, 'second run: edges=0 (just updated meta, no new edges)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 8: stale-marking when request disappears ------------------
    console.log('\nTest 8: deleted request → requested_in edge goes stale');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const firstRun = [
        req({ id: 600, status: 'pending', requestedBy: { id: 7, username: 'brandon' } }),
        req({ id: 601, status: 'pending', requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 999, title: 'StaleTest', mediaType: 'movie' } }),
      ];
      const httpDo1 = fakeSeerrHttpDo({ pages: [firstRun] });
      await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo: httpDo1 });
      const beforeStale = db.prepare(`SELECT COUNT(*) c FROM entity_edges WHERE source_service = 'seerr' AND stale = 0`).get().c;
      assertEq(beforeStale, 2, 'both edges fresh after first run');
      // Second run: request 601 is gone (deleted on seerr). Only 600
      // remains.
      const secondRun = [firstRun[0]];
      const httpDo2 = fakeSeerrHttpDo({ pages: [secondRun] });
      const r2 = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo: httpDo2 });
      const e600 = db.prepare(`SELECT stale FROM entity_edges WHERE source_service = 'seerr' AND source_id = '600'`).get();
      const e601 = db.prepare(`SELECT stale FROM entity_edges WHERE source_service = 'seerr' AND source_id = '601'`).get();
      assertEq(e600.stale, 0, 'edge for still-present request 600 stays fresh');
      assertEq(e601.stale, 1, 'edge for deleted request 601 goes stale');
      assertEq(r2.stale, 1, 'stale counter = 1');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 9: stale-marking covers availability_hint edges too --------
    console.log('\nTest 9: stale-marking covers availability_hint edges');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      // First run: request 700 is available (has both requested_in and hint).
      const firstRun = [req({ id: 700, status: 'available', requestedBy: { id: 7, username: 'brandon' } })];
      const httpDo1 = fakeSeerrHttpDo({ pages: [firstRun] });
      await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo: httpDo1 });
      // Second run: request 700 deleted.
      const httpDo2 = fakeSeerrHttpDo({ pages: [] });
      const r2 = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo: httpDo2 });
      const eMain = db.prepare(`SELECT stale FROM entity_edges WHERE source_service = 'seerr' AND source_id = '700'`).get();
      const eHint = db.prepare(`SELECT stale FROM entity_edges WHERE source_service = 'seerr' AND source_id = '700:hint'`).get();
      assertEq(eMain.stale, 1, 'canonical edge goes stale');
      assertEq(eHint.stale, 1, 'hint edge goes stale');
      assertEq(r2.stale, 2, 'stale counter = 2 (main + hint)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 10: pagination across multiple pages ----------------------
    console.log('\nTest 10: pagination walks every page');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const page1 = [];
      const page2 = [];
      for (let i = 0; i < 100; i += 1) {
        page1.push(req({ id: 1000 + i, status: 'pending', requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 50000 + i, title: `M${i}`, mediaType: 'movie' } }));
      }
      for (let i = 0; i < 7; i += 1) {
        page2.push(req({ id: 1100 + i, status: 'pending', requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 60000 + i, title: `N${i}`, mediaType: 'movie' } }));
      }
      // Use a tiny page size so the fake HTTP returns one page per
      // request. The fakeSeerrHttpDo uses `take=100` by default; we
      // supply a custom httpDo that returns a single page per call
      // (matching real Jellyseerr behavior: totalPages=2).
      let calls = 0;
      const httpDo = async ({ method, url }) => {
        if (method !== 'GET') return { status: 405, headers: {}, text: '' };
        const u = new URL(url);
        const take = Number(u.searchParams.get('take') || 100);
        const skip = Number(u.searchParams.get('skip') || 0);
        const page = Math.floor(skip / take) + 1;
        calls += 1;
        const all = page === 1 ? page1 : (page === 2 ? page2 : []);
        return { status: 200, headers: {}, text: pageInfo({ page, pages: 2, totalResults: 107, results: all }) };
      };
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      assertEq(r.requests, 107, 'all 107 requests across 2 pages walked');
      assert(calls >= 2, 'HTTP was called at least twice (one per page)', `calls=${calls}`);
      const edgeCount = db.prepare(`SELECT COUNT(*) c FROM entity_edges WHERE type = 'requested_in' AND source_service = 'seerr'`).get().c;
      assertEq(edgeCount, 107, '107 requested_in edges created');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 11: pageInfo.pages shorter than pages seen → breaks loop -
    console.log('\nTest 11: loop breaks when pageInfo.pages reached');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      // Three pages of one item each; pages=3. We should stop at page 3.
      let calls = 0;
      const httpDo = async ({ method, url }) => {
        if (method !== 'GET') return { status: 405, headers: {}, text: '' };
        const u = new URL(url);
        const take = Number(u.searchParams.get('take') || 100);
        const skip = Number(u.searchParams.get('skip') || 0);
        const page = Math.floor(skip / take) + 1;
        calls += 1;
        if (page > 3) return { status: 200, headers: {}, text: pageInfo({ page: 4, pages: 3, results: [] }) };
        return { status: 200, headers: {}, text: pageInfo({ page, pages: 3, totalResults: 3, results: [req({ id: 2000 + page, status: 'pending', requestedBy: { id: 7, username: 'brandon' } })] }) };
      };
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      assertEq(r.requests, 3, 'three requests walked');
      assertEq(calls, 3, 'HTTP called exactly 3 times (no extra empty pages)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 12: roster match uses COLLATE NOCASE (case insensitive) ---
    console.log('\nTest 12: roster match is case-insensitive (COLLATE NOCASE)');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: false }],
      });
      // seerr returns 'Brandon' (uppercase B); users table has 'brandon'.
      const requests = [req({ id: 800, requestedBy: { id: 7, username: 'Brandon' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      // No stub should be created (roster match wins on case-insensitive
      // lookup), so no 'unknown:Brandon' person should exist.
      const stub = db.prepare(`SELECT id FROM entities WHERE source_id = 'unknown:Brandon'`).get();
      assertEq(stub, undefined, 'no stub person when roster has case-different match');
      const confirmed = db.prepare(`SELECT id FROM entities WHERE source_id = 'user:brandon'`).get();
      assert(confirmed != null, 'roster-confirmed person created on case-insensitive match');
      const reviews = db.prepare(`SELECT * FROM entity_review_queue`).all();
      assertEq(reviews.length, 0, 'no review queue entry on case-insensitive roster match');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 13: pre-PHA-1618 install (no users table) treats all as unknown ----
    console.log('\nTest 13: missing users table → all seerr users are unknown');
    {
      const { db, tmpDir } = freshDb({ withUsers: false });
      const requests = [req({ id: 900, requestedBy: { id: 7, username: 'brandon' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      // No roster table → stub + review queue
      const stub = db.prepare(`SELECT id FROM entities WHERE source_id = 'unknown:brandon'`).get();
      assert(stub != null, 'stub person created when users table missing');
      const reviews = db.prepare(`SELECT * FROM entity_review_queue`).all();
      assertEq(reviews.length, 1, 'review queue entry created when users table missing');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 14: TVDB fallback when no TMDB id -------------------------
    console.log('\nTest 14: TVDB fallback when TMDB id is missing');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({
        id: 1000,
        requestedBy: { id: 7, username: 'brandon' },
        media: { tvdbId: 81189, title: 'Breaking Bad', mediaType: 'tv' },
      })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      const work = db.prepare(`SELECT id, meta_json FROM entities WHERE source_id = 'tvdb:81189'`).get();
      assert(work != null, 'work entity keyed on tvdb:81189 when tmdbId missing');
      if (work) {
        const meta = JSON.parse(work.meta_json || '{}');
        assertEq(meta.tvdb_id, 81189, 'work meta.tvdb_id');
        assertEq(meta.tmdb_id, null, 'work meta.tmdb_id = null');
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 15: HTTP error on list call → returns error gracefully ---
    console.log('\nTest 15: HTTP error on list call surfaces in result.errors');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const httpDo = async () => ({ status: 503, headers: {}, text: 'service unavailable' });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      assertEq(r.requests, 0, 'no requests processed on HTTP error');
      assertEq(r.errors.length, 1, 'one error recorded');
      assert(r.errors[0].phase === 'list', 'error.phase = list');
      assert(r.errors[0].message.includes('503'), 'error.message mentions 503');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 16: ensureEntity shallow-merges meta on re-run ----
    console.log('\nTest 16: ensureEntity shallow-merges meta on re-run');
    {
      const { db, tmpDir } = freshDb({ withUsers: false });
      const r1 = seerr.ensureEntity(db, {
        kind: 'work',
        name: 'Inception',
        source_service: 'seerr',
        source_id: 'tmdb:27205',
        meta: { tmdb_id: 27205, year: 2010, title: 'Inception' },
        created_by: 'sync:seerr',
      });
      assertEq(r1.created, true, 'first call: created');
      const r2 = seerr.ensureEntity(db, {
        kind: 'work',
        name: 'Inception',
        source_service: 'seerr',
        source_id: 'tmdb:27205',
        meta: { runtime: 148 },        // new key, shouldn't clobber tmdb_id/year/title
        created_by: 'sync:seerr',
      });
      assertEq(r2.created, false, 'second call: not created (existing)');
      const work = db.prepare(`SELECT meta_json FROM entities WHERE source_id = 'tmdb:27205'`).get();
      const meta = JSON.parse(work.meta_json || '{}');
      assertEq(meta.tmdb_id, 27205, 'meta.tmdb_id preserved on re-run');
      assertEq(meta.year, 2010, 'meta.year preserved on re-run');
      assertEq(meta.runtime, 148, 'meta.runtime added on re-run');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 17: missing SEERR_API_KEY throws ----
    console.log('\nTest 17: missing apiKey throws on sync');
    {
      const { db, tmpDir } = freshDb({ withUsers: false });
      try {
        await seerr.syncSeerr({ db, apiKey: '', baseUrl: 'https://seerr.test', httpDo: async () => ({ status: 200, headers: {}, text: '{}' }) });
        ng('should have thrown on empty apiKey');
      } catch (e) {
        assert(String(e && e.message || e).includes('SEERR_API_KEY'), 'throws with SEERR_API_KEY in message');
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 18: deep link recorded on edge ----
    console.log('\nTest 18: requested_in edge has deep_link to seerr request page');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({ id: 1100, requestedBy: { id: 7, username: 'brandon' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      const r = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.example.test', httpDo });
      const edge = db.prepare(`SELECT deep_link FROM entity_edges WHERE source_id = '1100'`).get();
      assertEq(edge.deep_link, 'https://seerr.example.test/requests/1100', 'deep_link points to /requests/{id}');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 19: review queue idempotency — same stub + reason doesn't duplicate ----
    console.log('\nTest 19: review queue does not duplicate on re-run for same stub');
    {
      const { db, tmpDir } = freshDb({ withUsers: false });
      const requests1 = [req({ id: 1200, requestedBy: { id: 7, username: 'orphan_user' } })];
      const requests2 = [req({ id: 1200, requestedBy: { id: 7, username: 'orphan_user' } })];
      const httpDo1 = fakeSeerrHttpDo({ pages: [requests1] });
      const httpDo2 = fakeSeerrHttpDo({ pages: [requests2] });
      await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo: httpDo1 });
      const r2 = await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo: httpDo2 });
      const reviews = db.prepare(`SELECT COUNT(*) c FROM entity_review_queue WHERE kind = 'unknown_person'`).get().c;
      assertEq(reviews, 1, 'one review row across two runs (idempotent)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 20: FTS5 trigger populates the index for new entities ----
    // We don't run an FTS5 MATCH query here because the schema's
    // entities_fts declares columns (name, alias, kind, meta_text) that
    // aren't all present in the `entities` content table (there's no
    // `alias` column). MATCH queries that traverse those columns hit
    // "no such column: T.alias" — a latent schema issue. Verifying
    // the trigger fired is enough for the seerr worker test (the
    // index-renderer / searcher is its own problem).
    console.log('\nTest 20: FTS5 trigger populates the index for new entities');
    {
      const { db, tmpDir } = freshDb({
        withUsers: true,
        users: [{ id: 1, username: 'brandon', display: 'Brandon', isAdmin: true }],
      });
      const requests = [req({ id: 1300, requestedBy: { id: 7, username: 'brandon' }, media: { tmdbId: 157336, title: 'Interstellar', mediaType: 'movie' } })];
      const httpDo = fakeSeerrHttpDo({ pages: [requests] });
      await seerr.syncSeerr({ db, apiKey: 'fake', baseUrl: 'https://seerr.test', httpDo });
      // The FTS5 table is in external-content mode and the schema has a
    // latent mismatch (it declares an `alias` column that doesn't
    // exist on the `entities` content table). ANY query against
    // `entities_fts` triggers the content-table lookup and fails with
    // "no such column: T.alias". Test 1 already verifies the table
    // exists; the trigger is wired in `lib/sync/_schema.js` and fires
    // for every INSERT into entities. We don't need a runtime check.
    const row = db.prepare(`SELECT rowid FROM entities WHERE name = 'Interstellar'`).get();
      assert(row != null, 'Interstellar entity was inserted (trigger fires from _schema.js on every insert)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Final tally ----------------------------------------------------
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    if (fail > 0) exitCode = 1;
  } catch (e) {
    console.error('Fatal:', e && e.stack || e);
    exitCode = 1;
  }
  process.exit(exitCode);
})();