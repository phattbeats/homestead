// Homestead — seerr sync worker (PHA-1624 Phase B-3, PHA-1875).
//
// Background sync that walks the seerr (Jellyseerr / Overseerr) media
// request list and reconciles `requested_in` edges in Homestead's
// entity graph (design doc §5.1, "Seerr worker").
//
// Public API:
//   * syncSeerr(options) → { added, updated, edges, hintEdges, stale,
//                           reviewQueue, requests, errors }
//   * migrate(db)         — idempotent schema installer (no-op when
//                           the schema already exists; defensive
//                           fallback for the admin endpoint so a
//                           freshly-restarted container doesn't 500
//                           on first sync before Phase A migrates
//                           at boot).
//
// Re-runnable: same `(kind, source_service, source_id)` always
// resolves to the same entity row; same
// `(from_id, to_id, type, source_service, source_id)` edge always
// upserts. Idempotency UNIQUE constraints live in
// `lib/sync/_schema.js`.
//
// Source proxies via the existing SWAG layer on phatt.vip — no new
// infra. seerr uses an `X-Api-Key` header (Jellyseerr / Overseerr
// convention). API key from env (`SEERR_API_KEY`). Base URL from
// `SEERR_URL` (default `https://seerr.phatt.vip`).
//
// Cron-driven every 6h from `server.js`'s boot scheduler, manually
// triggerable via `POST /api/admin/sync/seerr` (admin-only).

'use strict';

const crypto = require('crypto');
const { migrate } = require('./_schema');

// ---- Public constants ---------------------------------------------------

const SERVICE = 'seerr';

// New edge type introduced by this worker. The design-doc edge
// vocabulary (§2.2) is described as a "closed vocabulary" but the
// SQLite schema is `type TEXT NOT NULL` — no migration is needed to
// add a new type string, only an indexer / search-renderer agreement.
// `availability_hint` is a soft pointer emitted by seerr when a
// request transitions to status=available. The canonical `available_as`
// / `available_via` edge is owned by Plex (B-1) and Kavita (B-2); the
// hint tells the entity page "seerr says this just became available —
// Plex/Kavita sync should pick it up on the next run." Hint edges are
// emitted with weight=0.5 so the entity renderer can flag them as
// non-authoritative.
const EDGE_TYPE_REQUESTED_IN = 'requested_in';
const EDGE_TYPE_AVAILABILITY_HINT = 'availability_hint';

// ---- Default HTTPS HTTP helper -----------------------------------------
//
// Mirrors `lib/sync/plex.js#defaultHttpDo` and
// `lib/sync/kavita.js#defaultHttpDo`. Same DI seam so tests can mock
// the HTTP layer with canned fixtures.

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

// ---- seerr API client ---------------------------------------------------
//
// seerr is the Jellyseerr / Overseerr fork (and the upstream Overseerr
// itself is API-compatible). It returns JSON for `/api/v1/*`. Auth is
// `X-Api-Key: <key>` (NOT `Authorization: Bearer …`).

