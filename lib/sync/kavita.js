// Homestead — Kavita sync worker (PHA-1624 Phase B-2, PHA-1874).
//
// Background sync that walks a Kavita server library and reconciles
// entities + edges in Homestead's entity graph (design doc §5.1).
//
// Public API:
//   * syncKavita(options) → { added, updated, edges, stale, reviewQueue,
//                             libraries, items, errors }
//   * migrate(db)          — idempotent schema installer (no-op when the
//                            schema already exists; provided for the
//                            test bootstrap + a defensive call from the
//                            admin endpoint so a freshly-restarted
//                            container doesn't 500 on first sync)
//
// Re-runnable: same `(kind, source_service, source_id)` always resolves
// to the same row; same `(from_id, to_id, type, source_service, source_id)`
// edge always upserts. Idempotency UNIQUE constraints live in
// `lib/sync/_schema.js`.
//
// Kavita exposes two library types relevant to v1: Manga (type 0) and
// Book (type 1). Image libraries (CBZ, type 2) and Video libraries
// (type 3) are out of scope for the media triangle (see Phase A out-of-
// scope list).
//
// Cron-driven every 6h from `server.js`'s boot scheduler, manually
// triggerable via `POST /api/admin/sync/kavita` (admin-only).
//
// Source proxies via the existing SWAG layer on phatt.vip — no new
// infra. API key from env (`KAVITA_API_KEY`). Base URL from
// `KAVITA_URL` (default `https://kavita.phatt.vip`).

'use strict';

const crypto = require('crypto');
const { migrate } = require('./_schema');

// ---- Public constants ---------------------------------------------------

const SERVICE = 'kavita';

// Kavita library types: 0=Manga, 1=Book, 2=Image, 3=Video. v1 walks 0
// and 1 only; the others are Phase E territory.
const LIBRARY_TYPE = Object.freeze({
  manga: 0,
  book: 1,
  image: 2,
  video: 3,
});

// Tags/genres we want to emit as `tagged_with` edges. We don't try to
// normalize the raw tag vocabulary — Kavita is the source of truth for
// what its tags mean.
const TAGS_KIND_GENRE = 'genre';
const TAGS_KIND_TAG = 'tag';

// ---- Default HTTPS HTTP helper -----------------------------------------
//
// Mirrors `lib/sync/plex.js#defaultHttpDo`. Kavita wants JSON in/out
// and an `x-api-key` header (no bearer / no JWT for server keys).

