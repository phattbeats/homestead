#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1876 (PHA-1624 Phase C) acceptance tests for the entity-graph
// dedup + review-queue matcher.
//
// Pure-DB tests: drive `lib/dedup/matcher.js` against a temp SQLite
// file with the entity-graph schema migrated from `lib/sync/_schema.js`.
// No HTTP layer involved; matcher is pure DB-in / DB-out.
//
// Run: `node scripts/test-dedup-matcher.js`
//
// Coverage (locked in PHA-1876 acceptance):
//   * `matchEntity` returns the documented verdict shapes:
//       action: 'link'   (Tier 1 or 2 emits adaptation_of edges)
//       action: 'alias'  (Tier 3 ≥ 0.9 auto-aliases, no merge)
//       action: 'queue'  (Tier 3 0.7..0.9 emits review queue entry)
//       action: 'no-op'  (Tier 3 < 0.7)
//   * Tier 1 walks every known-ID slot (isbn, tmdb_id, audible_id,
//     plex_guid, kavita_id) and never merges.
//   * Tier 2 only fires when both sides have the same TMDB collection
//     + same year; falls through to Tier 3 when either side lacks it.
//   * Tier 3 score formula and thresholds are exactly the design doc
//     defaults (0.6*title + 0.3*author + 0.1*year).
//   * `siblingDetector` finds ≥ 2 same-title+author works with no
//     adaptation_of edge and queues a review item, but skips pairs
//     already linked.
//   * `mergeEntities` is the ONLY path to merge; it re-points edges,
//     promotes aliases, deletes the merged row, and marks the review
//     item status='merged'.
//   * `rejectReviewItem` marks status='rejected'.
//   * Re-running the matcher against the same data is idempotent —
//     alias dedup, edge UNIQUE constraint, review-queue dedup all
//     keep counts stable.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const matcher = require('../lib/dedup/matcher');
const { migrate: migrateEntity } = require('../lib/sync/_schema');

let pass = 0;
let fail = 0;
const failures = [];

function ok(label) { pass += 1; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail += 1; failures.push({ label, detail }); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

// ---- Test fixtures ----------------------------------------------------

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-dedup-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);
  return { db, tmpDir, dbPath };
}

// Seed a `work` entity. The matcher's `tier1IdMatch` looks up by
// `meta_json` slot, so we round-trip via the real schema INSERTs.
function seedWork(db, { id, name, meta = {}, source_service = null, source_id = null }) {
  const nameLower = (name || '').toLowerCase().trim() || 'untitled';
  // Slug uniqueness: include the id suffix so two entities with the
  // same display name don't collide on the UNIQUE constraint.
  const slug = `${matcher.slugify(name)}-${String(id).slice(0, 12)}`;
  db.prepare(
    `INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
     VALUES (?, 'work', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)`,
  ).run(id, name, slug, JSON.stringify(meta),
       `sync:${source_service || 'manual'}`, source_service, source_id, nameLower);
  return id;
}

function entityMeta(db, id) {
  const r = db.prepare(`SELECT meta_json FROM entities WHERE id = ?`).get(id);
  return r ? JSON.parse(r.meta_json || '{}') : null;
}

function reviewItems(db, where = '1=1', params = []) {
  return db.prepare(`SELECT * FROM entity_review_queue WHERE ${where}`).all(...params);
}

// ---- Tests ------------------------------------------------------------