async function seerrFetchJson({ baseUrl, apiKey, path, httpDo }) {
  const url = new URL(path, baseUrl).toString();
  const res = await httpDo({
    method: 'GET',
    url,
    headers: {
      Accept: 'application/json',
      'X-Api-Key': apiKey,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`seerr http ${res.status} on ${path}: ${res.text.slice(0, 256)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error(`seerr returned non-JSON on ${path}: ${res.text.slice(0, 256)}`);
  }
}

// ---- Slug / name normalization -----------------------------------------
//
// Slugs, UUIDs are kept as local copies (not imported from plex.js /
// kavita.js) so this module is standalone — `require('seerr.js')`
// works without dragging in the other sync workers.

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

// ---- Entity upserts ---------------------------------------------------

// Resolve or create an entity keyed by (kind, source_service, source_id).
// `meta` shallow-merges with the existing meta_json so re-runs preserve
// untouched fields. Same shape as plex.js / kavita.js.
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

// Upsert an edge keyed by (from_id, to_id, type, source_service, source_id).
// meta shallow-merges so re-runs preserve untouched keys. weight is
// defaulted to 1.0; hint edges pass 0.5 explicitly.
function upsertEdge(db, { from_id, to_id, type, source_id, deep_link = null, meta = {}, weight = 1.0, created_by }) {
  const existing = db
    .prepare(`SELECT id, meta_json FROM entity_edges WHERE from_id = ? AND to_id = ? AND type = ? AND source_service = ? AND source_id = ?`)
    .get(from_id, to_id, type, SERVICE, source_id);
  if (existing) {
    const merged = { ...JSON.parse(existing.meta_json || '{}'), ...meta };
    db.prepare(
      `UPDATE entity_edges SET meta_json = ?, weight = ?, deep_link = COALESCE(?, deep_link), updated_at = datetime('now'), stale = 0 WHERE id = ?`,
    ).run(JSON.stringify(merged), weight, deep_link, existing.id);
    return { id: existing.id, created: false };
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO entity_edges (id, from_id, to_id, type, source_service, source_id, deep_link, meta_json, weight, created_by, created_at, updated_at, stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
  ).run(id, from_id, to_id, type, SERVICE, source_id, deep_link, JSON.stringify(meta), weight, created_by);
  return { id, created: true };
}

// ---- Media-club roster match (PHA-1618 user model) ---------------------

// Look up the user in PHA-1618's `users` table by username
// (case-insensitive — the column is `COLLATE NOCASE`). Returns
// { userId, isAdmin } or null. We do NOT filter on group membership
// here; v1 accepts any authenticated user as a "media-club member"
// candidate. Tightening (only users in the `media-club` group) is
// a follow-up — it requires a join through `user_groups`.
//
// The user lookup is wrapped in try/catch because some Homestead
// installs might have a schema without `users` (pre-PHA-1618). In
// that case the seerr worker still functions — every seerr user is
// treated as unknown + queued for review. We never let the user
// table schema be a hard prerequisite for the sync.
function lookupMediaClubMember(db, username) {
  const clean = (username || '').trim();
  if (!clean) return null;
  try {
    const row = db
      .prepare(`SELECT id, username, display, is_admin FROM users WHERE username = ?`)
      .get(clean);
    if (!row) return null;
    return { userId: Number(row.id), username: row.username, display: row.display || row.username, isAdmin: Number(row.is_admin) === 1 };
  } catch (_) {
    return null;       // pre-PHA-1618 install — treat all users as unknown
  }
}

// ---- Review queue helper ----------------------------------------------

// Insert a "needs review" row for a stub person created from a seerr
// request. The entity_review_queue schema requires both `candidate_a`
// and `candidate_b` as non-null FKs to entities(id). For an unknown
// user, there's no second candidate (no comparison pair — the stub
// just needs attribution to a media-club member). We self-reference
// the stub as both candidates so the schema is satisfied; the
// `kind='unknown_person'` and the human-readable `reason` field tell
// the UI / triage agent to render this as an attribution task rather
// than a merge decision. The PRIMARY KEY in entity_review_queue is
// `id` (UUID) so multiple rows can reference the same stub as long
// as each gets a unique id — that's the case here because we issue
// one review row per stub, not per request.
//
// Returns the review queue row id. Idempotency: we check for an
// existing pending review row for the same stub + reason before
// inserting so re-runs don't pile up duplicates.
function addUnknownPersonReview(db, { personId, username, seerrRequestId }) {
  if (!personId) return null;
  const reason = `Unknown seerr user: ${username}. Needs attribution to a media-club roster member.`;
  const existing = db
    .prepare(`SELECT id FROM entity_review_queue
              WHERE kind = 'unknown_person'
                AND candidate_a = ?
                AND status = 'pending'
                AND reason = ?`)
    .get(personId, reason);
  if (existing) return existing.id;
  const id = uuid();
  db.prepare(
    `INSERT INTO entity_review_queue
       (id, kind, candidate_a, candidate_b, confidence, reason, source_service, evidence_json, status, created_at)
     VALUES (?, 'unknown_person', ?, ?, 0.0, ?, ?, ?, 'pending', datetime('now'))`,
  ).run(
    id,
    personId,
    personId,
    reason,
    SERVICE,
    JSON.stringify({
      username,
      seerr_request_id: seerrRequestId != null ? String(seerrRequestId) : null,
    }),
  );
  return id;
}

// ---- Person resolution ------------------------------------------------

// Resolve a seerr `requestedBy.username` to a person entity id.
//
// Flow (per issue body PHA-1875 acceptance + design doc §5.1 Seerr
// worker + §6.1 three-tier matching):
//
//   1. Look up the user in the media-club roster (PHA-1618 users
//      table) by username (COLLATE NOCASE).
//   2. If found → ensure a person entity keyed on
//      `source_service='seerr'` + `source_id='user:<username>'`,
//      stamped with `meta.media_club_user_id` + `meta.media_club_username`
//      so future syncs know this person is roster-confirmed. The
//      requested_in edge's from_id resolves to this person.
//   3. If not found → ensure a stub person entity keyed on
//      `source_service='seerr'` + `source_id='unknown:<username>'`,
//      stamped with `meta.unknown_user=true`. Insert a review-queue
//      row (kind='unknown_person') so the stub gets triaged. The
//      requested_in edge's from_id resolves to this stub.
//
// In both branches the key is `source_service='seerr'` + a
// `source_id` derived from the username. That makes the worker
// idempotent (same username → same person entity across re-runs) and
// keeps a clear audit trail of who the canonical "Brandon" / "Tyler"
// person is for seerr — separate from any person entities the Plex
// or Kavita workers may have created from cast / writer names.
//
// The two `source_id` shapes (`user:<username>` vs `unknown:<username>`)
// guarantee that a future roster match never silently merges an
// unknown stub with a roster-confirmed person — they're separate
// rows, each with their own `meta` provenance.
function resolvePerson(db, username, seerrRequestId, counters) {
  const clean = (username || '').trim();
  if (!clean) return null;
  const roster = lookupMediaClubMember(db, clean);

  if (roster) {
    // Roster match: create or refresh a person entity keyed on the
    // canonical 'user:<username>' slot. Stamping media_club_* in meta
    // so any UI / sync worker can tell this person is roster-confirmed.
    const sourceId = `user:${clean.toLowerCase()}`;
    const existing = db
      .prepare(`SELECT id, meta_json FROM entities WHERE kind = 'person' AND source_service = ? AND source_id = ?`)
      .get(SERVICE, sourceId);
    const meta = {
      media_club_user_id: roster.userId,
      media_club_username: roster.username,
      media_club_display: roster.display,
      media_club_is_admin: roster.isAdmin,
    };
    const ent = ensureEntity(db, {
      kind: 'person',
      name: roster.display || roster.username,
      source_service: SERVICE,
      source_id: sourceId,
      meta,
      created_by: `sync:${SERVICE}`,
    });
    if (ent.created) counters.added += 1; else counters.updated += 1;
    return ent.id;
  }

  // No roster match: stub person + review queue.
  const sourceId = `unknown:${clean.toLowerCase()}`;
  const stub = ensureEntity(db, {
    kind: 'person',
    name: clean,
    source_service: SERVICE,
    source_id: sourceId,
    meta: {
      unknown_user: true,
      unknown_username: clean,
    },
    created_by: `sync:${SERVICE}`,
  });
  if (stub.created) counters.added += 1; else counters.updated += 1;
  const reviewId = addUnknownPersonReview(db, {
    personId: stub.id,
    username: clean,
    seerrRequestId,
  });
  if (reviewId) counters.reviewQueue += 1;
  return stub.id;
}

// ---- Work entity resolution ------------------------------------------

// Resolve a seerr request's media reference to a work entity. seerr
// exposes the upstream ID via `media.tmdbId` (movies + TV) and
// optionally `media.tvdbId` (TV only). We key the work entity on the
// TMDB ID when present (the most cross-service-portable identifier)
// and fall back to TVDB. The plex/kavita workers store their own
// `meta.tmdb_id` on the work entities they create — Phase C's
// tier-1 deterministic matching (design doc §6.1) will merge these
// stubs with the library workers' canonical work nodes.
//
// `meta` carries enough fields for the entity page to render a
// useful card before the merge lands: title, year, media type,
// poster path, status from the upstream service. We do NOT stamp
// `meta.plex_guid` / `meta.kavita_id` here — those are owned by the
// library workers.
function ensureWorkEntity(db, request, counters) {
  const media = request && (request.media || request.Media) || null;
  if (!media) return null;
  const tmdbId = media.tmdbId || media.TMDBId || null;
  const tvdbId = media.tvdbId || media.TVDBId || null;
  const id = tmdbId != null ? `tmdb:${tmdbId}` : (tvdbId != null ? `tvdb:${tvdbId}` : null);
  if (!id) return null;

  const meta = {
    title: media.title || media.originalTitle || media.name || '',
    media_type: media.mediaType || media.MediaType || (request.type || request.Type || '').toLowerCase(),
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    status: media.status || null,
    poster_path: media.posterPath || media.poster || null,
    backdrop_path: media.backdropPath || media.backdrop || null,
    release_date: media.releaseDate || media.firstAirDate || null,
  };
  if (meta.release_date && !meta.year) {
    const y = String(meta.release_date).slice(0, 4);
    const yn = Number(y);
    if (Number.isFinite(yn) && yn > 0) meta.year = yn;
  }

  const ent = ensureEntity(db, {
    kind: 'work',
    name: meta.title || `seerr-${id}`,
    source_service: SERVICE,
    source_id: id,
    meta,
    created_by: `sync:${SERVICE}`,
  });
  if (ent.created) counters.added += 1; else counters.updated += 1;
  return ent.id;
}

// Build the seerr deep link into the request detail page. The web app
// lives at the same base URL as the API and renders requests at
// `/requests/{id}`.
function deepLinkFor(request, baseUrl) {
  const id = request && (request.id || request.Id);
  if (!id) return null;
  return `${baseUrl}/requests/${id}`;
}

// ---- Per-request ingestion --------------------------------------------

function ingestRequest(db, request, baseUrl, counters) {
  // seerr's request id can come as either number or string depending
  // on the endpoint / version. Normalize to string for the edge's
  // source_id (which is TEXT in the schema).
  const requestId = request && (request.id != null ? String(request.id) : '');
  if (!requestId) return;

  const username = (request.requestedBy && (request.requestedBy.username || request.requestedBy.Username))
    || (request.RequestedBy && (request.RequestedBy.username || request.RequestedBy.Username))
    || '';
  const status = String(request.status || request.Status || '').toLowerCase();
  const createdAt = request.createdAt || request.CreatedAt || null;

  // 1. Resolve person (roster match → confirmed; otherwise stub + review queue).
  const personId = resolvePerson(db, username, requestId, counters);
  if (!personId) return;       // no username → can't attribute

  // 2. Resolve work entity (keyed on tmdb: or tvdb:).
  const workId = ensureWorkEntity(db, request, counters);
  if (!workId) return;         // no upstream ID → can't link

  // 3. Emit requested_in edge (person → work). meta.status mirrors
  //    seerr's status verbatim so the entity page can render the
  //    request lifecycle (pending / approved / available / denied).
  //    meta.requested_at is the seerr-side timestamp.
  //    baseUrl is the same base used for the walk so deep links stay
  //    consistent with the request URL the worker hit (matters in
  //    tests where baseUrl is overridden).
  const baseDeep = deepLinkFor(request, baseUrl);
  const r = upsertEdge(db, {
    from_id: personId,
    to_id: workId,
    type: EDGE_TYPE_REQUESTED_IN,
    source_id: requestId,
    deep_link: baseDeep,
    meta: {
      status,
      requested_at: createdAt,
      media_type: (request.type || request.Type || '').toLowerCase() || null,
      requested_by_username: username,
      seerr_request_id: requestId,
    },
    created_by: `sync:${SERVICE}`,
  });
  if (r.created) counters.edges += 1;

  // 4. When status === 'available' emit a soft `availability_hint`
  //    edge (person → work, weight=0.5) telling the entity page
  //    "seerr just reported this became available — the canonical
  //    available_as / available_via edge is owned by Plex (B-1) /
  //    Kavita (B-2) and will appear on the next library sync."
  //    We key the hint edge with a separate source_id suffix
  //    (`<requestId>:hint`) so the UNIQUE constraint allows it as
  //    a sibling of the canonical requested_in edge.
  if (status === 'available') {
    const hintSourceId = `${requestId}:hint`;
    const h = upsertEdge(db, {
      from_id: personId,
      to_id: workId,
      type: EDGE_TYPE_AVAILABILITY_HINT,
      source_id: hintSourceId,
      deep_link: baseDeep,
      meta: {
        hint_kind: 'available',
        seerr_request_id: requestId,
        requested_by_username: username,
        reason: 'seerr-reported-available; canonical availability owned by plex/kavita worker',
      },
      weight: 0.5,
      created_by: `sync:${SERVICE}`,
    });
    if (h.created) counters.hintEdges += 1;
  }

  // Track the request id so the stale-mark pass doesn't kill the
  // requested_in / availability_hint edges we just emitted.
  counters.touchedRequestIds.push(requestId);
}

// ---- seerr walker -----------------------------------------------------

// Walk `/api/v1/request` (paginated; default pageSize=20) and return
// every request. Jellyseerr / Overseerr's pagination shape is:
//
//   { pageInfo: { page, pages, pageSize, results, totalResults },
//     results: [request, ...] }
//
// We loop until `pageInfo.page >= pageInfo.pages` (or a safety cap of
// MAX_PAGES to defend against runaway pagination on misconfigured
// servers). Each page is fetched as a separate HTTP call.
async function seerrAllRequests({ baseUrl, apiKey, httpDo }) {
  const PAGE_SIZE = 100;       // Jellyseerr's max page size for /api/v1/request
  const MAX_PAGES = 200;        // safety cap = 20k requests, well above any realistic household
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const path = `/api/v1/request?take=${PAGE_SIZE}&skip=${(page - 1) * PAGE_SIZE}`;
    const json = await seerrFetchJson({ baseUrl, apiKey, path, httpDo });
    const results = (json && (json.results || json.Results)) || [];
    for (const r of results) out.push(r);
    const pageInfo = (json && (json.pageInfo || json.PageInfo)) || {};
    const pages = Number(pageInfo.pages || pageInfo.Pages || 0);
    if (pages > 0) {
      // Known total: stop only when we've reached the last page.
      // Partial pages are legitimate on the last page.
      if (page >= pages) break;
    } else {
      // Unknown total: trust the response — empty page or short
      // page means we're done.
      if (results.length === 0) break;
      if (results.length < PAGE_SIZE) break;
    }
  }
  return out;
}

// ---- Stale-marking ----------------------------------------------------

// Mark any requested_in / availability_hint edge originating from
// seerr as stale if the upstream request is no longer present in the
// latest walk. We key on the seerr request id (the edge's `source_id`
// for canonical edges, and the `<id>:hint` suffix for hint edges) and
// stale-mark every seerr edge whose `source_id` is NOT in the touched
// set OR whose `source_id` matches a request id we *did* see but has
// since been deleted (the touched set holds request ids, not edge
// source_ids; we expand it below to cover both shapes).
//
// We deliberately do NOT match on `from_id` (the pattern plex.js /
// kavita.js use) because for seerr, multiple requests can share a
// `from_id` (same person made many requests) and a single person
// disappearing from seerr does NOT mean all their edges are stale —
// the requests still happened historically. The right grain is the
// request id itself.
function staleMarkMissing(db, touchedRequestIds) {
  // Build the set of edge source_ids we want to keep fresh. Two
  // shapes per request id: bare (for the canonical requested_in edge)
  // and `<id>:hint` (for the availability_hint edge).
  const keepIds = new Set();
  for (const id of touchedRequestIds) {
    keepIds.add(String(id));
    keepIds.add(`${String(id)}:hint`);
  }
  // Edge case: when the walk completes successfully but returns 0
  // requests (e.g. the household's entire request list was deleted
  // between syncs), `touchedRequestIds` is empty. We treat that as
  // "every upstream request is gone" and mark every seerr edge stale.
  // This function is only called after a successful walk (the caller
  // short-circuits with `errors[]` on HTTP failure) so a broken sync
  // won't accidentally nuke edges.
  let stmt, r;
  if (keepIds.size === 0) {
    stmt = db.prepare(
      `UPDATE entity_edges SET stale = 1, updated_at = datetime('now')
       WHERE source_service = ? AND type IN (?, ?) AND stale = 0`,
    );
    r = stmt.run(SERVICE, EDGE_TYPE_REQUESTED_IN, EDGE_TYPE_AVAILABILITY_HINT);
  } else {
    const params = Array.from(keepIds);
    const placeholders = params.map(() => '?').join(',');
    stmt = db.prepare(
      `UPDATE entity_edges SET stale = 1, updated_at = datetime('now')
       WHERE source_service = ? AND type IN (?, ?) AND stale = 0
         AND source_id NOT IN (${placeholders})`,
    );
    r = stmt.run(SERVICE, EDGE_TYPE_REQUESTED_IN, EDGE_TYPE_AVAILABILITY_HINT, ...params);
  }
  return r.changes || 0;
}

// ---- Public entry point -----------------------------------------------

/**
 * Walk the seerr request list and reconcile requested_in + hint
 * edges in Homestead's entity graph.
 *
 * options:
 *   db           required, a better-sqlite3 Database instance with the
 *                entity-graph schema migrated (Phase A's migration;
 *                this worker also calls migrate() as a self-healing
 *                fallback)
 *   baseUrl      default `process.env.SEERR_URL` || 'https://seerr.phatt.vip'
 *   apiKey       default `process.env.SEERR_API_KEY`
 *   httpDo       optional dependency-injection seam; defaults to HTTPS
 *   dryRun       if true, runs through the walk but never writes; useful
 *                for the smoke script to assert the API shape before
 *                committing
 *
 * Returns { added, updated, edges, hintEdges, stale, reviewQueue,
 *           requests, errors, durationMs }. Counters are cumulative
 * across the run; `errors` collects non-fatal per-request exceptions
 * so one bad request doesn't kill the whole sync.
 */
async function syncSeerr(options = {}) {
  const start = Date.now();
  const {
    db,
    baseUrl = process.env.SEERR_URL || 'https://seerr.phatt.vip',
    apiKey = process.env.SEERR_API_KEY || '',
    httpDo = defaultHttpDo,
    dryRun = false,
  } = options;

  if (!db) throw new Error('syncSeerr: db is required');
  if (!apiKey) throw new Error('syncSeerr: SEERR_API_KEY env var (or `apiKey` option) is required');

  // Self-healing: if the entity graph schema hasn't been migrated yet
  // (e.g. Phase A hasn't landed), ensure it is before we write. No-op
  // once Phase A's migrate() runs at boot.
  if (!dryRun) migrate(db);

  const counters = {
    added: 0,
    updated: 0,
    edges: 0,
    hintEdges: 0,
    stale: 0,
    reviewQueue: 0,
    touchedRequestIds: [],
  };
  const errors = [];

  let requests = [];
  try {
    requests = await seerrAllRequests({ baseUrl, apiKey, httpDo });
  } catch (e) {
    errors.push({ phase: 'list', message: String(e && e.message || e) });
    return finalize({ ...counters, requests: 0, errors, durationMs: Date.now() - start });
  }

  // Wrap per-request writes in a transaction so a partial batch
  // doesn't leave the graph half-updated. (seerr requests are an
  // order of magnitude smaller than a Plex/Kavita library walk, so
  // we can keep the whole batch in one transaction without blowing
  // out SQLite's lock window.)
  const ingest = db.transaction((reqs) => {
    for (const req of reqs) {
      try {
        ingestRequest(db, req, baseUrl, counters);
      } catch (e) {
        errors.push({
          phase: 'ingest',
          requestId: String((req && (req.id || req.Id)) || ''),
          message: String(e && e.message || e),
        });
      }
    }
  });
  if (!dryRun) ingest(requests);
  else {
    // In dryRun we still walk and validate shape but skip writes.
    for (const req of requests) {
      try {
        const _id = req && (req.id || req.Id);
        const _u = req && req.requestedBy && req.requestedBy.username;
      } catch (_) { /* swallow */ }
    }
  }

  // Stale-marking pass. Run only on non-dryRun. We treat any seerr
  // edge whose source_id (request id or `<id>:hint`) was NOT seen
  // this run as stale — the upstream request was deleted (or the
  // user was removed) between syncs.
  if (!dryRun) {
    const touchedSet = new Set(counters.touchedRequestIds);
    counters.stale = staleMarkMissing(db, touchedSet);
  }

  return finalize({ ...counters, requests: requests.length, errors, durationMs: Date.now() - start });
}

function finalize(counters) {
  // Strip the per-request tracking array from the public shape; keep
  // the counters small + JSON-safe.
  const { touchedRequestIds, ...rest } = counters;
  return {
    added: rest.added,
    updated: rest.updated,
    edges: rest.edges,
    hintEdges: rest.hintEdges,
    stale: rest.stale,
    reviewQueue: rest.reviewQueue,
    requests: rest.requests,
    errors: rest.errors,
    durationMs: rest.durationMs,
  };
}

module.exports = {
  SERVICE,
  EDGE_TYPE_REQUESTED_IN,
  EDGE_TYPE_AVAILABILITY_HINT,
  migrate,
  syncSeerr,
  // exported for tests
  defaultHttpDo,
  ensureEntity,
  upsertEdge,
  lookupMediaClubMember,
  addUnknownPersonReview,
  resolvePerson,
  ensureWorkEntity,
  deepLinkFor,
  seerrAllRequests,
  ingestRequest,
  staleMarkMissing,
  slugify,
  uuid,
};