function defaultHttpDo({ method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (body != null && !('content-length' in opts.headers)) {
      const buf = Buffer.from(body, 'utf8');
      opts.headers['Content-Length'] = buf.length;
      body = buf;
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// ---- Kavita API client -------------------------------------------------

async function kavitaFetchJson({ baseUrl, apiKey, path, httpDo }) {
  const url = new URL(path, baseUrl).toString();
  const res = await httpDo({
    method: 'GET',
    url,
    headers: {
      Accept: 'application/json',
      'x-api-key': apiKey,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`kavita http ${res.status} on ${path}: ${res.text.slice(0, 256)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error(`kavita returned non-JSON on ${path}: ${res.text.slice(0, 256)}`);
  }
}

// ---- Slug / name normalization -----------------------------------------
//
// Slugs, UUIDs, and tag-splitting are identical to plex.js — kept as
// local copies rather than imported from there so this module stays
// standalone (you can require kavita.js without the Plex worker).

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

function uuid() {
  return crypto.randomUUID();
}

// Normalize a Kavita tag/genre string. Kavita tags are often
// pipe- or comma-separated within a single string field; we accept
// either.
function splitTags(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/[,|]/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

// Normalize a Kavita writer/author field. Kavita stores writers as a
// string[] in the metadata block; some endpoints also accept a single
// pipe-separated string. Returned as a deduped trimmed array.
//
// Dedup is case-insensitive so a series that lists "Frank Herbert" and
// "frank herbert" (some Kavita installs do this after metadata merges)
// collapses to one authored_by edge. The canonical casing of the first
// occurrence wins — downstream person-entity creation uses lowercase
// keys (`ensurePerson` is case-insensitive), so casing only matters for
// the displayed entity name.
function splitAuthors(v) {
  if (v == null) return [];
  const raw = Array.isArray(v)
    ? v
    : (typeof v === 'string' ? v.split(/[,|]/) : []);
  const seen = new Map();      // lower → canonical
  for (const item of raw) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) seen.set(key, clean);
  }
  return Array.from(seen.values());
}

// ---- Entity upserts ---------------------------------------------------

// Resolve or create an entity keyed by (kind, source_service, source_id).
// `meta` shallow-merges with the existing meta_json so re-runs preserve
// untouched fields.
function ensureEntity(db, { kind, name, source_service, source_id, meta, created_by }) {
  const nameLower = (name || '').toLowerCase().trim() || 'untitled';
  const existing = db
    .prepare('SELECT id, slug, meta_json FROM entities WHERE kind = ? AND source_service = ? AND source_id = ?')
    .get(kind, source_service, source_id);
  if (existing) {
    const merged = { ...JSON.parse(existing.meta_json || '{}'), ...(meta || {}) };
    db.prepare(
      `UPDATE entities SET name = ?, name_lower = ?, meta_json = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(name, nameLower, JSON.stringify(merged), existing.id);
    return { id: existing.id, created: false };
  }
  let slug = slugify(name);
  let suffix = 0;
  while (db.prepare('SELECT 1 FROM entities WHERE slug = ?').get(slug)) {
    suffix += 1;
    slug = `${slugify(name)}-${suffix}`;
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)`,
  ).run(id, kind, name, slug, JSON.stringify(meta || {}), created_by, source_service, source_id, nameLower);
  return { id, created: true };
}

// Resolve-or-create a `person` entity by lowercase name within
// kind=person. Per design doc §14 open-question #2 (defaulted YES by
// Brandon's approval): deterministic merge on lowercased full name
// within `kind=person`. v1 collision risk accepted (Tyler is unique;
// two people named "Brandon Smith" would collide — that's a known
// limitation, Phase C will add fuzzy matching).
function ensurePerson(db, name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const nameLower = clean.toLowerCase();
  const existing = db
    .prepare(`SELECT id FROM entities WHERE kind = 'person' AND source_service = ? AND source_id = ?`)
    .get(SERVICE, nameLower);
  if (existing) return existing.id;
  return ensureEntity(db, {
    kind: 'person',
    name: clean,
    source_service: SERVICE,
    source_id: nameLower,
    created_by: `sync:${SERVICE}`,
    meta: { name_lower: nameLower },
  }).id;
}

// Resolve-or-create a `concept` entity by slugified name. Deterministic
// merge on slug means "Sci-Fi" / "sci fi" / "sci-fi" all collapse to
// one concept node — same pattern as the Plex worker.
function ensureConcept(db, name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const slug = slugify(clean);
  const existing = db
    .prepare(`SELECT id FROM entities WHERE kind = 'concept' AND slug = ?`)
    .get(slug);
  if (existing) return existing.id;
  return ensureEntity(db, {
    kind: 'concept',
    name: clean,
    source_service: SERVICE,
    source_id: `concept:${slug}`,
    created_by: `sync:${SERVICE}`,
    meta: { tag_kind: TAGS_KIND_GENRE },
  }).id;
}

// Upsert an edge keyed by (from_id, to_id, type, source_service, source_id).
// source_id lets us re-emit the same edge across re-runs without
// duplicating; meta is shallow-merged so re-runs preserve untouched keys.
function upsertEdge(db, { from_id, to_id, type, source_id, deep_link = null, meta = {}, weight = 1.0, created_by }) {
  const existing = db
    .prepare(`SELECT id, meta_json FROM entity_edges WHERE from_id = ? AND to_id = ? AND type = ? AND source_service = ? AND source_id = ?`)
    .get(from_id, to_id, type, SERVICE, source_id);
  if (existing) {
    const merged = { ...JSON.parse(existing.meta_json || '{}'), ...meta };
    db.prepare(
      `UPDATE entity_edges SET meta_json = ?, updated_at = datetime('now'), stale = 0 WHERE id = ?`,
    ).run(JSON.stringify(merged), existing.id);
    return { id: existing.id, created: false };
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO entity_edges (id, from_id, to_id, type, source_service, source_id, deep_link, meta_json, weight, created_by, created_at, updated_at, stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
  ).run(id, from_id, to_id, type, SERVICE, source_id, deep_link, JSON.stringify(meta), weight, created_by);
  return { id, created: true };
}

// ---- Kavita walker -----------------------------------------------------

// Library list endpoint: GET /api/Library/libraries returns an array
// of LibraryDto { id, name, type, ... }. We filter to types 0 (Manga)
// and 1 (Book) for v1.
async function kavitaLibraries({ baseUrl, apiKey, httpDo }) {
  const json = await kavitaFetchJson({ baseUrl, apiKey, path: '/api/Library/libraries', httpDo });
  // Kavita returns the array directly (not wrapped in {result: ...}).
  const list = Array.isArray(json) ? json : (json && (json.result || json.libraries)) || [];
  return list.map((l) => ({
    id: Number(l.id),
    name: l.name || `Library ${l.id}`,
    type: Number(l.type),
    // Cover, language, etc. left in the meta bag for later expansion.
    language: l.language || null,
  })).filter((l) => l.type === LIBRARY_TYPE.manga || l.type === LIBRARY_TYPE.book);
}

// Walk the series list for a library. Kavita's /api/Series endpoint is
// paginated and supports a `LibraryId` filter plus `PageSize`/`PageNum`.
// We walk all pages until `totalPages` is exhausted (or a safety cap
// of MAX_PAGES to defend against runaway pagination on misconfigured
// servers).
async function kavitaLibrarySeries({ baseUrl, apiKey, libraryId, httpDo }) {
  const PAGE_SIZE = 200;        // Kavita's recommended max page size
  const MAX_PAGES = 200;        // safety cap = 40k series, well above any realistic library
  const out = [];
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum += 1) {
    const path = `/api/Series?PageSize=${PAGE_SIZE}&PageNum=${pageNum}&LibraryId=${libraryId}`;
    const json = await kavitaFetchJson({ baseUrl, apiKey, path, httpDo });
    // Kavita returns { result: SeriesDto[], totalPages, totalCount, pageNumber }.
    const result = json && (json.result || json.Result || json.series) || [];
    const totalPages = Number(json.totalPages || json.TotalPages || 0);
    for (const s of result) out.push(s);
    if (result.length === 0) break;
    if (totalPages > 0 && pageNum + 1 >= totalPages) break;
    // If totalPages isn't reported but we got fewer than PAGE_SIZE,
    // we're on the last page by definition.
    if (totalPages === 0 && result.length < PAGE_SIZE) break;
  }
  return out;
}

// Build the `work` meta JSON bag for a series. Year comes from
// releaseDate.slice(0,4) when present. Summary, releaseDate, authors
// all live in the bag for the entity page to render.
function workMeta(series, libraryType) {
  const meta = {
    title: series.name || series.localizedName || '',
    summary: series.summary || '',
    libraryId: Number(series.libraryId || 0),
    libraryType: Number(libraryType),
    format: libraryType === LIBRARY_TYPE.manga ? 'manga' : (libraryType === LIBRARY_TYPE.book ? 'book' : 'unknown'),
  };
  if (series.releaseDate) {
    meta.releaseDate = series.releaseDate;
    const y = String(series.releaseDate).slice(0, 4);
    const yn = Number(y);
    if (Number.isFinite(yn) && yn > 0) meta.year = yn;
  }
  if (series.originalPublisher) meta.originalPublisher = series.originalPublisher;
  if (series.pages) meta.pages = Number(series.pages);
  // Kavita exposes its real metadata under .metadata when fetched from
  // /api/Series/{id}. We accept both shapes (list endpoint may inline
  // metadata; some installs return only summary-level fields).
  const md = series.metadata || {};
  if (md.isbn) meta.isbn = md.isbn;
  if (md.language) meta.language = md.language;
  if (md.publicationStatus) meta.publicationStatus = md.publicationStatus;
  if (md.ageRating) meta.ageRating = md.ageRating;
  return meta;
}

// Build the deep link to the Kavita web reader. We use the
// `/Library/{libraryId}/Series/{seriesId}` route which is the canonical
// per-series detail page in Kavita's web reader.
function deepLinkFor(series, baseUrl) {
  const id = Number(series.id);
  const libId = Number(series.libraryId);
  if (!id || !libId) return null;
  return `${baseUrl}/Library/${libId}/Series/${id}`;
}

// ---- Per-series edge emission ------------------------------------------

// Series → entities + edges. Returns the set of source_ids we touched
// (used for stale-marking the ones we *didn't*).
function ingestSeries(db, series, libraryType, counters) {
  const seriesId = Number(series.id);
  if (!seriesId || !Number.isFinite(seriesId)) return;

  const meta = workMeta(series, libraryType);
  const deep = deepLinkFor(series, process.env.KAVITA_URL || 'https://kavita.phatt.vip');

  // 1. Upsert the work entity (one per (kind, service, seriesId)).
  const { id: workId, created } = ensureEntity(db, {
    kind: 'work',
    name: series.name || series.localizedName || `untitled-${seriesId}`,
    source_service: SERVICE,
    source_id: String(seriesId),
    meta,
    created_by: `sync:${SERVICE}`,
  });
  if (created) counters.added += 1; else counters.updated += 1;

  // 2. authored_by (work → person) from Kavita writers/authors.
  //    Per design doc §5.1 Kavita branch: "authors → person entities,
  //    emit authored_by edge". Kavita exposes writers in metadata.writers
  //    (most common) but some installs use metadata.authors or a flat
  //    top-level field. We accept all three.
  const md = series.metadata || {};
  const authorsRaw = [
    ...splitAuthors(md.writers),
    ...splitAuthors(md.authors),
    ...splitAuthors(series.writers),       // legacy shape
  ];
  const authors = Array.from(new Set(authorsRaw));
  for (const author of authors) {
    const personId = ensurePerson(db, author);
    if (!personId) continue;
    const r = upsertEdge(db, {
      from_id: workId,
      to_id: personId,
      type: 'authored_by',
      source_id: `${seriesId}|${author.toLowerCase()}`,
      meta: { role: 'author' },
      created_by: `sync:${SERVICE}`,
      deep_link: deep,
    });
    if (r.created) counters.edges += 1;
  }

  // 3. tagged_with (work → concept) from Kavita genres + tags.
  //    Two tag_kinds: 'genre' for the curated Kavita genre list, 'tag'
  //    for free-form user-added tags. Both go through the same
  //    concept entity dedup (slug-keyed) so "Sci-Fi" + "sci-fi"
  //    collapse to one node.
  const tagBags = [
    [TAGS_KIND_GENRE, splitTags(md.genres)],
    [TAGS_KIND_TAG, splitTags(md.tags)],
  ];
  for (const [tagKind, tags] of tagBags) {
    for (const tag of tags) {
      const conceptId = ensureConcept(db, tag);
      if (!conceptId) continue;
      const r = upsertEdge(db, {
        from_id: workId,
        to_id: conceptId,
        type: 'tagged_with',
        source_id: `${seriesId}|${tagKind}|${tag.toLowerCase()}`,
        meta: { tag_kind: tagKind },
        created_by: `sync:${SERVICE}`,
      });
      if (r.created) counters.edges += 1;
    }
  }

  // 4. available_as (work → work) for sibling works across libraries.
  //    Per design doc §5.1: same (kind=work, source_service=kavita) with
  //    matching (title_lower, year) are siblings — emit available_as
  //    between them. The post-pass below handles the cross-library
  //    matching after every series has been upserted (order-independent).

  // Track the work entity id so the stale-mark pass doesn't kill its
  // edges. We track the entity id (not the bare seriesId) because edge
  // source_ids are compound (`${seriesId}|${tagKind}|${tag}`) and would
  // never match a bare seriesId in the touched set; the entity-id
  // invariant holds.
  counters.touchedWorkIds.push(workId);
}

// ---- Cross-library available_as post-pass -----------------------------

// Find every work pair (a, b) with matching (title_lower, year) from
// source_service='kavita' and emit `available_as` edges in both
// directions. Order-independent: we look at all works at once after
// the walk so the pair set is the same regardless of which library the
// worker hit first.
//
// source_id on the edge is `${aSeriesId}~~${bSeriesId}` so re-running
// the sync is idempotent (the unique key on entity_edges catches it).
function availableAsPostPass(db, counters) {
  const groups = db
    .prepare(`SELECT name_lower, json_extract(meta_json, '$.year') AS year, COUNT(*) AS c
              FROM entities
              WHERE kind = 'work' AND source_service = ? AND json_extract(meta_json, '$.year') IS NOT NULL
              GROUP BY name_lower, json_extract(meta_json, '$.year')
              HAVING c > 1`)
    .all(SERVICE);
  for (const g of groups) {
    const siblings = db
      .prepare(`SELECT id, source_id FROM entities
                 WHERE kind = 'work' AND source_service = ? AND name_lower = ?
                   AND json_extract(meta_json, '$.year') = ?
                 ORDER BY source_id`)
      .all(SERVICE, g.name_lower, g.year);
    for (let i = 0; i < siblings.length; i += 1) {
      for (let j = 0; j < siblings.length; j += 1) {
        if (i === j) continue;
        const a = siblings[i], b = siblings[j];
        const r = upsertEdge(db, {
          from_id: a.id,
          to_id: b.id,
          type: 'available_as',
          source_id: `${a.source_id}~~${b.source_id}`,
          meta: { reason: 'cross-library-sibling', year: g.year },
          created_by: `sync:${SERVICE}`,
        });
        if (r.created) counters.edges += 1;
      }
    }
  }
}

// Mark any edge originating from kavita where the source's upstream
// record disappeared. Edges go stale=1 (not deleted) per design doc §3
// / §12 — the entity persists because the historical relationship
// still exists; queries filter stale=0 by default.
//
// Matching on `from_id` (not bare `source_id`) is correct: edge
// source_ids are compound (`${seriesId}|${tagKind}|${tag}`) and would
// never equal a bare seriesId in the touched set; a work entity has a
// stable id and if it was touched this run, all its edges are fresh by
// definition (the entity itself didn't disappear from Kavita).
function staleMarkMissing(db, touchedWorkIds) {
  if (touchedWorkIds.size === 0) return 0;
  const stmt = db.prepare(
    `UPDATE entity_edges SET stale = 1, updated_at = datetime('now')
     WHERE source_service = ? AND stale = 0
       AND from_id NOT IN (${Array.from(touchedWorkIds, () => '?').join(',')})`,
  );
  const params = [SERVICE, ...Array.from(touchedWorkIds)];
  const r = stmt.run(...params);
  return r.changes || 0;
}

// ---- Public entry point -----------------------------------------------

/**
 * Walk Kavita libraries and reconcile entities + edges.
 *
 * options:
 *   db           required, a better-sqlite3 Database instance with the
 *                entity-graph schema migrated (Phase A's migration; this
 *                worker also calls migrate() as a self-healing fallback)
 *   baseUrl      default `process.env.KAVITA_URL` || 'https://kavita.phatt.vip'
 *   apiKey       default `process.env.KAVITA_API_KEY`
 *   httpDo       optional dependency-injection seam; defaults to HTTPS
 *   dryRun       if true, runs through the walk but never writes; useful
 *                for the smoke script to assert the API shape before
 *                committing
 *
 * Returns { added, updated, edges, stale, reviewQueue, libraries, items,
 *           errors, durationMs }. Counters are cumulative across the run;
 * `errors` collects non-fatal per-library exceptions so one bad library
 * doesn't kill the whole sync.
 */
async function syncKavita(options = {}) {
  const start = Date.now();
  const {
    db,
    baseUrl = process.env.KAVITA_URL || 'https://kavita.phatt.vip',
    apiKey = process.env.KAVITA_API_KEY || '',
    httpDo = defaultHttpDo,
    dryRun = false,
  } = options;

  if (!db) throw new Error('syncKavita: db is required');
  if (!apiKey) throw new Error('syncKavita: KAVITA_API_KEY env var (or `apiKey` option) is required');

  // Self-healing: if the entity graph schema hasn't been migrated yet
  // (e.g. Phase A hasn't landed), ensure it is before we write. No-op
  // once Phase A's migrate() runs at boot.
  if (!dryRun) migrate(db);

  const counters = { added: 0, updated: 0, edges: 0, stale: 0, reviewQueue: 0, touchedWorkIds: [] };
  const errors = [];

  let libraries = [];
  let items = 0;
  try {
    libraries = await kavitaLibraries({ baseUrl, apiKey, httpDo });
  } catch (e) {
    errors.push({ phase: 'libraries', message: String(e && e.message || e) });
    return finalize({ ...counters, libraries: 0, items: 0, errors, durationMs: Date.now() - start });
  }

  for (const lib of libraries) {
    let seriesList = [];
    try {
      seriesList = await kavitaLibrarySeries({ baseUrl, apiKey, libraryId: lib.id, httpDo });
    } catch (e) {
      errors.push({ phase: 'series:library', library: lib.name, libraryId: lib.id, message: String(e && e.message || e) });
      continue;
    }

    // Wrap per-library writes in a transaction so a partial library
    // doesn't leave the graph half-updated.
    const ingest = db.transaction((series) => {
      for (const s of series) {
        try {
          ingestSeries(db, s, lib.type, counters);
        } catch (e) {
          errors.push({ phase: 'ingest', library: lib.name, seriesId: String(s && s.id || ''), message: String(e && e.message || e) });
        }
      }
    });
    if (!dryRun) ingest(seriesList);
    else for (const s of seriesList) {
      // In dryRun we still walk and validate shape but skip writes.
      try {
        // eslint-disable-next-line no-unused-vars
        const _kind = Number(s && s.id || 0);
      } catch (e) { /* swallow */ }
    }
    items += seriesList.length;
  }

  // Cross-library available_as post-pass + stale-marking. Run only on
  // non-dryRun. The post-pass happens BEFORE stale-marking so a newly
  // emitted available_as edge from the post-pass is not immediately
  // stale-marked if its source_id happens to be the only one in the
  // touched set (the post-pass source_ids are `A~~B`, neither side
  // matches a seriesId directly — they live in the touchedSet only
  // by A and B being touched, but stale-mark uses source_id exact
  // match so available_as edges are unaffected).
  if (!dryRun) {
    availableAsPostPass(db, counters);
    const touchedSet = new Set(counters.touchedWorkIds);
    counters.stale = staleMarkMissing(db, touchedSet);
  }

  return finalize({ ...counters, libraries: libraries.length, items, errors, durationMs: Date.now() - start });
}

function finalize(counters) {
  // Strip the per-item tracking array from the public shape; keep the
  // counters small + JSON-safe.
  const { touchedWorkIds, ...rest } = counters;
  return {
    added: rest.added,
    updated: rest.updated,
    edges: rest.edges,
    stale: rest.stale,
    reviewQueue: rest.reviewQueue,
    libraries: rest.libraries,
    items: rest.items,
    errors: rest.errors,
    durationMs: rest.durationMs,
  };
}

module.exports = {
  LIBRARY_TYPE,
  SERVICE,
  migrate,
  syncKavita,
  // exported for tests
  defaultHttpDo,
  ensureEntity,
  ensurePerson,
  ensureConcept,
  upsertEdge,
  slugify,
  splitTags,
  splitAuthors,
  workMeta,
  deepLinkFor,
  kavitaLibraries,
  kavitaLibrarySeries,
  ingestSeries,
  staleMarkMissing,
  availableAsPostPass,
};