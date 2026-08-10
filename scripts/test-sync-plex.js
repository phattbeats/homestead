#!/usr/bin/env node
// PHA-1873 (PHA-1624 Phase B-1) acceptance tests for the Plex sync worker.
//
// Pure-DB tests: drive `lib/sync/plex.js` against a temp SQLite file
// with the entity-graph schema migrated from `lib/sync/_schema.js`. The
// HTTP layer is mocked via the `httpDo` dependency-injection seam so we
// never hit a real Plex server. Each test uses a fresh DB; tests are
// independent and idempotent.
//
// Run: `node scripts/test-sync-plex.js`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const plex = require('../lib/sync/plex');
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-plex-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);
  return { db, tmpDir, dbPath };
}

function fakePlexHttpDo({ sections, itemsBySection }) {
  return async ({ method, url }) => {
    if (method !== 'GET') return { status: 405, headers: {}, text: '' };
    const u = new URL(url);
    if (u.pathname === '/library/sections') {
      return {
        status: 200, headers: {},
        text: JSON.stringify({ MediaContainer: { Directory: sections } }),
      };
    }
    const allMatch = u.pathname.match(/^\/library\/sections\/([^/]+)\/all(?:\?|$)/);
    if (allMatch) {
      const key = allMatch[1];
      const type = u.searchParams.get('type');
      const all = itemsBySection[key] || [];
      const filtered = type
        ? all.filter((it) => String(plex.plexItemType(it)) === String(type))
        : all;
      return {
        status: 200, headers: {},
        text: JSON.stringify({ MediaContainer: { Metadata: filtered } }),
      };
    }
    const childrenMatch = u.pathname.match(/^\/library\/metadata\/([^/]+)\/children/);
    if (childrenMatch) {
      const ratingKey = childrenMatch[1];
      const children = itemsBySection['children:' + ratingKey] || [];
      return {
        status: 200, headers: {},
        text: JSON.stringify({ MediaContainer: { Metadata: children } }),
      };
    }
    return { status: 404, headers: {}, text: 'not found: ' + url };
  };
}