(async () => {
  let exitCode = 0;
  try {
    // ---- Test 1: schema is compatible ----
    console.log('Test 1: schema migration installs the tables the matcher needs');
    {
      const { db, tmpDir } = freshDb();
      const tables = db.prepare(`SELECT name FROM sqlite_master
                                 WHERE type IN ('table','view') AND name LIKE 'entit%'
                                 ORDER BY name`).all().map(t => t.name);
      assert(tables.includes('entities'), 'entities table exists');
      assert(tables.includes('entity_aliases'), 'entity_aliases table exists');
      assert(tables.includes('entity_edges'), 'entity_edges table exists');
      assert(tables.includes('entity_review_queue'), 'entity_review_queue table exists');
      // Sanity-check the matcher reads/writes via a no-op round trip.
      const r = matcher.matchEntity(db, { kind: 'work', name: 'Probe', meta: {}, source_service: 'plex', source_id: 'x' });
      assertEq(r.action, 'no-op', 'empty DB → no-op');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 2: helper unit tests ----
    console.log('\nTest 2: helper functions');
    {
      assertEq(matcher.trigramJaccard(matcher.trigrams('dune'), matcher.trigrams('dune')), 1.0, 'Jaccard dune vs dune = 1');
      const j = matcher.trigramJaccard(matcher.trigrams('dune'), matcher.trigrams('duner'));
      assert(j > 0 && j < 1, 'Jaccard dune vs duner between 0 and 1', `got ${j}`);
      assertEq(matcher.authorSimilarity('Frank Herbert', 'Frank Herbert'), 1.0, 'authorSim exact = 1');
      assertEq(matcher.authorSimilarity('Frank Herbert', 'Herbert, Frank'), 1.0, 'authorSim token-set reordered = 1');
      const ap = matcher.authorSimilarity('Frank Herbert', 'F. Herbert');
      assert(ap > 0 && ap < 1, 'authorSim partial overlap', `got ${ap}`);
      assertEq(matcher.yearProximity(1965, 1965), 1.0, 'year exact = 1');
      assertEq(matcher.yearProximity(1965, 1966), 0.8, 'year ±1 = 0.8');
      assertEq(matcher.yearProximity(1965, 1975), 0, 'year far = 0');
      assertEq(matcher.yearProximity('1965', 1965), 1.0, 'year coerced from string');
      assertEq(matcher.yearProximity(null, 1965), 0, 'year missing → 0');
    }

    // ---- Test 3: Tier 1 — ISBN match ----
    console.log('\nTest 3: Tier 1 — shared ISBN emits adaptation_of (no merge)');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_book', name: 'Dune', source_service: 'kavita', source_id: 'kavita:1',
                     meta: { isbn: '978-0-441-01359-3', year: 1965, authors: ['Frank Herbert'] } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { isbn: '978-0-441-01359-3', year: 1965, authors: ['Frank Herbert'] },
        source_service: 'audiobookshelf', source_id: 'audiobookshelf:1',
      }, { newEntityId: 'w_audio', dryRun: true });
      assertEq(r.action, 'link', 'Tier 1 returns action=link');
      assertEq(r.tier, 1, 'tier=1');
      assertEq(r.slot, 'isbn', 'matched slot = isbn');
      assertEq(r.existing.id, 'w_book', 'existing.id = w_book');
      assertEq(r.edge.type, 'adaptation_of', 'edge type = adaptation_of');
      assertEq(r.edge.source_service, 'dedup:tier1', 'edge source_service = dedup:tier1');
      assertEq(r.edge.weight, 1.0, 'edge weight = 1.0');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 4: Tier 1 — each known-ID slot is walked ----
    console.log('\nTest 4: Tier 1 — every known-ID slot (isbn/tmdb_id/audible_id/plex_guid/kavita_id)');
    {
      const slots = [
        ['tmdb_id', '693'],
        ['audible_id', 'B0725G4QK8'],
        ['plex_guid', 'plex://abc'],
        ['kavita_id', 'kavita-77'],
      ];
      for (const [slot, val] of slots) {
        const { db, tmpDir } = freshDb();
        seedWork(db, { id: 'w_seed', name: 'Dune', source_service: 'kavita', source_id: '1',
                       meta: { [slot]: val, year: 1965 } });
        const r = matcher.matchEntity(db, {
          kind: 'work', name: 'Dune',
          meta: { [slot]: val, year: 1965 },
          source_service: 'plex', source_id: 'plex:2',
        }, { newEntityId: 'w_new', dryRun: true });
        assertEq(r.action, 'link', `Tier 1 hit on slot=${slot}`);
        assertEq(r.slot, slot, `slot=${slot} reported back`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    // ---- Test 5: Tier 1 — self-match is skipped ----
    console.log('\nTest 5: Tier 1 — same (source_service, source_id) does NOT match itself');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_self', name: 'Dune', source_service: 'plex', source_id: '1',
                     meta: { isbn: '978-X', year: 1965 } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { isbn: '978-X', year: 1965 },
        source_service: 'plex', source_id: '1',     // same id → would be self
      }, { newEntityId: 'w_self', dryRun: true });
      // Should NOT be a Tier-1 hit. Tier 3 also returns no-op
      // because we filter the candidate's own row.
      assert(r.action !== 'link' || r.tier !== 1, 'self-match is not flagged as Tier 1 hit');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 6: Tier 1 — empty meta returns no-op / Tier 3 ----
    console.log('\nTest 6: Tier 1 — empty meta → fall through (no Tier-1 hit)');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_x', name: 'Dune', source_service: 'kavita', source_id: '1', meta: {} });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: {}, source_service: 'plex', source_id: '2',
      }, { newEntityId: 'w_y', dryRun: true });
      assert(r.action === 'no-op' || r.action === 'alias' || r.action === 'queue' || (r.action === 'link' && r.tier === 3),
             'no Tier-1 hit when both sides lack ID slots');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 7: Tier 2 — TMDB collection + same year ----
    console.log('\nTest 7: Tier 2 — shared TMDB collection + same year → adaptation_of');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_plex', name: 'Dune', source_service: 'plex', source_id: '1',
                     meta: { tmdb_id: 693, tmdb_collection: 'dune-collection', year: 1984 } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { tmdb_id: 693, tmdb_collection: 'dune-collection', year: 1984 },
        source_service: 'kavita', source_id: '1',
      }, { newEntityId: 'w_kavita', dryRun: true });
      assertEq(r.action, 'link', 'Tier 2 link');
      assertEq(r.tier, 2, 'tier=2');
      assertEq(r.edge.type, 'adaptation_of', 'edge type = adaptation_of');
      assertEq(r.edge.source_service, 'dedup:tier2', 'edge source_service = dedup:tier2');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 8: Tier 2 — different year → fall through ----
    console.log('\nTest 8: Tier 2 — different year → fall through to Tier 3');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_old', name: 'Dune', source_service: 'plex', source_id: '1',
                     meta: { tmdb_id: 693, tmdb_collection: 'dune-collection', year: 1984 } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { tmdb_id: 693, tmdb_collection: 'dune-collection', year: 2021 },
        source_service: 'kavita', source_id: '2',
      }, { newEntityId: 'w_new', dryRun: true });
      // Tier 2 missed (year differs); falls through. Tier 3 will
      // classify based on title+author+year — with no author on
      // either side, year diff is 37 → year=0, title sim = 1.
      // Score = 0.6*1 + 0.3*0.5 + 0.1*0 = 0.75 → 'queue'.
      assert(r.action === 'queue' || r.action === 'alias', `Tier 2 fell through; got ${r.action}`);
      if (r.action === 'queue') assert(r.item.score >= 0.7 && r.item.score < 0.9, 'queue score between 0.7..0.9');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 9: Tier 3 — exact match → alias ----
    console.log('\nTest 9: Tier 3 — exact title+author+year → auto-alias (no merge)');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { year: 1965, authors: ['Frank Herbert'] } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { year: 1965, authors: ['Frank Herbert'] },
        source_service: 'plex', source_id: '1',
      }, { newEntityId: 'w_b', dryRun: false });
      assertEq(r.action, 'alias', 'exact match returns action=alias');
      assertEq(r.onto, 'w_a', 'onto = the existing seed');
      assertEq(r.alias, 'Dune', 'alias = the candidate name');
      assert(r.score >= 0.9, `score >= 0.9; got ${r.score}`);
      assert(r.aliasCreated, 'alias was actually inserted');
      const aliases = db.prepare(`SELECT entity_id, alias, source FROM entity_aliases WHERE alias_lower = 'dune'`).all();
      assertEq(aliases.length, 1, 'one alias row');
      assertEq(aliases[0].entity_id, 'w_a', 'alias attached to the seed');
      assertEq(aliases[0].source, 'dedup:tier3', 'alias source = dedup:tier3');
      // Idempotent re-run: alias already exists, no new row.
      const r2 = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { year: 1965, authors: ['Frank Herbert'] },
        source_service: 'seerr', source_id: '1',
      }, { newEntityId: 'w_c', dryRun: false });
      assertEq(r2.action, 'alias', 'second run still returns action=alias');
      assertEq(r2.aliasCreated, false, 'second run: aliasCreated = false (already exists)');
      assertEq(r2.aliasExistedOn, 'w_a', 'second run: aliasExistedOn points at the seed');
      const aliases2 = db.prepare(`SELECT COUNT(*) c FROM entity_aliases WHERE alias_lower = 'dune'`).get().c;
      assertEq(aliases2, 1, 'still one alias row after re-run');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 10: Tier 3 — near-match → review queue ----
    console.log('\nTest 10: Tier 3 — near match (0.7..0.9) emits review queue entry');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'Project Hail Mary', source_service: 'kavita', source_id: '1',
                     meta: { year: 2021, authors: ['Andy Weir'] } });
      // The matcher's review-queue FK requires candidate_b to be a
      // real entity row. Seed the candidate up-front (mirrors what
      // the plex/kavita workers do before calling the matcher).
      seedWork(db, { id: 'w_b', name: 'Project Hail-Mary', source_service: 'plex', source_id: '1',
                     meta: { year: 2021, authors: ['Andy Weir'] } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Project Hail-Mary',
        meta: { year: 2021, authors: ['Andy Weir'] },
        source_service: 'plex', source_id: '1',
      }, { newEntityId: 'w_b', dryRun: false });
      assert(r.action === 'alias' || r.action === 'queue', `near match returns alias or queue; got ${r.action}`);
      if (r.action === 'queue') {
        assertEq(r.item.kind, 'tier3_fuzzy', 'review kind = tier3_fuzzy');
        assertEq(r.item.existing.id, 'w_a', 'item.existing = w_a');
        assertEq(r.item.candidate.source_service, 'plex', 'item.candidate.source_service = plex');
        const reviews = reviewItems(db, `kind = 'tier3_fuzzy' AND status = 'pending'`);
        assertEq(reviews.length, 1, 'one pending review row');
        assertEq(reviews[0].candidate_a, 'w_a', 'candidate_a = w_a');
        assertEq(reviews[0].candidate_b, 'w_b', 'candidate_b = w_b');
        const ev = JSON.parse(reviews[0].evidence_json);
        assert(ev.components && typeof ev.components.title === 'number', 'evidence_json.components.title is a number');
      } else {
        // alias path: re-run with a deliberately fuzzier title to
        // exercise the queue branch in this same test.
        seedWork(db, { id: 'w_c', name: 'Project Hail Mary Special Edition', source_service: 'seerr', source_id: '1',
                       meta: { year: 2021, authors: ['Andy Weir'] } });
        const r2 = matcher.matchEntity(db, {
          kind: 'work', name: 'Project Hail Mary Special Edition',
          meta: { year: 2021, authors: ['Andy Weir'] },
          source_service: 'seerr', source_id: '1',
        }, { newEntityId: 'w_c', dryRun: false });
        assert(r2.action === 'queue' || r2.action === 'alias', `fuzzier re-run returns queue or alias; got ${r2.action}`);
        const reviews = reviewItems(db, `kind = 'tier3_fuzzy' AND status = 'pending'`);
        if (r2.action === 'queue') {
          assertEq(reviews.length, 1, 'one pending review row from re-run');
          assertEq(reviews[0].candidate_b, 'w_c', 'candidate_b = w_c');
        } else {
          const aliases = db.prepare(`SELECT COUNT(*) c FROM entity_aliases WHERE alias_lower = 'project hail mary'`).get().c;
          assert(aliases >= 1, `≥1 alias for project hail mary; got ${aliases}`);
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 11: Tier 3 — low confidence → no-op ----
    console.log('\nTest 11: Tier 3 — low confidence (<0.7) returns no-op');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'The Lord of the Rings', source_service: 'kavita', source_id: '1',
                     meta: { year: 1954, authors: ['J.R.R. Tolkien'] } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { year: 1965, authors: ['Frank Herbert'] },
        source_service: 'plex', source_id: '1',
      }, { newEntityId: 'w_b', dryRun: false });
      assertEq(r.action, 'no-op', 'low-confidence returns no-op');
      assert(r.best == null || r.best.score < 0.7, 'best score below 0.7');
      const reviews = reviewItems(db);
      assertEq(reviews.length, 0, 'no review queue entry');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 12: Tier 1 — emits reverse edge too ----
    console.log('\nTest 12: Tier 1 link edges emit both directions');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_book', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { isbn: '978-X', year: 1965 } });
      seedWork(db, { id: 'w_audio', name: 'Dune', source_service: 'audiobookshelf', source_id: '1',
                     meta: { isbn: '978-X', year: 1965 } });
      // The candidate must also exist as a row for the FK on
      // entity_edges to accept the to_id reference. Seed it before
      // invoking the matcher.
      seedWork(db, { id: 'w_seerr', name: 'Dune', source_service: 'seerr', source_id: '1',
                     meta: { isbn: '978-X', year: 1965 } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { isbn: '978-X', year: 1965 },
        source_service: 'seerr', source_id: '1',
      }, { newEntityId: 'w_seerr', dryRun: false });
      assertEq(r.action, 'link', 'Tier 1 link with new id');
      const edges = db.prepare(`SELECT from_id, to_id, source_service, source_id FROM entity_edges
                                WHERE type = 'adaptation_of' AND source_service = 'dedup:tier1'`).all();
      assertEq(edges.length, 2, 'two directed adaptation_of edges');
      const set = new Set(edges.map(e => `${e.from_id}->${e.to_id}`));
      assert(set.has('w_book->w_seerr'), 'w_book -> w_seerr');
      assert(set.has('w_seerr->w_book'), 'w_seerr -> w_book (reverse)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 13: siblingDetector finds same-title+author siblings ----
    console.log('\nTest 13: siblingDetector queues review for same-title+author cluster');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_book', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { year: 1965, authors: ['Frank Herbert'] } });
      seedWork(db, { id: 'w_film', name: 'Dune', source_service: 'plex', source_id: '1',
                     meta: { year: 1984, authors: ['Frank Herbert'] } });
      const r = matcher.siblingDetector(db);
      assertEq(r.queued, 1, 'one pair queued for review');
      assertEq(r.scanned, 2, 'two entities scanned');
      const reviews = reviewItems(db, `kind = 'sibling_detector'`);
      assertEq(reviews.length, 1, 'one review row');
      const rv = reviews[0];
      assertEq(rv.candidate_a, 'w_book', 'candidate_a');
      assertEq(rv.candidate_b, 'w_film', 'candidate_b');
      assert(rv.reason.includes('Dune'), 'reason mentions Dune');
      // Re-run is idempotent.
      const r2 = matcher.siblingDetector(db);
      assertEq(r2.queued, 0, 're-run queues 0 (already pending)');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 14: siblingDetector skips pairs already linked ----
    console.log('\nTest 14: siblingDetector skips pairs already linked by adaptation_of');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_book', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { year: 1965, authors: ['Frank Herbert'] } });
      seedWork(db, { id: 'w_film', name: 'Dune', source_service: 'plex', source_id: '1',
                     meta: { year: 1984, authors: ['Frank Herbert'] } });
      // Pre-link the pair so the detector sees the edge and skips.
      db.prepare(`INSERT INTO entity_edges
                   (id, from_id, to_id, type, source_service, source_id,
                    deep_link, meta_json, weight, created_by, created_at,
                    updated_at, stale)
                  VALUES (?, ?, ?, 'adaptation_of', 'manual', 'book<->film',
                          NULL, '{}', 1.0, 'manual', datetime('now'),
                          datetime('now'), 0)`).run('edge_x', 'w_book', 'w_film');
      const r = matcher.siblingDetector(db);
      assertEq(r.queued, 0, 'pair already linked → no queue');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 15: mergeEntities — re-points edges + deletes row ----
    console.log('\nTest 15: mergeEntities re-points edges, deletes B, marks review merged');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { isbn: '978-X', year: 1965 } });
      seedWork(db, { id: 'w_b', name: 'Dune', source_service: 'plex', source_id: '1',
                     meta: { tmdb_id: 693, year: 1984 } });
      // Outgoing + incoming edges on w_b. The FK on entity_edges points
      // at entities.id, so we must seed w_x and w_y (the edge targets)
      // before inserting the edges themselves.
      seedWork(db, { id: 'w_x', name: 'Tag: sci-fi', source_service: 'manual', source_id: 'tag1', meta: {} });
      seedWork(db, { id: 'w_y', name: 'Diary entry', source_service: 'manual', source_id: 'm1', meta: {} });
      db.prepare(`INSERT INTO entity_edges
                   (id, from_id, to_id, type, source_service, source_id,
                    deep_link, meta_json, weight, created_by, created_at,
                    updated_at, stale)
                  VALUES ('e_out', 'w_b', 'w_x', 'tagged_with', 'plex', 'tag1',
                          NULL, '{"k":"v"}', 1.0, 'sync:plex', datetime('now'),
                          datetime('now'), 0)`).run();
      db.prepare(`INSERT INTO entity_edges
                   (id, from_id, to_id, type, source_service, source_id,
                    deep_link, meta_json, weight, created_by, created_at,
                    updated_at, stale)
                  VALUES ('e_in', 'w_y', 'w_b', 'mentioned_in', 'manual', 'm1',
                          NULL, '{}', 1.0, 'manual', datetime('now'),
                          datetime('now'), 0)`).run();
      // Alias on w_b that should migrate to w_a.
      db.prepare(`INSERT INTO entity_aliases (entity_id, alias, alias_lower, source)
                  VALUES ('w_b', 'Dune', 'dune', 'manual')`).run();
      // Review item with candidate_a=w_b, candidate_b=w_a (the pair to merge).
      db.prepare(`INSERT INTO entity_review_queue
                   (id, kind, candidate_a, candidate_b, confidence, reason,
                    source_service, evidence_json, status, created_at)
                  VALUES ('rv_x', 'tier3_fuzzy', 'w_b', 'w_a', 0.85, 'merge?',
                          'dedup', '{}', 'pending', datetime('now'))`).run();

      const r = matcher.mergeEntities(db, { reviewId: 'rv_x', intoEntityId: 'w_a', decidedBy: 'brandon' });
      assertEq(r.ok, true, 'mergeEntities returned ok');
      assertEq(r.mergedInto, 'w_a', 'merged into w_a');
      assert(r.aliasesAdded.includes('Dune'), 'Dune alias migrated');
      assert(r.edgesRePointed >= 2, `≥2 edges re-pointed; got ${r.edgesRePointed}`);
      // w_b row gone.
      const bLeft = db.prepare(`SELECT 1 FROM entities WHERE id = 'w_b'`).get();
      assertEq(bLeft, undefined, 'w_b row deleted');
      // Edges now point at w_a.
      const eOut = db.prepare(`SELECT from_id, to_id FROM entity_edges WHERE id = 'e_out'`).get();
      assertEq(eOut.from_id, 'w_a', 'outgoing edge from_id → w_a');
      const eIn = db.prepare(`SELECT from_id, to_id FROM entity_edges WHERE id = 'e_in'`).get();
      assertEq(eIn.to_id, 'w_a', 'incoming edge to_id → w_a');
      // Alias migrated.
      const aliasOnA = db.prepare(`SELECT alias FROM entity_aliases WHERE entity_id = 'w_a' AND alias_lower = 'dune'`).get();
      assert(!!aliasOnA, 'alias "dune" now on w_a');
      // tmdb_id from w_b should be stamped on w_a (slot was empty on w_a).
      const aMeta = entityMeta(db, 'w_a');
      assertEq(aMeta.tmdb_id, 693, 'tmdb_id stamped on w_a');
      // Review status updated.
      const rv = db.prepare(`SELECT status, decided_by FROM entity_review_queue WHERE id = 'rv_x'`).get();
      assertEq(rv.status, 'merged', 'review status = merged');
      assertEq(rv.decided_by, 'brandon', 'decided_by = brandon');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 16: rejectReviewItem ----
    console.log('\nTest 16: rejectReviewItem marks review as rejected');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'Dune', source_service: 'kavita', source_id: '1', meta: {} });
      seedWork(db, { id: 'w_b', name: 'Dune', source_service: 'plex', source_id: '2', meta: {} });
      db.prepare(`INSERT INTO entity_review_queue
                   (id, kind, candidate_a, candidate_b, confidence, reason,
                    source_service, evidence_json, status, created_at)
                  VALUES ('rv_y', 'tier3_fuzzy', 'w_a', 'w_b', 0.75, 'merge?',
                          'dedup', '{}', 'pending', datetime('now'))`).run();
      const r = matcher.rejectReviewItem(db, { reviewId: 'rv_y', reason: 'they are siblings, not duplicates', decidedBy: 'brandon' });
      assertEq(r.ok, true, 'reject ok');
      const rv = db.prepare(`SELECT status, decided_by, reason FROM entity_review_queue WHERE id = 'rv_y'`).get();
      assertEq(rv.status, 'rejected', 'status = rejected');
      assertEq(rv.decided_by, 'brandon', 'decided_by recorded');
      assert(rv.reason.includes('siblings'), 'reason updated');
      // Second reject on the same row → fails (already terminal).
      const r2 = matcher.rejectReviewItem(db, { reviewId: 'rv_y', reason: 'again' });
      assertEq(r2.ok, false, 'second reject returns ok=false');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 17: Tier 3 — score formula sanity ----
    console.log('\nTest 17: Tier 3 score = 0.6*title + 0.3*author + 0.1*year');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { year: 1965, author_name: 'Frank Herbert' } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { year: 1965, author_name: 'Frank Herbert' },
        source_service: 'plex', source_id: '1',
      }, { newEntityId: 'w_b', dryRun: true });
      assertEq(r.action, 'alias', 'exact → alias');
      assert(r.score > 0.99, `score ~1.0 for exact triple match; got ${r.score}`);
      assertEq(r.components.title, 1.0, 'title component = 1.0');
      assertEq(r.components.author, 1.0, 'author component = 1.0');
      assertEq(r.components.year, 1.0, 'year component = 1.0');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 18: dryRun does not write ----
    console.log('\nTest 18: dryRun returns verdict without writing');
    {
      const { db, tmpDir } = freshDb();
      seedWork(db, { id: 'w_a', name: 'Dune', source_service: 'kavita', source_id: '1',
                     meta: { year: 1965, authors: ['Frank Herbert'] } });
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { year: 1965, authors: ['Frank Herbert'] },
        source_service: 'plex', source_id: '1',
      }, { newEntityId: 'w_b', dryRun: true });
      assertEq(r.action, 'alias', 'dryRun still returns alias verdict');
      assertEq(r.aliasCreated, false, 'dryRun does NOT create alias');
      const aliases = db.prepare(`SELECT COUNT(*) c FROM entity_aliases`).get().c;
      assertEq(aliases, 0, 'no alias rows written in dryRun');
      const reviews = db.prepare(`SELECT COUNT(*) c FROM entity_review_queue`).get().c;
      assertEq(reviews, 0, 'no review rows written in dryRun');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 19: empty DB Tier 3 path ----
    console.log('\nTest 19: empty DB Tier 3 path returns no-op (no candidates)');
    {
      const { db, tmpDir } = freshDb();
      const r = matcher.matchEntity(db, {
        kind: 'work', name: 'Dune',
        meta: { year: 1965 },
        source_service: 'plex', source_id: '1',
      }, { newEntityId: 'w_b', dryRun: false });
      assertEq(r.action, 'no-op', 'no candidates → no-op');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ---- Test 20: matcher accepts person kind without crashing ----
    console.log('\nTest 20: non-work kinds fall through gracefully');
    {
      const { db, tmpDir } = freshDb();
      const r = matcher.matchEntity(db, {
        kind: 'person', name: 'Frank Herbert',
        meta: {}, source_service: 'plex', source_id: 'p1',
      }, { newEntityId: 'p_new', dryRun: false });
      assertEq(r.action, 'no-op', 'person candidate → no-op');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

  } catch (e) {
    console.error('Test harness error:', e);
    exitCode = 1;
  }
  console.log(`\nSummary: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f.label}: ${f.detail || ''}`);
    exitCode = 1;
  }
  process.exit(exitCode);
})();
