#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1874 (PHA-1624 Phase B-2) acceptance tests for the Kavita sync worker.
//
// Pure-DB tests: drive `lib/sync/kavita.js` against a temp SQLite file
// with the entity-graph schema migrated from `lib/sync/_schema.js`. The
// HTTP layer is mocked via the `httpDo` dependency-injection seam so we
// never hit a real Kavita server. Each test uses a fresh DB; tests are
// independent and idempotent.
//
// Run: `node scripts/test-sync-kavita.js`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const kavita = require('../lib/sync/kavita');
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

// Test fixtures ----------------------------------------------------------

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-kavita-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);
  return { db, tmpDir, dbPath };
}

// Fake HTTP layer. Routes by pathname; returns canned JSON. The
// library list endpoint and the paginated /api/Series endpoint are
// what syncKavita calls.
function fakeKavitaHttpDo({ libraries, seriesByLibrary }) {
  return async ({ method, url }) => {
    if (method !== 'GET') return { status: 405, headers: {}, text: '' };
    const u = new URL(url);
    if (u.pathname === '/api/Library/libraries') {
      return {
        status: 200, headers: {},
        text: JSON.stringify(libraries || []),
      };
    }
    const seriesMatch = u.pathname === '/api/Series';
    if (seriesMatch) {
      const libId = u.searchParams.get('LibraryId');
      const pageNum = Number(u.searchParams.get('PageNum') || 0);
      const all = seriesByLibrary[libId] || [];
      const PAGE_SIZE = 200;
      const start = pageNum * PAGE_SIZE;
      const slice = all.slice(start, start + PAGE_SIZE);
      const totalPages = Math.ceil(all.length / PAGE_SIZE) || 0;
      return {
        status: 200, headers: {},
        text: JSON.stringify({ result: slice, totalPages, totalCount: all.length, pageNumber: pageNum }),
      };
    }
    return { status: 404, headers: {}, text: 'not found: ' + url };
  };
}

