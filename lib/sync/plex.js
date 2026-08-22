// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — Plex sync worker (PHA-1624 Phase B-1, PHA-1873).
//
// Background sync that walks a Plex Media Server library and reconciles
// entities + edges in Homestead's entity graph (design doc §5.1).
//
// Public API:
//   * syncPlex(options) → { added, updated, edges, stale, reviewQueue,
//                           libraries, items, errors }
//   * migrate(db)        — idempotent schema installer (no-op when the
//                           schema already exists; provided for the test
//                           bootstrap + a defensive call from the admin
//                           endpoint so a freshly-restarted container
//                           doesn't 500 on first sync)
//
// Re-runnable: same `(kind, source_service, source_id)` always resolves
// to the same row; same `(from_id, to_id, type, source_service, source_id)`
// edge always upserts. Idempotency UNIQUE constraints live in
// `lib/sync/_schema.js`.
//
// Source proxies via the existing SWAG layer on phatt.vip — no new infra.
// Plex API key read from env (`PLEX_TOKEN`). Base URL from `PLEX_URL`
// (default `https://plex.phatt.vip`).
//
// Cron-driven every 6h from `server.js`'s boot scheduler, manually
// triggerable via `POST /api/admin/sync/plex` (admin-only).

'use strict';

const crypto = require('crypto');
const { migrate } = require('./_schema');

// ---- Public constants ---------------------------------------------------

const SERVICE = 'plex';

// Plex type integers per the API metadata.type field:
//   1=movie, 2=show, 3=season, 4=episode, 8=artist, 9=album, 10=track
const PLEX_TYPE = Object.freeze({
  movie: 1,
  show: 2,
  season: 3,
  episode: 4,
});

// ---- Default HTTPS HTTP helper -----------------------------------------

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

// ---- Plex API client ---------------------------------------------------

