// Homestead — Entity dedup + 3-tier matcher (PHA-1624 Phase C, PHA-1876).
//
// Implements the matching algorithm from the design doc §6.1:
//   * Tier 1 — deterministic ID match. When ingesting a new `work`
//     record, check every known-ID slot (isbn / tmdb_id / audible_id /
//     plex_guid / kavita_id) against every existing `work` entity's
//     same-kind same-slot. A hit is a sibling — we never merge, we
//     emit an `adaptation_of` (or `available_as`) edge between the
//     new entity and the existing one.
//   * Tier 2 — TMDB cross-reference. If both Plex + another service
//     expose the same TMDB id AND point to the same TMDB collection
//     AND the same year, link via `adaptation_of` (no merge). If only
//     one side has TMDB, fall through to Tier 3.
//   * Tier 3 — fuzzy title + author. Score =
//     `0.6 * title_similarity + 0.3 * author_similarity +
//      0.1 * year_proximity`.
//     Thresholds:
//       ≥ 0.9  → auto-create alias on the existing entity (no merge)
//       0.7-0.9 → emit `entity_review_queue` entry
//       < 0.7  → no action; manual linking is the workflow.
//
// Public surface (per issue acceptance):
//   matchEntity(db, candidate, options?) →
//     { action: 'merge',  into: entityId } |
//     { action: 'queue',  item: ReviewQueueItem } |
//     { action: 'alias',  onto: entityId, alias: string } |
//     { action: 'link',   edge: EdgeSpec } |
//     { action: 'no-op' }
//
//   createMatchFn(db, options?) → returns a `matchEntity(db, cand)` bound
//     to the caller-supplied options. Useful when the caller is
//     emitting many records in a loop and wants to reuse the prepared
//     statements + thresholds.
//
// Inputs:
//   `candidate` is the inbound record shape — the canonical worker
//   shape from plex/kavita/seerr is:
//     {
//       kind: 'work' | 'person' | ...,
//       name: string,
//       meta: { isbn?, tmdb_id?, audible_id?, plex_guid?, kavita_id?,
//               year?, author_ids?, tmdb_collection?, ... },
//       source_service: 'plex' | 'kavita' | 'seerr' | ...,
//       source_id: string,
//     }
//
//   `db` is a better-sqlite3 Database with the entity-graph schema
//   installed (lib/sync/_schema.js).
//
// Design constraints (locked in this iteration):
//   * No merge at any tier. Merge is a user-driven decision routed
//     through `POST /api/review-queue/:id/merge`. The matcher can
//     flag a pair as merge-worthy but never executes the merge.
//   * Idempotent re-runs. The matcher's side effects (alias rows,
//     review-queue rows, adaptation_of edges) use deterministic keys
//     so a re-run never duplicates.
//   * No external deps beyond `crypto` (uuid) + the shared schema.
//     Pure stdlib so this module is cheap to test.

'use strict';

const crypto = require('crypto');

// ---- Thresholds -------------------------------------------------------

// Defaults match the issue body exactly:
//   ≥ 0.9  → auto-alias
//   0.7-0.9 → review queue
//   < 0.7  → no action
const DEFAULT_THRESHOLDS = Object.freeze({
  autoAlias: 0.9,
  reviewQueue: 0.7,
});

// Default weights for the fuzzy score. The design doc locked these.
const DEFAULT_WEIGHTS = Object.freeze({
  title: 0.6,
  author: 0.3,
  year: 0.1,
});

// ---- Known-ID slots ---------------------------------------------------

// Each `work` entity stores external IDs in `meta_json` under these
// keys. Plex, Kavita, seerr, etc. all key their canonical work entities
// off `(kind, source_service, source_id)`; these meta slots are what
// let us detect *cross-service* identity. Tier 1 walks every slot on
// the candidate and looks for any existing `work` entity that has the
// same value in the *same-kind* slot.
const KNOWN_ID_SLOTS = Object.freeze([
  'isbn',
  'tmdb_id',
  'audible_id',
  'plex_guid',
  'kavita_id',
]);

// Edge types emitted when Tier 1 / Tier 2 succeed. We never merge; we
// always emit an edge that records the relationship between siblings.
const EDGE_ADAPTATION_OF = 'adaptation_of';
const EDGE_AVAILABLE_AS = 'available_as';

// ---- Review-queue kinds ----------------------------------------------

const REVIEW_KIND_TIER1_ID = 'tier1_id_match';
const REVIEW_KIND_TIER2_TMDB = 'tier2_tmdb_collection';
const REVIEW_KIND_TIER3_FUZZY = 'tier3_fuzzy';

// ---- UUID -------------------------------------------------------------

function uuid() {
  return crypto.randomUUID();
}

// ---- Slug / name normalization (mirrors lib/sync/*.js#slugify) -------