// Tests use an async IIFE so we can await syncPlex without top-level await.
(async () => {
  let exitCode = 0;
  try {
    // ---- Test 1: idempotent migrate() ------------------------------------
    console.log('Test 1: schema migration is idempotent');
    {
      const { db, tmpDir } = freshDb();
      plex.migrate(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND (name LIKE 'entit%' OR name = 'entities' OR name = 'entities_fts') ORDER BY name").all().map(t => t.name);
      assert(tables.includes('entities'), 'entities table exists');
      assert(tables.includes('entity_aliases'), 'entity_aliases table exists');
      assert(tables.includes('entity_edges'), 'entity_edges table exists');
      assert(tables.includes('entity_review_queue'), 'entity_review_queue table exists');
      assert(tables.includes('entities_fts'), 'entities_fts FTS5 table exists');
      plex.migrate(db);
      ok('migrate() is idempotent on second call');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 2: dryRun walk counts but writes nothing -------------------
    console.log('\nTest 2: dryRun walks the library without writing');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, summary: 'A sci-fi classic.', Genre: ['Sci-Fi', 'Adventure'], Director: ['David Lynch'] },
        { ratingKey: '101', type: 'movie', title: 'Arrival', year: 2016, summary: 'Linguistics + aliens.', Genre: ['Sci-Fi', 'Drama'], Director: ['Denis Villeneuve'] },
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo, dryRun: true });
      assertEq(r.libraries, 1, 'one library seen');
      assertEq(r.items, 2, 'two items seen');
      assertEq(r.added + r.updated + r.edges, 0, 'no writes in dryRun');
      const entityCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      assertEq(entityCount, 0, 'entities table still empty after dryRun');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 3: movies sync creates work entities + edges ---------------
    console.log('\nTest 3: movies sync creates work entities + tagged_with + directed_by edges');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, summary: 'A sci-fi classic.', Genre: ['Sci-Fi', 'Adventure'], Director: ['David Lynch'] },
        { ratingKey: '101', type: 'movie', title: 'Arrival', year: 2016, summary: 'Linguistics + aliens.', Genre: ['Sci-Fi', 'Drama'], Director: ['Denis Villeneuve'] },
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r.libraries, 1, 'one library seen');
      assertEq(r.items, 2, 'two items seen');
      assertEq(r.added, 2, 'two work entities added');
      assertEq(r.errors.length, 0, 'no errors');

      const works = db.prepare("SELECT id, name, source_id, meta_json FROM entities WHERE kind = 'work' ORDER BY name").all();
      assertEq(works.map(w => w.name), ['Arrival', 'Dune'], 'two work entities named correctly');
      assertEq(works.every(w => JSON.parse(w.meta_json).year > 0), true, 'work meta has year');
      assertEq(works.find(w => w.name === 'Dune').source_id, '100', 'Dune source_id = 100');

      const personIds = db.prepare("SELECT id, name FROM entities WHERE kind = 'person' ORDER BY name").all();
      // alphabetical: Denis < David because 'De' < 'Da' is false; actually D-e < D-a is false.
      // SQLite ORDER BY name is binary collation by default → 'David Lynch' < 'Denis Villeneuve'
      // because 'a' < 'e'. So the actual order is ['David Lynch', 'Denis Villeneuve'].
      assertEq(personIds.map(p => p.name).sort(), ['David Lynch', 'Denis Villeneuve'], 'two director person entities (set-equal)');

      const conceptIds = db.prepare("SELECT id, name FROM entities WHERE kind = 'concept' ORDER BY name").all();
      // 2 movies × 2 genres each = 4 unique (Sci-Fi/Adventure, Sci-Fi/Drama, Drama is unique because dedup on slug)
      const conceptNames = conceptIds.map(c => c.name);
      assertEq(conceptNames.includes('Sci-Fi'), true, 'concept: Sci-Fi');
      assertEq(conceptNames.includes('Adventure'), true, 'concept: Adventure');
      assertEq(conceptNames.includes('Drama'), true, 'concept: Drama');

      const taggedEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'tagged_with' AND source_service = 'plex'").get().c;
      assertEq(taggedEdges, 4, '4 tagged_with edges (2 movies × 2 genres each)');

      const directedEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'directed_by' AND source_service = 'plex'").get().c;
      assertEq(directedEdges, 2, '2 directed_by edges');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 4: person dedup by lowercased name -------------------------
    console.log('\nTest 4: person entities dedup by lowercased name across movies');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, Director: ['David Lynch'] },
        { ratingKey: '200', type: 'movie', title: 'Twin Peaks', year: 1992, Director: ['David Lynch'] },
        { ratingKey: '201', type: 'movie', title: 'Mulholland Drive', year: 2001, Director: ['david lynch'] }, // case diff
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r.added, 3, '3 work entities added');
      const personCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'").get().c;
      assertEq(personCount, 1, 'one person entity for David Lynch (case-insensitive dedup)');
      const directedEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'directed_by'").get().c;
      assertEq(directedEdges, 3, '3 directed_by edges (one per movie, all to the same person)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 5: concept dedup by slug ------------------------------------
    console.log('\nTest 5: concept entities dedup by slug (genre/mood/collection collapse)');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, Genre: ['Sci-Fi', 'Adventure'], Mood: ['Mind-Bending'] },
        { ratingKey: '101', type: 'movie', title: 'Blade Runner', year: 1982, Genre: ['Sci-Fi'], Mood: ['Mind-Bending'] },
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r.added, 2, '2 work entities');
      const conceptCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'concept'").get().c;
      // Sci-Fi (×2 movies), Adventure, Mind-Bending (×2 movies) = 3 concepts
      assertEq(conceptCount, 3, '3 unique concept entities (Sci-Fi dedup, Mind-Bending dedup)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 6: show walk descends into seasons + episodes --------------
    console.log('\nTest 6: show walk emits part_of for season + episode, with edge back to show');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '5', title: 'TV', type: 2 }];
      const shows = [
        { ratingKey: '500', type: 'show', title: 'Severance', year: 2022, Genre: ['Sci-Fi', 'Drama'] },
      ];
      const seasons = [
        { ratingKey: '510', type: 'season', parentRatingKey: '500', parentTitle: 'Severance', title: 'Season 1', index: 1 },
        { ratingKey: '511', type: 'season', parentRatingKey: '500', parentTitle: 'Severance', title: 'Season 2', index: 2 },
      ];
      const episodes = [
        { ratingKey: '520', type: 'episode', parentRatingKey: '510', parentTitle: 'Season 1', grandparentRatingKey: '500', grandparentTitle: 'Severance', title: 'Good News About Hell', index: 1, parentIndex: 1 },
      ];
      const itemsBySection = {
        '5': shows,
        'children:500': seasons,
        'children:510': episodes,
      };
      const httpDo = fakePlexHttpDo({ sections, itemsBySection });
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r.items, 4, '4 items (1 show + 2 seasons + 1 episode)');
      assertEq(r.added, 4, '4 work entities added');

      const workCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'work'").get().c;
      assertEq(workCount, 4, '4 work entities (show + 2 seasons + 1 episode)');

      const partOfEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'part_of'").get().c;
      // 2 seasons (each → show) + 1 episode (→ season) = 3 part_of edges
      assertEq(partOfEdges, 3, '3 part_of edges (seasons + episode)');

      const showEntity = db.prepare("SELECT id FROM entities WHERE source_id = '500'").get();
      const partOfFromShow = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'part_of' AND to_id = ?").get(showEntity.id).c;
      assertEq(partOfFromShow, 2, 'show has 2 incoming part_of edges (2 seasons)');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 7: idempotency — second sync updates, doesn't duplicate ----
    console.log('\nTest 7: re-running sync is idempotent (no duplicate entities / edges)');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, Genre: ['Sci-Fi'], Director: ['David Lynch'] },
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      const r1 = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r1.added, 1, 'first sync added 1 work');
      const r2 = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r2.added, 0, 'second sync added 0 (entity already existed)');
      assertEq(r2.updated, 1, 'second sync updated 1');
      const entityCount = db.prepare('SELECT COUNT(*) c FROM entities').get().c;
      assertEq(entityCount, 3, 'still 3 entities (1 work + 1 person + 1 concept)');
      const edgeCount = db.prepare('SELECT COUNT(*) c FROM entity_edges').get().c;
      assertEq(edgeCount, 2, 'still 2 edges (1 tagged_with + 1 directed_by)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 8: stale-marking when item disappears ---------------------
    console.log('\nTest 8: removing an item from the walk marks its edges stale (entity persists)');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const moviesFirst = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, Genre: ['Sci-Fi'], Director: ['David Lynch'] },
        { ratingKey: '101', type: 'movie', title: 'Arrival', year: 2016, Genre: ['Sci-Fi'], Director: ['Denis Villeneuve'] },
      ];
      const httpDo1 = fakePlexHttpDo({ sections, itemsBySection: { '2': moviesFirst } });
      await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo: httpDo1 });

      // Drop Dune on the second run.
      const moviesSecond = moviesFirst.filter((m) => m.ratingKey !== '100');
      const httpDo2 = fakePlexHttpDo({ sections, itemsBySection: { '2': moviesSecond } });
      const r2 = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo: httpDo2 });

      // The Dune work entity still exists.
      const duneRow = db.prepare("SELECT id FROM entities WHERE kind = 'work' AND source_id = '100'").get();
      assert(!!duneRow, 'Dune work entity persists after removal from library');

      // Its edges are stale=1.
      // Dune's edges (source_id starts with "100|") should be stale; Arrival's edges (source_id "101|") stay fresh.
      const staleEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE stale = 1 AND source_service = 'plex'").get().c;
      const freshEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE stale = 0 AND source_service = 'plex'").get().c;
      assert(staleEdges >= 2, `Dune's edges (tagged_with + directed_by) go stale; got ${staleEdges}`);
      assert(freshEdges >= 2, `Arrival's edges stay fresh; got ${freshEdges}`);
      assertEq(r2.stale, staleEdges, 'syncPlex reports the stale count');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 9: cross-library available_as for matching siblings --------
    console.log('\nTest 9: cross-library sibling (same title + year) emits available_as edge');
    {
      const { db, tmpDir } = freshDb();
      const sections = [
        { key: '2', title: 'Movies', type: 1 },
        { key: '3', title: '4K Movies', type: 1 },
      ];
      const lib2 = [{ ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, Genre: ['Sci-Fi'] }];
      const lib3 = [{ ratingKey: '200', type: 'movie', title: 'Dune', year: 1984, Genre: ['Sci-Fi'] }];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': lib2, '3': lib3 } });
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r.added, 2, '2 work entities (one per library)');
      const availEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'available_as'").get().c;
      // Two siblings → 2 directed edges (a→b, b→a) because each side
      // emits when its own walk sees the other as a sibling.
      assert(availEdges >= 2, `expected ≥2 available_as edges, got ${availEdges}`);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 10: graceful error on missing token ------------------------
    console.log('\nTest 10: missing PLEX_TOKEN raises a clear error');
    {
      const { db, tmpDir } = freshDb();
      let threw = null;
      try {
        await plex.syncPlex({ db, token: '', baseUrl: 'https://plex.test', httpDo: () => Promise.resolve({ status: 200, headers: {}, text: '{}' }) });
      } catch (e) {
        threw = e;
      }
      assert(threw && /PLEX_TOKEN/.test(threw.message), 'throws with PLEX_TOKEN mentioned');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 11: per-section error doesn't kill the whole sync ----------
    console.log('\nTest 11: section-level HTTP error is captured in errors[], other sections still sync');
    {
      const { db, tmpDir } = freshDb();
      // Make the fake return 500 for any path under /library/sections/2/.
      const httpDo = async ({ url }) => {
        const u = new URL(url);
        if (u.pathname === '/library/sections') {
          return { status: 200, headers: {}, text: JSON.stringify({ MediaContainer: { Directory: [
            { key: '2', title: 'Movies', type: 1 },
            { key: '3', title: '4K', type: 1 },
          ] } }) };
        }
        if (u.pathname.startsWith('/library/sections/2/')) {
          return { status: 500, headers: {}, text: 'boom' };
        }
        if (u.pathname.startsWith('/library/sections/3/')) {
          return { status: 200, headers: {}, text: JSON.stringify({ MediaContainer: { Metadata: [
            { ratingKey: '300', type: 'movie', title: 'Tenet', year: 2020, Genre: ['Sci-Fi'] },
          ] } }) };
        }
        return { status: 404, headers: {}, text: 'no' };
      };
      const r = await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      assertEq(r.libraries, 2, '2 libraries attempted');
      assert(r.errors.length >= 1, 'errors[] captures section 2 failure');
      assertEq(r.added, 1, 'section 3 still synced (Tenet added)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 12: FTS5 index reflects new entities -----------------------
    console.log('\nTest 12: FTS5 index reflects inserted entities for cmd-K search');
    {
      const { db, tmpDir } = freshDb();
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984, Genre: ['Sci-Fi'], Director: ['David Lynch'] },
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      // Search via FTS5 (Phase A's search will use this)
      const rows = db.prepare(`SELECT e.name FROM entities_fts f
        JOIN entities e ON e.rowid = f.rowid
        WHERE entities_fts MATCH 'dune'
        ORDER BY rank LIMIT 5`).all();
      assertEq(rows.map(r => r.name), ['Dune'], 'FTS5 finds Dune');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 13: slug uniqueness under concurrent-ish names -------------
    console.log('\nTest 13: duplicate names get unique slugs');
    {
      const { db, tmpDir } = freshDb();
      // Two works with the same title but different ratingKeys (e.g.,
      // user has two library entries for the same movie).
      const sections = [{ key: '2', title: 'Movies', type: 1 }];
      const movies = [
        { ratingKey: '100', type: 'movie', title: 'Dune', year: 1984 },
        { ratingKey: '101', type: 'movie', title: 'Dune', year: 2021 },  // different year → not dedup'd
      ];
      const httpDo = fakePlexHttpDo({ sections, itemsBySection: { '2': movies } });
      await plex.syncPlex({ db, token: 'fake', baseUrl: 'https://plex.test', httpDo });
      const slugs = db.prepare("SELECT slug FROM entities WHERE kind = 'work' ORDER BY slug").all().map(r => r.slug);
      assertEq(new Set(slugs).size, slugs.length, 'all slugs unique');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 14: plexItemType handles both numeric + string forms -------
    console.log('\nTest 14: plexItemType handles Plex API type field variants');
    {
      assertEq(plex.plexItemType({ type: 1 }), 1, 'numeric 1 → 1 (movie)');
      assertEq(plex.plexItemType({ type: 'movie' }), 1, 'string "movie" → 1');
      assertEq(plex.plexItemType({ type: 2 }), 2, 'numeric 2 → 2 (show)');
      assertEq(plex.plexItemType({ type: 'show' }), 2, 'string "show" → 2');
      assertEq(plex.plexItemType({ type: 3 }), 3, 'numeric 3 → 3 (season)');
      assertEq(plex.plexItemType({ type: 'season' }), 3, 'string "season" → 3');
      assertEq(plex.plexItemType({ type: 4 }), 4, 'numeric 4 → 4 (episode)');
      assertEq(plex.plexItemType({ type: 'episode' }), 4, 'string "episode" → 4');
      assertEq(plex.plexItemType({}), null, 'empty object → null');
    }

    // ---- Test 15: splitTags handles string + array forms -----------------
    console.log('\nTest 15: splitTags normalizes Plex tag fields');
    {
      assertEq(plex.splitTags(['Sci-Fi', 'Drama']), ['Sci-Fi', 'Drama'], 'array passthrough');
      assertEq(plex.splitTags('Sci-Fi, Drama | Adventure'), ['Sci-Fi', 'Drama', 'Adventure'], 'mixed delim string');
      assertEq(plex.splitTags(''), [], 'empty string → []');
      assertEq(plex.splitTags(null), [], 'null → []');
      assertEq(plex.splitTags(undefined), [], 'undefined → []');
    }

    // ---- Test 16: deepLinkFor emits a Plex web-app details URL -----------
    console.log('\nTest 16: deepLinkFor emits a Plex web-app details URL');
    {
      const link = plex.deepLinkFor({ ratingKey: '100' }, 'https://plex.test', 'tok');
      assert(link && /details/.test(link) && /100/.test(link), 'deep link references the ratingKey');
    }
  } catch (e) {
    console.error('\nFATAL: unexpected exception during tests:');
    console.error(e && e.stack || e);
    exitCode = 1;
  }

  console.log(`\nPHA-1873 plex sync worker: ${pass} passed, ${fail} failed`);
  process.exit(exitCode || (fail === 0 ? 0 : 1));
})();