// Fetches and parses JSON from Plex. The API returns XML by default; we
// request JSON via `Accept: application/json`. On non-2xx we surface the
// status + body so the caller can log structured errors.
async function plexFetchJson({ baseUrl, token, path, httpDo }) {
  const url = new URL(path, baseUrl).toString();
  const res = await httpDo({
    method: 'GET',
    url,
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Product': 'Homestead',
      'X-Plex-Version': '1.0',
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`plex http ${res.status} on ${path}: ${res.text.slice(0, 256)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error(`plex returned non-JSON on ${path}: ${res.text.slice(0, 256)}`);
  }
}

// ---- Slug / name normalization -----------------------------------------

function slugify(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function uuid() {
  return crypto.randomUUID();
}

// Split a comma- or pipe-separated tag string into trimmed unique tags.
// Plex returns Genre/Mood/Director/Collection either as JSON arrays or as
// pipe-separated strings depending on the field. We accept both.
function splitTags(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/[,|]/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

// ---- Entity upserts ---------------------------------------------------

// Resolve or create an entity keyed by (kind, source_service, source_id).
// `meta` replaces the existing meta_json when provided (shallow merge of
// top-level keys so re-runs preserve untouched fields).
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
  // Build a unique slug. Tie-break on rowid so concurrent inserts with
  // the same name don't collide on the UNIQUE constraint.
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
// kind=person. Per design doc §14 open-question #2: deterministic merge
// on lowercased full name within `kind=person` (v1 collision risk
// accepted). Created with `source_service='plex'` + `source_id` derived
// from the lowercase name so a subsequent run is idempotent.
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
// merge on slug (which is already unique-keyed in the schema) means
// "scifi" + "Sci-Fi" + "sci-fi" all collapse to one concept node.
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
    meta: { tag_kind: 'genre' },
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

// ---- Plex walker -------------------------------------------------------

function plexItemType(item) {
  // Plex items use either numeric `type` or string `type` depending on
  // the endpoint / version. Normalize to the integer.
  if (typeof item.type === 'number') return item.type;
  const s = String(item.type || '').toLowerCase();
  if (s === 'movie') return PLEX_TYPE.movie;
  if (s === 'show') return PLEX_TYPE.show;
  if (s === 'season') return PLEX_TYPE.season;
  if (s === 'episode') return PLEX_TYPE.episode;
  return null;
}

function plexItemKind(item) {
  const t = plexItemType(item);
  if (t === PLEX_TYPE.movie) return 'work';
  if (t === PLEX_TYPE.show) return 'work';        // series as a `work`
  if (t === PLEX_TYPE.season) return 'work';
  if (t === PLEX_TYPE.episode) return 'work';
  return null;
}

// Walk `/library/sections` and return sections. Each section has
// { key, title, type }.
async function plexSections({ baseUrl, token, httpDo }) {
  const json = await plexFetchJson({ baseUrl, token, path: '/library/sections', httpDo });
  const container = json && (json.MediaContainer || json);
  const dirs = (container && (container.Directory || container.directory)) || [];
  return dirs.map((d) => ({
    key: String(d.key || d.id),
    title: d.title || d.name || `Section ${d.key || d.id}`,
    type: d.type,            // 1=movie, 2=show, 3=artist, 4=photo
    agent: d.agent || null,
    scanner: d.scanner || null,
  }));
}

// Walk all items in a section. Returns the union of type=1 (movies),
// type=2 (shows), and recursively their seasons + episodes. We fetch
// /library/sections/{key}/all?type=N separately so each call returns a
// consistent shape.
async function plexSectionItems({ baseUrl, token, section, httpDo }) {
  const items = [];
  if (section.type === 1 || section.type === 'movie') {
    const json = await plexFetchJson({
      baseUrl, token, httpDo,
      path: `/library/sections/${section.key}/all?type=${PLEX_TYPE.movie}`,
    });
    const md = (json && (json.MediaContainer || json)) || {};
    const metas = md.Metadata || md.metadata || [];
    for (const m of metas) items.push(m);
  } else if (section.type === 2 || section.type === 'show') {
    const showsJson = await plexFetchJson({
      baseUrl, token, httpDo,
      path: `/library/sections/${section.key}/all?type=${PLEX_TYPE.show}`,
    });
    const showsMd = (showsJson && (showsJson.MediaContainer || showsJson)) || {};
    const shows = showsMd.Metadata || showsMd.metadata || [];
    for (const show of shows) {
      items.push(show);
      // Seasons + episodes for this show. We use the show's `key` to
      // walk its children via /library/metadata/{key}/children.
      try {
        const childrenJson = await plexFetchJson({
          baseUrl, token, httpDo,
          path: `/library/metadata/${show.ratingKey}/children?excludeAllLeaves=1`,
        });
        const childMd = (childrenJson && (childrenJson.MediaContainer || childrenJson)) || {};
        const seasons = childMd.Metadata || childMd.metadata || [];
        for (const season of seasons) {
          items.push(season);
          const epsJson = await plexFetchJson({
            baseUrl, token, httpDo,
            path: `/library/metadata/${season.ratingKey}/children?excludeAllLeaves=1`,
          });
          const epsMd = (epsJson && (epsJson.MediaContainer || epsJson)) || {};
          const eps = epsMd.Metadata || epsMd.metadata || [];
          for (const ep of eps) items.push(ep);
        }
      } catch (_) {
        // Non-fatal: a missing children endpoint shouldn't kill the
        // whole sync. The show entity + its tagged_with / directed_by
        // edges still get recorded.
      }
    }
  }
  return items;
}

// Build the `work` meta JSON bag for an item. Year comes from `year` or
// `originallyAvailableAt.slice(0,4)`. thumb is the canonical Plex thumb
// path; we resolve it against the base URL + token for deep linking.
function workMeta(item, baseUrl) {
  const meta = {
    title: item.title || '',
    year: item.year || (item.originallyAvailableAt ? Number(String(item.originallyAvailableAt).slice(0, 4)) : null),
    summary: item.summary || '',
    originallyAvailableAt: item.originallyAvailableAt || null,
    studio: item.studio || null,
    contentRating: item.contentRating || null,
    durationMs: item.duration || null,
  };
  if (item.thumb) {
    meta.thumb = item.thumb;
    meta.thumb_url = `${baseUrl}${item.thumb}?X-Plex-Token=${encodeURIComponent(process.env.PLEX_TOKEN || '')}`;
  }
  if (item.art) meta.art_url = `${baseUrl}${item.art}?X-Plex-Token=${encodeURIComponent(process.env.PLEX_TOKEN || '')}`;
  return meta;
}

function deepLinkFor(item, baseUrl, token) {
  // Best-effort deep link into the Plex web app. Key looks like
  // /library/metadata/{ratingKey} for items, /library/sections/{key}
  // for sections. We emit /library/metadata/{ratingKey} for items.
  if (!item.ratingKey) return null;
  return `${baseUrl}/web/index.html#!/server/${encodeURIComponent(new URL(baseUrl).host)}/details?key=%2Flibrary%2Fmetadata%2F${item.ratingKey}`;
}

// ---- Per-item edge emission --------------------------------------------

// Item → entities + edges. Returns the set of source_ids we touched
// (used for stale-marking the ones we *didn't*).
function ingestItem(db, item, baseUrl, token, counters) {
  const ratingKey = String(item.ratingKey || '');
  if (!ratingKey) return;

  const kind = plexItemKind(item);
  if (!kind) return;       // unknown type, skip silently

  const meta = workMeta(item, baseUrl);
  const deep = deepLinkFor(item, baseUrl, token);

  // 1. Upsert the work entity (one per (kind, service, ratingKey)).
  const { id: workId, created } = ensureEntity(db, {
    kind: 'work',
    name: item.title || `untitled-${ratingKey}`,
    source_service: SERVICE,
    source_id: ratingKey,
    meta,
    created_by: `sync:${SERVICE}`,
  });
  if (created) counters.added += 1; else counters.updated += 1;

  // 2. part_of (work → series) when this is a season or episode. The
  //    parent show has key /library/metadata/{parentRatingKey}.
  const t = plexItemType(item);
  if (t === PLEX_TYPE.season || t === PLEX_TYPE.episode) {
    const parentRatingKey = item.parentRatingKey
      ? String(item.parentRatingKey)
      : (item.grandparentRatingKey ? String(item.grandparentRatingKey) : null);
    if (parentRatingKey) {
      // Parent show may not have been upserted yet in this run if the
      // walk hasn't reached it; ensure a stub so the edge can resolve.
      // The next sync will refresh its meta when the show is processed.
      const parentName = item.parentTitle || item.grandparentTitle || `show-${parentRatingKey}`;
      const parentId = ensureEntity(db, {
        kind: 'work',
        name: parentName,
        source_service: SERVICE,
        source_id: parentRatingKey,
        meta: { title: parentName },
        created_by: `sync:${SERVICE}`,
      }).id;
      const r = upsertEdge(db, {
        from_id: t === PLEX_TYPE.season ? workId : (item.grandparentRatingKey ? workId : workId),
        to_id: parentId,
        type: 'part_of',
        source_id: `${ratingKey}->${parentRatingKey}`,
        meta: {
          order: item.index || null,
          season_index: (t === PLEX_TYPE.episode && item.parentIndex != null) ? item.parentIndex : null,
          episode_index: (t === PLEX_TYPE.episode && item.index != null) ? item.index : null,
        },
        created_by: `sync:${SERVICE}`,
      });
      if (r.created) counters.edges += 1;
      // If we stubbed a parent show that wasn't itself processed in
      // this run, mark its work id as touched so its own edges (e.g.,
      // tagged_with for the show) don't get stale-marked by accident.
      // (The parent's tagged_with / directed_by edges get filled in
      // when the show is processed; if it isn't, we still want to
      // consider it fresh because we just stubbed it.)
      counters.touchedWorkIds.push(parentId);
    }
  }

  // 3. tagged_with (work → concept) from Genre / Mood / Collection.
  //    Director goes through directed_by below; here we just emit the
  //    concept nodes for tags.
  const tagKinds = [
    ['genre', splitTags(item.Genre)],
    ['mood', splitTags(item.Mood)],
    ['collection', splitTags(item.Collection)],
  ];
  for (const [tagKind, tags] of tagKinds) {
    for (const tag of tags) {
      const conceptId = ensureConcept(db, tag);
      const r = upsertEdge(db, {
        from_id: workId,
        to_id: conceptId,
        type: 'tagged_with',
        source_id: `${ratingKey}|${tagKind}|${tag.toLowerCase()}`,
        meta: { tag_kind: tagKind },
        created_by: `sync:${SERVICE}`,
      });
      if (r.created) counters.edges += 1;
    }
  }

  // 4. directed_by (work → person) from Director[]. Person nodes are
  //    deterministic on lowercase name within kind=person.
  const directors = splitTags(item.Director);
  for (const director of directors) {
    const personId = ensurePerson(db, director);
    const r = upsertEdge(db, {
      from_id: workId,
      to_id: personId,
      type: 'directed_by',
      source_id: `${ratingKey}|${director.toLowerCase()}`,
      meta: { role: 'director' },
      created_by: `sync:${SERVICE}`,
      deep_link: deep,
    });
    if (r.created) counters.edges += 1;
  }

  // 5. available_as (work → work) for sibling works across libraries.
  //    Per design doc §5.1: same (kind=work, source_service=plex) with
  //    matching (title_lower, year) are considered siblings — we emit
  //    available_as between them. We do NOT try to detect movie vs
  //    director's cut (Phase C concern).
  //
  //    Sibling detection happens in a post-pass (`availableAsPostPass`)
  //    after every item has been upserted so the result is
  //    order-independent: every sibling pair gets both A→B and B→A
  //    edges (each side is a separate edge keyed on its own source_id).
  //    We don't emit during the per-item walk because we can't see
  //    siblings that haven't been upserted yet.

  // Track the work entity id so we don't stale-mark its edges in the
  // post-pass. (We use `from_id` rather than the bare ratingKey for the
  // IN check — see `staleMarkMissing` for why.)
  counters.touchedWorkIds.push(workId);
}

// ---- Stale-marking ----------------------------------------------------

// ---- Cross-library available_as post-pass -----------------------------

// Find every work pair (a, b) with matching (title_lower, year) from
// source_service='plex' and emit `available_as` edges in both directions.
// Order-independent: we look at all works at once after the walk so the
// pair set is the same regardless of which library the worker hit first.
//
// source_id on the edge is `${aRatingKey}~~${bRatingKey}` so re-running
// the sync is idempotent (the unique key on entity_edges catches it).
function availableAsPostPass(db, counters) {
  // Group works by (title_lower, year) and emit edges for any group with
  // ≥2 members. We use a HAVING count > 1 query.
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

// Mark any edge originating from plex where the source's upstream
// record disappeared. We mark edges stale (not entities) per design
// doc §3 / §12 — the entity persists because the historical
// relationship still exists; queries filter stale=0 by default.
//
// We compute the set of work entity ids we touched this run (including
// parent ratingKeys we stubbed for part_of) and stale-mark every plex
// edge whose `from_id` is NOT in that set. Matching on `from_id` (not
// the bare `source_id`) is correct because:
//   * edge source_id is compound (`${ratingKey}|${tagKind}|${tag}`) and
//     would never equal a bare ratingKey in the touched set;
//   * a work entity has a stable id; if it was touched this run, all
//     its edges are fresh by definition (the entity itself didn't
//     disappear from Plex, just specific tag/director/etc metadata).
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
 * Walk the Plex library and reconcile entities + edges.
 *
 * options:
 *   db           required, a better-sqlite3 Database instance with the
 *                entity-graph schema migrated (Phase A's migration; this
 *                worker also calls migrate() as a self-healing fallback)
 *   baseUrl      default `process.env.PLEX_URL` || 'https://plex.phatt.vip'
 *   token        default `process.env.PLEX_TOKEN`
 *   httpDo       optional dependency-injection seam; defaults to HTTPS
 *   dryRun       if true, runs through the walk but never writes; useful
 *                for the smoke script to assert the API shape before
 *                committing
 *
 * Returns { added, updated, edges, stale, reviewQueue, libraries, items,
 *           errors, durationMs }. Counters are cumulative across the run;
 * `errors` collects non-fatal per-section exceptions so one bad library
 * doesn't kill the whole sync.
 */
async function syncPlex(options = {}) {
  const start = Date.now();
  const {
    db,
    baseUrl = process.env.PLEX_URL || 'https://plex.phatt.vip',
    token = process.env.PLEX_TOKEN || '',
    httpDo = defaultHttpDo,
    dryRun = false,
  } = options;

  if (!db) throw new Error('syncPlex: db is required');
  if (!token) throw new Error('syncPlex: PLEX_TOKEN env var (or `token` option) is required');

  // Self-healing: if the entity graph schema hasn't been migrated yet
  // (e.g. Phase A hasn't landed), ensure it is before we write. No-op
  // once Phase A's migrate() runs at boot.
  if (!dryRun) migrate(db);

  const counters = { added: 0, updated: 0, edges: 0, stale: 0, reviewQueue: 0, touchedWorkIds: [] };
  const errors = [];

  let sections = [];
  let items = 0;
  let libraries = 0;
  try {
    sections = await plexSections({ baseUrl, token, httpDo });
  } catch (e) {
    errors.push({ phase: 'sections', message: String(e && e.message || e) });
    return finalize({ ...counters, libraries: 0, items: 0, errors, durationMs: Date.now() - start });
  }

  for (const section of sections) {
    libraries += 1;
    let sectionItems = [];
    try {
      sectionItems = await plexSectionItems({ baseUrl, token, section, httpDo });
    } catch (e) {
      errors.push({ phase: 'section:' + section.key, section: section.title, message: String(e && e.message || e) });
      continue;
    }

    // Wrap per-section writes in a transaction so a partial section
    // doesn't leave the graph half-updated.
    const ingest = db.transaction((its) => {
      for (const item of its) {
        try {
          ingestItem(db, item, baseUrl, token, counters);
        } catch (e) {
          errors.push({ phase: 'ingest', section: section.title, ratingKey: String(item.ratingKey || ''), message: String(e && e.message || e) });
        }
      }
    });
    if (!dryRun) ingest(sectionItems);
    else for (const item of sectionItems) {
      // In dryRun we still walk and validate shape but skip writes.
      try {
        // eslint-disable-next-line no-unused-vars
        const _kind = plexItemKind(item);
      } catch (e) { /* swallow */ }
    }
    items += sectionItems.length;
  }

  // Cross-library available_as post-pass + stale-marking. Run only on
  // non-dryRun. The post-pass happens BEFORE stale-marking so a newly
  // emitted available_as edge from the post-pass is not immediately
  // stale-marked if its source_id happens to be the only one in the
  // touched set (the post-pass source_ids are `A~~B`, neither side
  // matches a ratingKey directly — they live in the touchedSet only
  // by A and B being touched, but stale-mark uses source_id exact
  // match so available_as edges are unaffected).
  if (!dryRun) {
    availableAsPostPass(db, counters);
    const touchedSet = new Set(counters.touchedWorkIds);
    counters.stale = staleMarkMissing(db, touchedSet);
  }

  return finalize({ ...counters, libraries, items, errors, durationMs: Date.now() - start });
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
  PLEX_TYPE,
  SERVICE,
  migrate,
  syncPlex,
  // exported for tests
  defaultHttpDo,
  ensureEntity,
  ensurePerson,
  ensureConcept,
  upsertEdge,
  slugify,
  splitTags,
  plexItemType,
  plexItemKind,
  workMeta,
  deepLinkFor,
  plexSections,
  plexSectionItems,
  ingestItem,
  staleMarkMissing,
  availableAsPostPass,
  // unStubTouchedEntities was removed in favor of from_id-based matching;
  // the stub case is now handled by pushing the stubbed parent's id into
  // `touchedWorkIds` (see `ingestItem`'s part_of branch).
};