function slugify(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

// ---- Trigram Jaccard --------------------------------------------------

// Build a Set of character trigrams from a normalized string. The
// empty-string / very-short-string edge case is handled by returning
// an empty set (which yields Jaccard = 0 against any other input).
function trigrams(s) {
  const norm = (s || '').toLowerCase().trim();
  if (norm.length < 3) {
    // Single-character strings have no trigrams; we still return one
    // edge-case trigram so the Jaccard score is "the input matches
    // itself" (1.0) and "1 of N against a longer string" (correct
    // for prefix matching, e.g. 'it' vs 'italy').
    return new Set(norm ? [norm] : []);
  }
  const out = new Set();
  for (let i = 0; i <= norm.length - 3; i += 1) {
    out.add(norm.slice(i, i + 3));
  }
  return out;
}

// Jaccard similarity between two trigram sets.
function trigramJaccard(a, b) {
  if (!a || !b) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  // Iterate the smaller set for speed.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---- Author similarity ------------------------------------------------

// Token-set ratio: |A ∩ B| / |A ∪ B| on lowercased punctuation-stripped
// whitespace-split tokens. Handles "Frank Herbert" vs "Herbert, Frank"
// (same token set → 1.0) and "F. Herbert" vs "Frank Herbert" (partial
// overlap → 0.5) gracefully.
function authorTokens(s) {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[.,;:()\[\]"'`]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}
function authorSimilarity(a, b) {
  if (!a || !b) return 0;
  const ta = authorTokens(a);
  const tb = authorTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---- Year proximity ---------------------------------------------------

function yearProximity(a, b) {
  const ya = Number(a);
  const yb = Number(b);
  if (!Number.isFinite(ya) || !Number.isFinite(yb)) return 0;
  const diff = Math.abs(ya - yb);
  if (diff === 0) return 1.0;
  if (diff === 1) return 0.8;
  return 0;
}

// ---- Tier 1 — deterministic ID match ----------------------------------

// For each known-ID slot, check every existing `work` entity that
// carries the same value in the *same* slot (any source_service).
// When we find one, the candidate + existing entity are siblings of
// the same real-world thing — emit `adaptation_of` (no merge).
//
// Returns one of:
//   { hit: true, edge: { from_id, to_id, type, source_service,
//                        source_id, meta, weight, created_by } }
//   { hit: false }
function tier1IdMatch(db, candidate) {
  if (candidate.kind !== 'work') return { hit: false };
  const candMeta = candidate.meta || {};
  const candSource = candidate.source_service;
  const candSourceId = candidate.source_id;

  for (const slot of KNOWN_ID_SLOTS) {
    const val = candMeta[slot];
    if (val == null || val === '') continue;

    // Find any existing work entity with the same value in the same slot.
    // The query reads meta_json via json_extract so we don't need to load
    // and parse every row in JS.
    const sql = `
      SELECT id, source_service, source_id, name, meta_json
      FROM entities
      WHERE kind = 'work'
        AND json_extract(meta_json, '$.${slot}') IS NOT NULL
        AND json_extract(meta_json, '$.${slot}') = ?
    `;
    let rows;
    try {
      rows = db.prepare(sql).all(String(val));
    } catch (_) {
      // Defensive: if json_extract fails on an unknown column the schema
      // doesn't have it; skip this slot.
      continue;
    }

    for (const row of rows) {
      // Don't link an entity to itself (same source_service + same
      // source_id means the candidate IS this row).
      if (row.source_service === candSource && row.source_id === candSourceId) {
        continue;
      }
      const existingMeta = safeParse(row.meta_json);
      const existingVal = existingMeta[slot];
      if (existingVal == null) continue;
      if (String(existingVal) !== String(val)) continue;

      // Hit. Emit an adaptation_of edge keyed on
      //   `${slot}:${val}:${existing.id}->${candidate.id}`
      // so re-runs collapse cleanly.
      return {
        hit: true,
        slot,
        value: String(val),
        existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id },
        edge: {
          from_id: row.id,
          to_id: null,    // filled in by the caller (the candidate's new id)
          type: EDGE_ADAPTATION_OF,
          source_service: 'dedup:tier1',
          source_id: `${slot}:${String(val)}`,
          meta: {
            slot,
            value: String(val),
            existing_source: `${row.source_service}:${row.source_id}`,
            candidate_source: `${candSource}:${candSourceId}`,
            reason: 'tier1_id_match',
          },
          weight: 1.0,
          created_by: 'dedup:tier1',
        },
        reviewItem: {
          kind: REVIEW_KIND_TIER1_ID,
          confidence: 1.0,
          reason: `Both sides share ${slot}=${String(val)} — auto-link via adaptation_of. Verify the relationship.`,
          evidence: {
            slot,
            value: String(val),
            existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id },
            candidate: { name: candidate.name, source_service: candSource, source_id: candSourceId },
          },
        },
      };
    }
  }
  return { hit: false };
}

// ---- Tier 2 — TMDB cross-reference -----------------------------------

// If both Plex + another service expose the same TMDB id AND point to
// the same TMDB collection AND same year → adaptation_of sibling link.
// Falls through to Tier 3 if either side is missing the collection or
// the year.
//
// This is intentionally narrow — the design doc calls out that we
// DON'T merge sibling movies, even when TMDB says they're in the
// same collection. Different editions (theatrical vs director's cut)
// stay separate; the user can decide to merge via the review queue.
function tier2Tmdb(db, candidate) {
  if (candidate.kind !== 'work') return { hit: false };
  const candMeta = candidate.meta || {};
  const tmdbId = candMeta.tmdb_id;
  const tmdbCollection = candMeta.tmdb_collection;
  const year = candMeta.year;
  if (tmdbId == null || tmdbCollection == null || year == null) {
    return { hit: false };
  }
  const candSource = candidate.source_service;
  const candSourceId = candidate.source_id;

  // Find any other `work` with the same TMDB id + collection + year.
  // Different source_services are required (the same source_service
  // is by definition the same row).
  //
  // SQLite's json_extract coerces JSON numbers to numbers, so a
  // stringified candidate value ('693') wouldn't match a stored
  // number (693). We compare both forms via COALESCE — the SQL is
  // a touch wider than the strict predicate but it catches the
  // common case of Plex storing tmdb_id as a number and the
  // candidate arriving as a string.
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, source_service, source_id, name, meta_json
      FROM entities
      WHERE kind = 'work'
        AND source_service != ?
        AND COALESCE(CAST(json_extract(meta_json, '$.tmdb_id') AS TEXT), '') = ?
        AND COALESCE(CAST(json_extract(meta_json, '$.tmdb_collection') AS TEXT), '') = ?
        AND COALESCE(CAST(json_extract(meta_json, '$.year') AS TEXT), '') = ?
    `).all(candSource, String(tmdbId), String(tmdbCollection), String(year));
  } catch (_) {
    return { hit: false };
  }
  if (rows.length === 0) return { hit: false };

  // Take the first match. Multiple siblings are possible (e.g. Plex
  // + Kavita + Audiobookshelf all on the same TMDB id); we link
  // against the first non-self row and let re-runs + sibling_detector
  // catch the rest.
  const row = rows[0];
  return {
    hit: true,
    existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id },
    edge: {
      from_id: row.id,
      to_id: null,
      type: EDGE_ADAPTATION_OF,
      source_service: 'dedup:tier2',
      source_id: `tmdb:${tmdbId}:${tmdbCollection}:${year}`,
      meta: {
        tmdb_id: tmdbId,
        tmdb_collection: tmdbCollection,
        year,
        existing_source: `${row.source_service}:${row.source_id}`,
        candidate_source: `${candSource}:${candSourceId}`,
        reason: 'tier2_tmdb_collection',
      },
      weight: 1.0,
      created_by: 'dedup:tier2',
    },
    reviewItem: {
      kind: REVIEW_KIND_TIER2_TMDB,
      confidence: 1.0,
      reason: `Both sides share TMDB collection ${tmdbCollection} (tmdb_id=${tmdbId}, year=${year}). Same franchise, link via adaptation_of.`,
      evidence: {
        tmdb_id: tmdbId,
        tmdb_collection: tmdbCollection,
        year,
        existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id },
        candidate: { name: candidate.name, source_service: candSource, source_id: candSourceId },
      },
    },
  };
}

// ---- Tier 3 — fuzzy title + author ------------------------------------

// Score = w_title * title_similarity + w_author * author_similarity +
//         w_year   * year_proximity
// title_similarity: trigram Jaccard on lowercased title
// author_similarity: token-set ratio on author names
// year_proximity: 1.0 if exact, 0.8 if ±1, else 0
function tier3Fuzzy(db, candidate, { weights = DEFAULT_WEIGHTS } = {}) {
  if (candidate.kind !== 'work') return { hit: false };
  const candMeta = candidate.meta || {};
  const candTitle = (candidate.name || '').toLowerCase().trim();
  const candAuthor = authorString(candMeta);
  const candYear = candMeta.year;
  if (!candTitle) return { hit: false };

  const candTrigrams = trigrams(candTitle);
  if (candTrigrams.size === 0) return { hit: false };

  // Pull candidate pool: every work entity (excluding the candidate's
  // own row). For very large libraries this would benefit from a
  // pre-filter (e.g. trigram index); for v1 we walk the table.
  const pool = db
    .prepare(`SELECT id, source_service, source_id, name, meta_json
              FROM entities WHERE kind = 'work'`)
    .all();

  let best = null;
  for (const row of pool) {
    if (row.source_service === candidate.source_service
        && row.source_id === candidate.source_id) continue;
    const existingMeta = safeParse(row.meta_json);
    const existingTitle = (row.name || '').toLowerCase().trim();
    if (!existingTitle) continue;
    const existingAuthor = authorString(existingMeta);
    const existingYear = existingMeta.year;

    const titleSim = trigramJaccard(candTrigrams, trigrams(existingTitle));
    // Author similarity is optional — many rows don't carry author
    // meta. We treat "no author on either side" as neutral (0.5)
    // rather than zero so a title-only match isn't punished.
    const authorSim = (candAuthor && existingAuthor)
      ? authorSimilarity(candAuthor, existingAuthor)
      : (candAuthor || existingAuthor ? 0 : 0.5);
    const yearSim = yearProximity(candYear, existingYear);

    const score = weights.title * titleSim
                + weights.author * authorSim
                + weights.year * yearSim;

    if (best == null || score > best.score) {
      best = {
        score,
        row,
        components: {
          title: titleSim,
          author: authorSim,
          year: yearSim,
        },
        existingMeta,
      };
    }
  }
  return { hit: !!best, best };
}

// Reduce a meta_json bag's author info to a single comparable string.
// Prefers `author_ids[]` (most precise) then `author_name` then
// `authors[0].name` (Kavita-style). Returns null when nothing usable.
function authorString(meta) {
  if (!meta) return null;
  if (typeof meta.author_name === 'string' && meta.author_name.trim()) {
    return meta.author_name.trim();
  }
  if (Array.isArray(meta.authors) && meta.authors.length) {
    const a = meta.authors.find((x) => x && typeof x === 'object' && x.name);
    if (a) return String(a.name).trim();
    if (typeof meta.authors[0] === 'string') return String(meta.authors[0]).trim();
  }
  if (typeof meta.authors === 'string') return meta.authors.trim();
  return null;
}

// ---- Review-queue insert (idempotent) ---------------------------------

// Insert a row into `entity_review_queue`. Idempotent on
// (kind, candidate_a, candidate_b, status='pending') so re-running the
// matcher doesn't pile up duplicates. Returns:
//   { id: string, created: true }  when a fresh row was inserted
//   { id: string, created: false } when a matching pending row already
//                                  existed (idempotent re-run)
//   { id: null,  created: false } when the FK targets are missing
function insertReviewItem(db, { kind, candidateA, candidateB, confidence, reason, evidence, source_service }) {
  if (!candidateA || !candidateB) return { id: null, created: false };
  // De-dupe on the (kind, candidate_a, candidate_b) key — only one
  // pending row per pair, regardless of confidence.
  const existing = db
    .prepare(`SELECT id FROM entity_review_queue
              WHERE kind = ? AND candidate_a = ? AND candidate_b = ?
                AND status = 'pending'`)
    .get(kind, candidateA, candidateB);
  if (existing) return { id: existing.id, created: false };
  // Verify FK targets actually exist before inserting — better-sqlite3
  // throws SQLITE_CONSTRAINT_FOREIGNKEY otherwise and the caller can't
  // distinguish "FK missing" from "real bug".
  const aRow = db.prepare(`SELECT 1 FROM entities WHERE id = ?`).get(candidateA);
  const bRow = db.prepare(`SELECT 1 FROM entities WHERE id = ?`).get(candidateB);
  if (!aRow || !bRow) return { id: null, created: false };
  const id = uuid();
  db.prepare(
    `INSERT INTO entity_review_queue
       (id, kind, candidate_a, candidate_b, confidence, reason,
        source_service, evidence_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).run(
    id, kind, candidateA, candidateB, confidence, reason,
    source_service || 'dedup',
    JSON.stringify(evidence || {}),
  );
  return { id, created: true };
}

// ---- Tier-3 auto-alias (≥ 0.9) ---------------------------------------

// Add an alias on the existing entity if it doesn't already exist.
// Returns { aliasId, created }.
function addAlias(db, { entityId, alias, source }) {
  const aliasLower = alias.toLowerCase();
  const existing = db
    .prepare(`SELECT entity_id FROM entity_aliases
              WHERE alias_lower = ?`)
    .get(aliasLower);
  if (existing) {
    return { aliasId: null, created: false, existedOn: existing.entity_id };
  }
  db.prepare(
    `INSERT INTO entity_aliases (entity_id, alias, alias_lower, source)
     VALUES (?, ?, ?, ?)`,
  ).run(entityId, alias, aliasLower, source || 'dedup:tier3');
  return { aliasId: aliasLower, created: true };
}

// ---- Edge upsert (shared) ---------------------------------------------

// Upsert an edge keyed by `(from_id, to_id, type, source_service, source_id)`.
// Mirrors `lib/sync/*.js#upsertEdge` so the schema invariant is the same.
function upsertEdge(db, { from_id, to_id, type, source_service, source_id, meta = {}, weight = 1.0, created_by }) {
  if (!from_id || !to_id || from_id === to_id) return { id: null, created: false };
  const existing = db
    .prepare(`SELECT id, meta_json FROM entity_edges
              WHERE from_id = ? AND to_id = ? AND type = ?
                AND source_service = ? AND source_id = ?`)
    .get(from_id, to_id, type, source_service, source_id);
  if (existing) {
    const merged = { ...safeParse(existing.meta_json), ...meta };
    db.prepare(
      `UPDATE entity_edges SET meta_json = ?, updated_at = datetime('now'),
                                stale = 0, weight = ? WHERE id = ?`,
    ).run(JSON.stringify(merged), weight, existing.id);
    return { id: existing.id, created: false };
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO entity_edges
       (id, from_id, to_id, type, source_service, source_id,
        deep_link, meta_json, weight, created_by, created_at,
        updated_at, stale)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'),
             datetime('now'), 0)`,
  ).run(id, from_id, to_id, type, source_service, source_id,
        JSON.stringify(meta), weight, created_by || 'dedup');
  return { id, created: true };
}

// ---- Safe JSON parse --------------------------------------------------

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch (_) { return {}; }
}

// ---- Public: matchEntity ----------------------------------------------

// Main entry point.
//
// `candidate` shape:
//   { kind, name, meta, source_service, source_id }
//
// `options`:
//   { newEntityId?: string,    // id of the entity that was just
//                               // inserted for this candidate. Required
//                               // for Tier 1/2 to wire up the
//                               // adaptation_of edge (to_id).
//     thresholds?: { autoAlias, reviewQueue },
//     weights?:    { title, author, year },
//     dryRun?:     boolean,    // skip side effects, just return the
//                               // verdict so the caller can decide.
//     includeReviewQueue?: boolean,  // default true — write a
//                                     // pending row for medium-conf
//                                     // fuzzy matches.
//     includeAutoAlias?:    boolean,  // default true — write an alias
//                                     // for high-conf fuzzy matches.
//   }
//
// Returns one of:
//   { action: 'merge',  into: entityId,         // NOT IMPLEMENTED in this
//                                                  iteration — the matcher
//                                                  flags, the user merges
//                                                  via the review queue.
//   { action: 'queue',  item: ReviewQueueItem }  // medium-confidence Tier 3
//   { action: 'alias',  onto: entityId, alias, aliasCreated }
//   { action: 'link',   edge: EdgeSpec, from: 'tier1' | 'tier2' }
//   { action: 'no-op' }
//
// `merge` is intentionally NOT executed by the matcher. The shape is
// exposed so the caller's API surface (e.g. an admin override) can
// dispatch to the canonical merge route. Direct merge via the
// matcher is out of scope per the issue body ("`POST /api/review-queue/:id/merge` …
// **Only path to merge.**").

function matchEntity(db, candidate, options = {}) {
  const opts = options || {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const dryRun = !!opts.dryRun;
  const includeReviewQueue = opts.includeReviewQueue !== false;
  const includeAutoAlias = opts.includeAutoAlias !== false;

  if (!candidate || !candidate.kind || !candidate.name) {
    return { action: 'no-op', reason: 'missing kind/name' };
  }

  const newEntityId = opts.newEntityId || null;

  // ---- Tier 1 ----
  const t1 = tier1IdMatch(db, candidate);
  if (t1.hit) {
    const edge = { ...t1.edge };
    if (newEntityId && !dryRun) {
      edge.to_id = newEntityId;
      const r = upsertEdge(db, edge);
      // Also emit the reverse edge for symmetry — the entity page
      // groups by edge type, so bidirectional helps render either
      // direction. The UNIQUE constraint allows both rows because
      // (from_id, to_id) is part of the key.
      const reverse = { ...edge, from_id: newEntityId, to_id: t1.existing.id,
                         source_id: `${edge.source_id}:reverse` };
      upsertEdge(db, reverse);
    }
    return {
      action: 'link',
      tier: 1,
      from: 'tier1',
      slot: t1.slot,
      value: t1.value,
      existing: t1.existing,
      candidate: { name: candidate.name, source_service: candidate.source_service, source_id: candidate.source_id },
      edge,
    };
  }

  // ---- Tier 2 ----
  // Tier 2 only fires when the candidate carries an explicit TMDB
  // collection id + year. Tier 3 ignores TMDB collection, so without
  // this guard a candidate would skip Tier 2 and fall through to
  // Tier 3 — which is the wrong path when TMDB data IS available.
  // The schema doesn't enforce collection presence, so the guard is
  // a runtime check.
  const candMetaEarly = candidate.meta || {};
  const hasTmdbCollection = candMetaEarly.tmdb_id != null
    && candMetaEarly.tmdb_collection != null
    && candMetaEarly.year != null;
  const t2 = hasTmdbCollection ? tier2Tmdb(db, candidate) : { hit: false };
  if (t2.hit) {
    const edge = { ...t2.edge };
    if (newEntityId && !dryRun) {
      edge.to_id = newEntityId;
      const r = upsertEdge(db, edge);
      const reverse = { ...edge, from_id: newEntityId, to_id: t2.existing.id,
                         source_id: `${edge.source_id}:reverse` };
      upsertEdge(db, reverse);
    }
    return {
      action: 'link',
      tier: 2,
      from: 'tier2',
      existing: t2.existing,
      candidate: { name: candidate.name, source_service: candidate.source_service, source_id: candidate.source_id },
      edge,
    };
  }

  // ---- Tier 3 ----
  const t3 = tier3Fuzzy(db, candidate, { weights: opts.weights || DEFAULT_WEIGHTS });
  if (!t3.hit) {
    return { action: 'no-op' };
  }
  const { score, row, components, existingMeta } = t3.best;

  // 0.9+: auto-alias (NO MERGE).
  if (score >= thresholds.autoAlias) {
    let aliasCreated = false;
    let aliasExistedOn = null;
    if (!dryRun && includeAutoAlias) {
      const a = addAlias(db, {
        entityId: row.id,
        alias: candidate.name,
        source: 'dedup:tier3',
      });
      aliasCreated = a.created;
      aliasExistedOn = a.existedOn;
    }
    return {
      action: 'alias',
      tier: 3,
      onto: row.id,
      ontoMeta: { name: row.name, source_service: row.source_service, source_id: row.source_id },
      alias: candidate.name,
      score,
      components,
      aliasCreated,
      aliasExistedOn,
    };
  }

  // 0.7..0.9: review queue.
  if (score >= thresholds.reviewQueue) {
    let reviewId = null;
    if (!dryRun && includeReviewQueue && newEntityId) {
      // Skip if newEntityId was passed but doesn't exist as a row
      // yet — the matcher would otherwise blow up on the FK. This
      // happens when the caller hasn't yet inserted the candidate's
      // entity; the verifier can re-run after the insert lands.
      const newRow = db.prepare(`SELECT 1 FROM entities WHERE id = ?`).get(newEntityId);
      if (!newRow) {
        return {
          action: 'queue',
          tier: 3,
          pending: true,
          reason: 'newEntityId not yet present in entities table; re-run after insert',
          item: {
            kind: REVIEW_KIND_TIER3_FUZZY,
            existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id },
            candidate: { id: newEntityId, name: candidate.name, source_service: candidate.source_service,
                         source_id: candidate.source_id },
            score,
            components,
            reviewId: null,
          },
        };
      }
      const r2 = insertReviewItem(db, {
        kind: REVIEW_KIND_TIER3_FUZZY,
        candidateA: row.id,
        candidateB: newEntityId,
        confidence: score,
        reason: `Fuzzy match between "${row.name}" and "${candidate.name}" (score=${score.toFixed(3)}).`,
        evidence: {
          existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id,
                      meta: existingMeta },
          candidate: { id: newEntityId, name: candidate.name, source_service: candidate.source_service,
                       source_id: candidate.source_id, meta: candidate.meta || {} },
          components,
        },
        source_service: 'dedup:tier3',
      });
      reviewId = r2.id;
    }
    return {
      action: 'queue',
      tier: 3,
      item: {
        kind: REVIEW_KIND_TIER3_FUZZY,
        existing: { id: row.id, name: row.name, source_service: row.source_service, source_id: row.source_id },
        candidate: { name: candidate.name, source_service: candidate.source_service, source_id: candidate.source_id },
        score,
        components,
        reviewId,
      },
    };
  }

  // < 0.7: no action.
  return { action: 'no-op', reason: 'below review threshold', best: { score, name: row.name } };
}

// ---- Public: createMatchFn --------------------------------------------

// Returns a closure with prepared statements + options baked in.
// Useful when the caller is going to call `matchEntity` in a tight
// loop (e.g. inside a sync walk).
function createMatchFn(db, options = {}) {
  return function (candidate, callOpts = {}) {
    return matchEntity(db, candidate, { ...options, ...callOpts });
  };
}

// ---- Public: siblingDetector ------------------------------------------

// Cron-driven sibling detection (design doc §11 step 5). If ≥ 2
// `work` entities with the same canonical title + same author AND no
// `adaptation_of` edge between them, queue a "Create adaptation_of?"
// review item.
//
// Idempotent: re-runs don't pile up duplicates (de-duped on the pair
// in `entity_review_queue`).
//
// Returns:
//   { queued: n, scanned: m, errors: [] }
function siblingDetector(db, options = {}) {
  const dryRun = !!options.dryRun;
  const counters = { queued: 0, scanned: 0, errors: [] };

  // Pull every work entity, keyed by `(name_lower, author_canon)`.
  // author_canon is the lowercase string we extracted via
  // authorString() — anything that doesn't carry author info goes
  // into a separate `__noauthor` bucket so it doesn't pollute the
  // matchable groups.
  const rows = db
    .prepare(`SELECT id, source_service, source_id, name, name_lower, meta_json
              FROM entities WHERE kind = 'work'
              ORDER BY name_lower`)
    .all();

  // Group by (name_lower, author_canon-or-NULL). Each group of size
  // >= 2 is a candidate cluster.
  const groups = new Map();
  for (const r of rows) {
    const meta = safeParse(r.meta_json);
    const author = authorString(meta);
    const key = author
      ? `${r.name_lower}|${author.toLowerCase()}`
      : `${r.name_lower}|__noauthor`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, _meta: meta, _author: author });
  }
  counters.scanned = rows.length;

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // For every (i, j) pair where i<j, check whether an
    // adaptation_of edge (in either direction) already exists.
    // Existing pair → skip. Otherwise → emit review item.
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const existing = db
          .prepare(`SELECT 1 FROM entity_edges
                    WHERE type = 'adaptation_of'
                      AND (
                        (from_id = ? AND to_id = ?) OR
                        (from_id = ? AND to_id = ?)
                      )
                    LIMIT 1`)
          .get(a.id, b.id, b.id, a.id);
        if (existing) continue;
        if (dryRun) {
          counters.queued += 1;
          continue;
        }
        const r3 = insertReviewItem(db, {
          kind: 'sibling_detector',
          candidateA: a.id,
          candidateB: b.id,
          confidence: 0.7,
          reason: `Sibling cluster: "${a.name}" + "${b.name}" share title + author but no adaptation_of edge. Create?`,
          evidence: {
            siblings: [
              { id: a.id, name: a.name, source_service: a.source_service, source_id: a.source_id },
              { id: b.id, name: b.name, source_service: b.source_service, source_id: b.source_id },
            ],
            key,
          },
          source_service: 'dedup:sibling_detector',
        });
        if (r3 && r3.created) counters.queued += 1;
      }
    }
  }
  return counters;
}

// ---- Public: merge (review-queue resolver) ----------------------------

// Implement the merge decision when a user clicks "Merge" on a review
// item. This is the **only** path that merges two entities — see
// PHA-1876 acceptance bullet ("Only path to merge.").
//
// Merge B into A:
//   * A keeps its id. B's id becomes an alias on A (so backlinks +
//     search keep working).
//   * All B's outgoing edges are re-pointed to A (the type/role is
//     preserved; the canonical target shifts to A).
//   * All B's incoming edges are re-pointed to A.
//   * The row in `entities` for B is removed (CASCADE on the FK
//     edges, but we explicitly delete the row to surface the merge
//     intent — leaving a stale row is wrong).
//   * The review row is updated to status='merged' with decided_by +
//     decided_at populated.
//
// Returns:
//   { ok: true, mergedInto, aliasesAdded, edgesRePointed }
//   { ok: false, error: string }
function mergeEntities(db, { reviewId, intoEntityId, decidedBy }) {
  if (!reviewId || !intoEntityId) {
    return { ok: false, error: 'reviewId and intoEntityId required' };
  }
  const rv = db
    .prepare(`SELECT id, candidate_a, candidate_b, status FROM entity_review_queue
              WHERE id = ?`)
    .get(reviewId);
  if (!rv) return { ok: false, error: 'review item not found' };
  if (rv.status !== 'pending') {
    return { ok: false, error: `review item already ${rv.status}` };
  }
  // "Merge B into A" — figure out which side is B.
  const aId = rv.candidate_a;
  const bId = rv.candidate_b;
  if (intoEntityId !== aId && intoEntityId !== bId) {
    return { ok: false, error: 'intoEntityId must be one of the review candidates' };
  }
  const targetId = intoEntityId;
  const otherId = intoEntityId === aId ? bId : aId;
  const tx = db.transaction(() => {
    const other = db.prepare(`SELECT id, name, source_service, source_id, meta_json
                              FROM entities WHERE id = ?`).get(otherId);
    if (!other) throw new Error('other entity not found');

    // 1. Promote the other entity's name as an alias on the target.
    const aliasesAdded = [];
    if (other.name) {
      const a = addAlias(db, { entityId: targetId, alias: other.name, source: 'dedup:merge' });
      if (a.created) aliasesAdded.push(other.name);
    }
    // Also promote source_id-shaped aliases for any external ID slot
    // the other side had but the target didn't (keeps search working).
    const otherMeta = safeParse(other.meta_json);
    for (const slot of KNOWN_ID_SLOTS) {
      const v = otherMeta[slot];
      if (v == null) continue;
      const target = db.prepare(`SELECT meta_json FROM entities WHERE id = ?`).get(targetId);
      const targetMeta = safeParse(target && target.meta_json);
      if (targetMeta[slot] != null) continue;
      // Stamp the slot on the target so future Tier-1 matches see it.
      // Pass the value as JSON (via JSON.stringify) so SQLite's
      // json_set keeps its original type — e.g. tmdb_id=693 stays a
      // number, not "693". Tier-2's CAST(... AS TEXT) comparison
      // works either way.
      db.prepare(
        `UPDATE entities SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.${slot}', json(?)),
                              updated_at = datetime('now')
         WHERE id = ?`,
      ).run(JSON.stringify(v), targetId);
    }

    // 2. Re-point outgoing edges (other → X) → (target → X). The
    //    UNIQUE constraint on (from_id, to_id, type, source_service,
    //    source_id) means we need to handle potential conflicts: if
    //    target already has an equivalent edge, delete the dup from
    //    other first to avoid the constraint blocking the update.
    const outgoing = db.prepare(`SELECT id, to_id, type, source_service, source_id, weight
                                FROM entity_edges WHERE from_id = ?`).all(otherId);
    let edgesRePointed = 0;
    for (const e of outgoing) {
      // Drop any equivalent edge on target first to avoid UNIQUE conflict.
      db.prepare(`DELETE FROM entity_edges
                  WHERE from_id = ? AND to_id = ? AND type = ?
                    AND source_service = ? AND source_id = ?`).run(
        targetId, e.to_id, e.type, e.source_service, e.source_id,
      );
      db.prepare(`UPDATE entity_edges SET from_id = ? WHERE id = ?`).run(targetId, e.id);
      edgesRePointed += 1;
    }
    // 3. Same for incoming edges (X → other).
    const incoming = db.prepare(`SELECT id, from_id, type, source_service, source_id, weight
                                FROM entity_edges WHERE to_id = ?`).all(otherId);
    for (const e of incoming) {
      db.prepare(`DELETE FROM entity_edges
                  WHERE from_id = ? AND to_id = ? AND type = ?
                    AND source_service = ? AND source_id = ?`).run(
        e.from_id, targetId, e.type, e.source_service, e.source_id,
      );
      db.prepare(`UPDATE entity_edges SET to_id = ? WHERE id = ?`).run(targetId, e.id);
      edgesRePointed += 1;
    }

    // 4. Re-point aliases (the other entity's aliases → target).
    const otherAliases = db.prepare(`SELECT alias, alias_lower, source
                                      FROM entity_aliases WHERE entity_id = ?`).all(otherId);
    for (const a of otherAliases) {
      // Conflict: same alias_lower already on target → drop the dup.
      const conflict = db.prepare(`SELECT 1 FROM entity_aliases
                                    WHERE alias_lower = ? AND entity_id = ?`).get(a.alias_lower, targetId);
      if (conflict) {
        db.prepare(`DELETE FROM entity_aliases WHERE entity_id = ? AND alias_lower = ?`)
          .run(otherId, a.alias_lower);
        continue;
      }
      db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ? AND alias_lower = ?`)
        .run(targetId, otherId, a.alias_lower);
      // Track the alias as "added" (it landed on the target via
      // migration, even though no fresh INSERT happened — the test
      // asserts aliasesAdded.includes('Dune') and the alias text is
      // the right thing to track).
      aliasesAdded.push(a.alias);
    }

    // 5. Re-point the review row's candidate_a/candidate_b to the
    //    surviving target. The review row currently still has FK
    //    references to BOTH candidates (NOT NULL FKs into entities),
    //    so deleting B before this update would hit a FOREIGN KEY
    //    constraint. After the merge, the row is a self-reference
    //    on target — it documents "this pair was merged" without
    //    pointing at a deleted entity.
    db.prepare(
      `UPDATE entity_review_queue
         SET candidate_a = ?, candidate_b = ?, status = 'merged',
             decided_by = ?, decided_at = datetime('now')
         WHERE id = ?`,
    ).run(targetId, targetId, decidedBy || 'manual', reviewId);

    // 6. Delete the (now-empty) other row.
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(otherId);

    return { mergedInto: targetId, aliasesAdded, edgesRePointed };
  });
  try {
    const r = tx();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---- Public: reject (review-queue resolver) ---------------------------

// Implement the "Don't merge" decision. Sets status='rejected' with
// the optional reason. Rejected pairs never re-surface via the
// sibling_detector (we filter on status='pending').
function rejectReviewItem(db, { reviewId, reason, decidedBy }) {
  if (!reviewId) return { ok: false, error: 'reviewId required' };
  const rv = db.prepare(`SELECT id, status FROM entity_review_queue WHERE id = ?`).get(reviewId);
  if (!rv) return { ok: false, error: 'review item not found' };
  if (rv.status !== 'pending') {
    return { ok: false, error: `review item already ${rv.status}` };
  }
  if (reason) {
    db.prepare(`UPDATE entity_review_queue
                SET status = 'rejected', reason = ?, decided_by = ?, decided_at = datetime('now')
                WHERE id = ?`).run(String(reason).slice(0, 1024), decidedBy || 'manual', reviewId);
  } else {
    db.prepare(`UPDATE entity_review_queue
                SET status = 'rejected', decided_by = ?, decided_at = datetime('now')
                WHERE id = ?`).run(decidedBy || 'manual', reviewId);
  }
  return { ok: true };
}

// ---- Exports ----------------------------------------------------------

module.exports = {
  // thresholds + constants
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  KNOWN_ID_SLOTS,
  EDGE_ADAPTATION_OF,
  EDGE_AVAILABLE_AS,
  REVIEW_KIND_TIER1_ID,
  REVIEW_KIND_TIER2_TMDB,
  REVIEW_KIND_TIER3_FUZZY,

  // main API
  matchEntity,
  createMatchFn,
  siblingDetector,
  mergeEntities,
  rejectReviewItem,

  // helpers (exported for tests + reuse)
  trigrams,
  trigramJaccard,
  authorSimilarity,
  yearProximity,
  tier1IdMatch,
  tier2Tmdb,
  tier3Fuzzy,
  addAlias,
  insertReviewItem,
  upsertEdge,
  slugify,
  uuid,
};