// Tests use an async IIFE so we can await syncKavita without top-level await.
(async () => {
  let exitCode = 0;
  try {
    // ---- Test 1: idempotent migrate() ------------------------------------
    console.log('Test 1: schema migration is idempotent');
    {
      const { db, tmpDir } = freshDb();
      kavita.migrate(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND (name LIKE 'entit%' OR name = 'entities' OR name = 'entities_fts') ORDER BY name").all().map(t => t.name);
      assert(tables.includes('entities'), 'entities table exists');
      assert(tables.includes('entity_aliases'), 'entity_aliases table exists');
      assert(tables.includes('entity_edges'), 'entity_edges table exists');
      assert(tables.includes('entity_review_queue'), 'entity_review_queue table exists');
      assert(tables.includes('entities_fts'), 'entities_fts FTS5 table exists');
      kavita.migrate(db);
      ok('migrate() is idempotent on second call');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 2: dryRun walks the library without writing ----------------
    console.log('\nTest 2: dryRun walks the libraries without writing');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [
        { id: 1, name: 'Manga', type: 0 },
      ];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, summary: 'A sci-fi classic.', releaseDate: '1965-01-01T00:00:00', metadata: { writers: ['Frank Herbert'], genres: ['Sci-Fi'] } },
        { id: 101, libraryId: 1, name: 'Hyperion', libraryType: 0, summary: 'Cantos.', releaseDate: '1989-01-01T00:00:00', metadata: { writers: ['Dan Simmons'], genres: ['Sci-Fi'] } },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo, dryRun: true });
      assertEq(r.libraries, 1, 'one library seen');
      assertEq(r.items, 2, 'two series seen');
      assertEq(r.added + r.updated + r.edges, 0, 'no writes in dryRun');
      const entityCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      assertEq(entityCount, 0, 'entities table still empty after dryRun');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 3: manga sync creates work entities + edges ---------------
    console.log('\nTest 3: manga sync creates work entities + authored_by + tagged_with edges');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [
        { id: 1, name: 'Manga', type: 0 },
      ];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, summary: 'A sci-fi classic.', releaseDate: '1965-01-01T00:00:00', metadata: { writers: ['Frank Herbert'], genres: ['Sci-Fi', 'Politics'] } },
        { id: 101, libraryId: 1, name: 'Hyperion', libraryType: 0, summary: 'Cantos.', releaseDate: '1989-01-01T00:00:00', metadata: { writers: ['Dan Simmons'], genres: ['Sci-Fi'] } },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.libraries, 1, 'one library seen');
      assertEq(r.items, 2, 'two series seen');
      assertEq(r.added, 2, 'two work entities added');
      assertEq(r.errors.length, 0, 'no errors');

      const works = db.prepare("SELECT id, name, source_id, meta_json FROM entities WHERE kind = 'work' ORDER BY name").all();
      assertEq(works.map(w => w.name), ['Dune', 'Hyperion'], 'two work entities named correctly');
      assertEq(works.find(w => w.name === 'Dune').source_id, '100', 'Dune source_id = 100');

      const duneMeta = JSON.parse(works.find(w => w.name === 'Dune').meta_json);
      assertEq(duneMeta.year, 1965, 'Dune year extracted from releaseDate');
      assertEq(duneMeta.releaseDate, '1965-01-01T00:00:00', 'Dune releaseDate in meta');
      assertEq(duneMeta.format, 'manga', 'Dune format = manga');

      const personIds = db.prepare("SELECT id, name FROM entities WHERE kind = 'person' ORDER BY name").all();
      assertEq(personIds.map(p => p.name).sort(), ['Dan Simmons', 'Frank Herbert'], 'two author person entities');

      const authoredEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'authored_by' AND source_service = 'kavita'").get().c;
      assertEq(authoredEdges, 2, '2 authored_by edges');

      const taggedEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'tagged_with' AND source_service = 'kavita'").get().c;
      // Dune: Sci-Fi + Politics (2); Hyperion: Sci-Fi (1) → 3 tagged_with
      assertEq(taggedEdges, 3, '3 tagged_with edges (Dune: 2, Hyperion: 1)');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 4: book library is included in the walk --------------------
    console.log('\nTest 4: book library (type=1) is walked alongside manga');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [
        { id: 1, name: 'Manga', type: 0 },
        { id: 2, name: 'Books', type: 1 },
      ];
      const mangaSeries = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: { writers: ['Frank Herbert'], genres: ['Sci-Fi'] } },
      ];
      const bookSeries = [
        { id: 200, libraryId: 2, name: 'The Stand', libraryType: 1, metadata: { writers: ['Stephen King'], genres: ['Horror'] } },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': mangaSeries, '2': bookSeries } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.libraries, 2, 'two libraries seen (manga + books)');
      assertEq(r.items, 2, 'two series seen across both libraries');
      assertEq(r.added, 2, 'two work entities added');

      const duneMeta = db.prepare("SELECT meta_json FROM entities WHERE source_id = '100'").get();
      assertEq(JSON.parse(duneMeta.meta_json).format, 'manga', 'manga library format tag');
      const standMeta = db.prepare("SELECT meta_json FROM entities WHERE source_id = '200'").get();
      assertEq(JSON.parse(standMeta.meta_json).format, 'book', 'book library format tag');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 5: image + video libraries are filtered out ---------------
    console.log('\nTest 5: image (type=2) + video (type=3) libraries are filtered out');
    {
      const { db, tmpDir } = freshDb();
      // kavitaLibraries filters on type==0 or type==1; we hand it
      // all four library types and verify only the in-scope ones reach
      // the walk.
      const libraries = [
        { id: 1, name: 'Manga', type: 0 },
        { id: 2, name: 'Books', type: 1 },
        { id: 3, name: 'Image', type: 2 },
        { id: 4, name: 'Video', type: 3 },
      ];
      const mangaSeries = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: {} },
      ];
      const bookSeries = [
        { id: 200, libraryId: 2, name: 'The Stand', libraryType: 1, metadata: {} },
      ];
      const imageSeries = [
        { id: 300, libraryId: 3, name: 'CBZ Comic', libraryType: 2, metadata: {} },
      ];
      const videoSeries = [
        { id: 400, libraryId: 4, name: 'Video Series', libraryType: 3, metadata: {} },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': mangaSeries, '2': bookSeries, '3': imageSeries, '4': videoSeries } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.libraries, 2, 'only manga + books seen (image + video filtered)');
      assertEq(r.items, 2, 'only manga + book series walked');
      assertEq(r.added, 2, 'two work entities added (image + video excluded)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 6: person dedup by lowercased name ------------------------
    console.log('\nTest 6: person entities dedup by lowercased name across series');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [
        { id: 1, name: 'Manga', type: 0 },
      ];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: { writers: ['Frank Herbert'] } },
        { id: 101, libraryId: 1, name: 'Dune Messiah', libraryType: 0, metadata: { writers: ['Frank Herbert'] } },
        { id: 102, libraryId: 1, name: 'Children of Dune', libraryType: 0, metadata: { writers: ['FRANK HERBERT'] } }, // case diff
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.added, 3, '3 work entities added');
      const personCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'").get().c;
      assertEq(personCount, 1, 'one person entity for Frank Herbert (case-insensitive dedup)');
      const authoredEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'authored_by'").get().c;
      assertEq(authoredEdges, 3, '3 authored_by edges (one per series, all to the same person)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 7: concept dedup by slug (genres + tags collapse) ---------
    console.log('\nTest 7: concept entities dedup by slug (genre + tag cases collapse)');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [
        { id: 1, name: 'Manga', type: 0 },
      ];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: { genres: ['Sci-Fi', 'Politics'], tags: ['classic'] } },
        { id: 101, libraryId: 1, name: 'Hyperion', libraryType: 0, metadata: { genres: ['Sci-Fi'], tags: ['classic', 'space-opera'] } },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.added, 2, '2 work entities');
      const conceptCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'concept'").get().c;
      // Sci-Fi (×2 series) + Politics + classic (×2 series) + space-opera = 4 concepts
      assertEq(conceptCount, 4, '4 unique concept entities (Sci-Fi dedup, classic dedup)');

      const taggedEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'tagged_with'").get().c;
      // Dune: 2 genres + 1 tag = 3; Hyperion: 1 genre + 2 tags = 3; total 6
      assertEq(taggedEdges, 6, '6 tagged_with edges (2 genres + 1 tag per Dune; 1 genre + 2 tags per Hyperion)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 8: idempotency — second sync updates, doesn't duplicate ---
    console.log('\nTest 8: re-running sync is idempotent (no duplicate entities / edges)');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [{ id: 1, name: 'Manga', type: 0 }];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: { writers: ['Frank Herbert'], genres: ['Sci-Fi'] } },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      const r1 = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r1.added, 1, 'first sync added 1 work');
      const r2 = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r2.added, 0, 'second sync added 0 (entity already existed)');
      assertEq(r2.updated, 1, 'second sync updated 1');
      const entityCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      assertEq(entityCount, 3, 'still 3 entities (1 work + 1 person + 1 concept)');
      const edgeCount = db.prepare('SELECT COUNT(*) c FROM entity_edges').get().c;
      assertEq(edgeCount, 2, 'still 2 edges (1 authored_by + 1 tagged_with)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 9: stale-marking when series disappears -------------------
    console.log('\nTest 9: removing a series from the walk marks its edges stale (entity persists)');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [{ id: 1, name: 'Manga', type: 0 }];
      const seriesFirst = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: { writers: ['Frank Herbert'], genres: ['Sci-Fi'] } },
        { id: 101, libraryId: 1, name: 'Hyperion', libraryType: 0, metadata: { writers: ['Dan Simmons'], genres: ['Sci-Fi'] } },
      ];
      const httpDo1 = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': seriesFirst } });
      await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo: httpDo1 });

      // Drop Dune on the second run.
      const seriesSecond = seriesFirst.filter((s) => s.id !== 100);
      const httpDo2 = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': seriesSecond } });
      const r2 = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo: httpDo2 });

      // The Dune work entity still exists.
      const duneRow = db.prepare("SELECT id FROM entities WHERE kind = 'work' AND source_id = '100'").get();
      assert(!!duneRow, 'Dune work entity persists after removal from library');

      // Its edges are stale=1.
      const staleEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE stale = 1 AND source_service = 'kavita'").get().c;
      const freshEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE stale = 0 AND source_service = 'kavita'").get().c;
      assert(staleEdges >= 2, `Dune's edges (authored_by + tagged_with) go stale; got ${staleEdges}`);
      assert(freshEdges >= 2, `Hyperion's edges stay fresh; got ${freshEdges}`);
      assertEq(r2.stale, staleEdges, 'syncKavita reports the stale count');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 10: cross-library available_as for matching siblings -------
    console.log('\nTest 10: cross-library sibling (same title + year) emits available_as edge');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [
        { id: 1, name: 'Manga (English)', type: 0 },
        { id: 2, name: 'Manga (Japanese)', type: 0 },
      ];
      const lib1 = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, releaseDate: '1965-01-01T00:00:00', metadata: {} },
      ];
      const lib2 = [
        { id: 200, libraryId: 2, name: 'Dune', libraryType: 0, releaseDate: '1965-01-01T00:00:00', metadata: {} },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': lib1, '2': lib2 } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.added, 2, '2 work entities (one per library)');
      const availEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'available_as' AND source_service = 'kavita'").get().c;
      // Two siblings → 2 directed edges (a→b, b→a) because each side
      // emits when its own walk sees the other as a sibling.
      assert(availEdges >= 2, `expected ≥2 available_as edges, got ${availEdges}`);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 11: graceful error on missing API key ---------------------
    console.log('\nTest 11: missing KAVITA_API_KEY raises a clear error');
    {
      const { db, tmpDir } = freshDb();
      let threw = null;
      try {
        await kavita.syncKavita({ db, apiKey: '', baseUrl: 'https://kavita.test', httpDo: () => Promise.resolve({ status: 200, headers: {}, text: '[]' }) });
      } catch (e) {
        threw = e;
      }
      assert(threw && /KAVITA_API_KEY/.test(threw.message), 'throws with KAVITA_API_KEY mentioned');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 12: per-library error doesn't kill the whole sync ---------
    console.log('\nTest 12: library-level HTTP error is captured in errors[], other libraries still sync');
    {
      const { db, tmpDir } = freshDb();
      const httpDo = async ({ url }) => {
        const u = new URL(url);
        if (u.pathname === '/api/Library/libraries') {
          return { status: 200, headers: {}, text: JSON.stringify([
            { id: 1, name: 'Manga', type: 0 },
            { id: 2, name: 'Books', type: 1 },
          ]) };
        }
        const libId = u.searchParams.get('LibraryId');
        if (libId === '1') {
          return { status: 500, headers: {}, text: 'boom' };
        }
        if (libId === '2') {
          return { status: 200, headers: {}, text: JSON.stringify({ result: [
            { id: 200, libraryId: 2, name: 'The Stand', libraryType: 1, metadata: {} },
          ], totalPages: 1, totalCount: 1, pageNumber: 0 }) };
        }
        return { status: 404, headers: {}, text: 'no' };
      };
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.libraries, 2, '2 libraries attempted');
      assert(r.errors.length >= 1, 'errors[] captures library 1 failure');
      assertEq(r.added, 1, 'library 2 still synced (The Stand added)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 13: FTS5 index reflects new entities ----------------------
    console.log('\nTest 13: FTS5 index reflects inserted entities for cmd-K search');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [{ id: 1, name: 'Manga', type: 0 }];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, metadata: { writers: ['Frank Herbert'], genres: ['Sci-Fi'] } },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      // Search via FTS5 (Phase A's search will use this)
      const rows = db.prepare(`SELECT e.name FROM entities_fts f
        JOIN entities e ON e.rowid = f.rowid
        WHERE entities_fts MATCH 'dune'
        ORDER BY rank LIMIT 5`).all();
      assertEq(rows.map(r => r.name), ['Dune'], 'FTS5 finds Dune');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 14: slug uniqueness under concurrent-ish names ------------
    console.log('\nTest 14: duplicate names get unique slugs');
    {
      const { db, tmpDir } = freshDb();
      // Two works with the same title but different series IDs (e.g.,
      // different editions of the same book — Japanese vs English).
      const libraries = [{ id: 1, name: 'Manga', type: 0 }];
      const series = [
        { id: 100, libraryId: 1, name: 'Dune', libraryType: 0, releaseDate: '1965-01-01T00:00:00', metadata: {} },
        { id: 101, libraryId: 1, name: 'Dune', libraryType: 0, releaseDate: '2021-01-01T00:00:00', metadata: {} },  // different year → not dedup'd
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      const slugs = db.prepare("SELECT slug FROM entities WHERE kind = 'work' ORDER BY slug").all().map(r => r.slug);
      assertEq(new Set(slugs).size, slugs.length, 'all slugs unique');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 15: splitTags handles string + array forms ----------------
    console.log('\nTest 15: splitTags normalizes Kavita tag fields');
    {
      assertEq(kavita.splitTags(['Sci-Fi', 'Drama']), ['Sci-Fi', 'Drama'], 'array passthrough');
      assertEq(kavita.splitTags('Sci-Fi, Drama | Adventure'), ['Sci-Fi', 'Drama', 'Adventure'], 'mixed delim string');
      assertEq(kavita.splitTags(''), [], 'empty string → []');
      assertEq(kavita.splitTags(null), [], 'null → []');
      assertEq(kavita.splitTags(undefined), [], 'undefined → []');
    }

    // ---- Test 16: splitAuthors handles string + array forms -------------
    console.log('\nTest 16: splitAuthors normalizes Kavita writer fields');
    {
      assertEq(kavita.splitAuthors(['Frank Herbert', 'Dan Simmons']), ['Frank Herbert', 'Dan Simmons'], 'array passthrough');
      assertEq(kavita.splitAuthors('Frank Herbert, Dan Simmons'), ['Frank Herbert', 'Dan Simmons'], 'comma delim string');
      assertEq(kavita.splitAuthors('Frank Herbert | Dan Simmons'), ['Frank Herbert', 'Dan Simmons'], 'pipe delim string');
      assertEq(kavita.splitAuthors(['Frank Herbert', 'frank herbert']), ['Frank Herbert'], 'dedup (case-sensitive — meta keeps casing)');
      assertEq(kavita.splitAuthors(''), [], 'empty string → []');
      assertEq(kavita.splitAuthors(null), [], 'null → []');
    }

    // ---- Test 17: deepLinkFor emits a Kavita series-detail URL ----------
    console.log('\nTest 17: deepLinkFor emits a Kavita Library/Series URL');
    {
      const link = kavita.deepLinkFor({ id: 100, libraryId: 1 }, 'https://kavita.test');
      assert(link && /Library/.test(link) && /Series/.test(link) && /100/.test(link), 'deep link references the seriesId and libraryId');
    }

    // ---- Test 18: workMeta extracts year from releaseDate --------------
    console.log('\nTest 18: workMeta extracts year + format from series metadata');
    {
      const series = {
        id: 100,
        libraryId: 1,
        name: 'Dune',
        libraryType: 0,
        releaseDate: '1965-01-01T00:00:00',
        summary: 'A sci-fi classic.',
        originalPublisher: 'Chilton Books',
        metadata: { isbn: '978-0-441-01359-3', language: 'English' },
      };
      const meta = kavita.workMeta(series, 0);
      assertEq(meta.year, 1965, 'year extracted from releaseDate');
      assertEq(meta.releaseDate, '1965-01-01T00:00:00', 'releaseDate preserved');
      assertEq(meta.format, 'manga', 'format = manga (libraryType=0)');
      assertEq(meta.originalPublisher, 'Chilton Books', 'originalPublisher preserved');
      assertEq(meta.isbn, '978-0-441-01359-3', 'isbn from metadata');
      assertEq(meta.libraryId, 1, 'libraryId preserved');

      const bookMeta = kavita.workMeta({ id: 200, libraryId: 2, name: 'The Stand' }, 1);
      assertEq(bookMeta.format, 'book', 'format = book (libraryType=1)');
    }

    // ---- Test 19: writers/authors fallback fields are all read ----------
    console.log('\nTest 19: authored_by edges use writers, authors, and legacy writers fields');
    {
      const { db, tmpDir } = freshDb();
      const libraries = [{ id: 1, name: 'Manga', type: 0 }];
      const series = [
        // Kavita standard shape
        { id: 100, libraryId: 1, name: 'Series A', libraryType: 0, metadata: { writers: ['Frank Herbert'] } },
        // authors shape (alternate install)
        { id: 101, libraryId: 1, name: 'Series B', libraryType: 0, metadata: { authors: ['Stephen King'] } },
        // legacy flat shape
        { id: 102, libraryId: 1, name: 'Series C', libraryType: 0, writers: ['Ursula K. Le Guin'] },
      ];
      const httpDo = fakeKavitaHttpDo({ libraries, seriesByLibrary: { '1': series } });
      const r = await kavita.syncKavita({ db, apiKey: 'fake', baseUrl: 'https://kavita.test', httpDo });
      assertEq(r.added, 3, '3 work entities added');
      const authoredEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'authored_by' AND source_service = 'kavita'").get().c;
      assertEq(authoredEdges, 3, '3 authored_by edges (one per series)');
      const personNames = db.prepare("SELECT name FROM entities WHERE kind = 'person' ORDER BY name").all().map(p => p.name);
      assertEq(personNames, ['Frank Herbert', 'Stephen King', 'Ursula K. Le Guin'], 'all three authors resolved as person entities');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('\nFATAL: unexpected exception during tests:');
    console.error(e && e.stack || e);
    exitCode = 1;
  }

  console.log(`\nPHA-1874 kavita sync worker: ${pass} passed, ${fail} failed`);
  process.exit(exitCode || (fail === 0 ? 0 : 1));
})();