// Homestead — Connector Forge surface adapters (PHA-2447).
//
// The ConnectorRunner engine (lib/connector-runner.js) calls each
// adapter by name, passing it a single immutable snapshot. The
// adapters own the writes into Homestead's persistent stores:
//
//   tile      → connector_tile_health_state   (per-installation health row)
//   card      → connector_card_cache          (per-installation summary)
//   entities  → entities + entity_edges       (entity-graph upsert)
//   feed      → wall_posts + connector_feed_events (dedupe table)
//
// All four are:
//   * idempotent   — a re-run with the same payload never duplicates rows
//   * duck-typed   — the runner only cares that each adapter is an async
//                    function with the right name
//   * schema-aware — each adapter validates its input shape and refuses
//                    to write when the payload is missing required fields
//   * redacted     — error messages that reach the runner are scrubbed
//                    of any resolved secret material (the engine already
//                    redacts upstream errors; the adapter message path
//                    is operator-facing, never secret-bearing)
//
// The adapter factory is `createAdapters(db)` — server.js wires that
// factory once at boot, captures the returned object, and passes it
// as `surfaceAdapters` when the scheduler eventually fires
// `runner.runOnce(...)`. Until the scheduler lands, tests + smoke
// scripts instantiate the factory directly.
//
// Companion module `lib/connector-placeholder.js` handles the closed
// brace-grammar placeholder resolution the spec surfaces rely on. The
// card adapter is the primary consumer (the summary text the room
// card renders), but tile + feed event bodies use it too.

'use strict';

const crypto = require('crypto');
const path = require('path');

const placeholder = require('./connector-placeholder');

// ---- Errors -------------------------------------------------------------

class ConnectorSurfaceError extends Error {
  constructor(code, message, where) {
    super(message);
    this.name = 'ConnectorSurfaceError';
    this.code = code;
    this.where = where || null;
  }
}

// ---- Schema -------------------------------------------------------------
//
// Three new tables on top of PHA-2444/2445/2446:
//
//   * connector_tile_health_state
//       Per-installation health. Mirrors service_health_state but
//       keyed on installation_id instead of service_id. We keep
//       this separate so the two tiles never collide (services and
//       connector installations are different tile_kind values
//       from a visibility standpoint, but the health row needs its
//       own FK target).
//
//   * connector_card_cache
//       Per-installation summary. Stores the merged surface field
//       map plus a precomputed `summary_text` so the room-card
//       renderer doesn't have to re-resolve the template each time.
//
//   * connector_feed_events
//       Dedupe ledger. PK = (installation_id, event_fingerprint).
//       `event_fingerprint` is `sha256(installation_id|spec_id|stable_id|event_kind)`
//       — same payload always produces the same fingerprint, so a
//       re-run with identical probe results is a no-op even after
//       we INSERT OR IGNORE a wall_post row.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_tile_health_state (
  installation_id    INTEGER PRIMARY KEY REFERENCES connector_installations(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'unknown',
  status_label       TEXT,
  last_checked_at    TEXT,
  last_ok_at         TEXT,
  down_since         TEXT,
  consecutive_fails  INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  tile_json          TEXT NOT NULL DEFAULT '{}',
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connector_card_cache (
  installation_id  INTEGER PRIMARY KEY REFERENCES connector_installations(id) ON DELETE CASCADE,
  cache_json       TEXT NOT NULL DEFAULT '{}',
  summary_text     TEXT,
  field_count      INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connector_feed_events (
  installation_id    INTEGER NOT NULL REFERENCES connector_installations(id) ON DELETE CASCADE,
  event_fingerprint  TEXT NOT NULL,
  event_kind         TEXT NOT NULL,
  stable_id          TEXT,
  title              TEXT,
  url                TEXT,
  wall_post_id       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, event_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_connector_feed_events_recent
  ON connector_feed_events(installation_id, created_at DESC);
`;

function migrate(db) {
  db.exec(SCHEMA_SQL);
}

// ---- Adapter factory ----------------------------------------------------

// createAdapters(db, opts?) → { tile, card, entities, feed }
//
// Returns the four adapter functions the runner expects. The factory
// closes over the `db` handle so adapters don't need to carry it on
// every call. `opts` is currently unused but reserved for a future
// per-installation context (e.g. `opts.resolveInstallation(id)` when
// the runner learns how to write state_json).
function createAdapters(db, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new ConnectorSurfaceError('invalid_db', 'createAdapters requires a better-sqlite3 db handle');
  }
  return {
    tile: makeTileAdapter(db, opts),
    card: makeCardAdapter(db, opts),
    entities: makeEntitiesAdapter(db, opts),
    feed: makeFeedAdapter(db, opts),
  };
}

// ---- tile adapter -------------------------------------------------------
//
// `snapshot` shape (from lib/connector-runner.js#writeSurfaces):
//   {
//     installationId, specId, ok,
//     tile: { status, label, ...extracted fields... },
//     finishedAt,
//   }
//
// Writes:
//   * connector_tile_health_state — mirrors the engine's ok flag plus
//     the extracted status + label into the Workshop-tile shape the
//     UI consumes. `tile_json` carries the full extracted field map
//     for the renderer's per-template use.
//
// Acceptance bullet: "Tile updates within 1 poll cycle on state
// change." The runner already fires the adapter on every successful
// cycle (writeSurfaces is sync to runOnce's success path), so the
// row is fresh by the time the next poll cycle queries it. We do
// NOT debounce or batch.
function makeTileAdapter(db) {
  const upsertHealth = db.prepare(`
    INSERT INTO connector_tile_health_state
      (installation_id, status, status_label, last_checked_at,
       last_ok_at, down_since, consecutive_fails, last_error,
       tile_json, updated_at)
    VALUES (@installation_id, @status, @status_label, @last_checked_at,
            @last_ok_at, @down_since, @consecutive_fails, @last_error,
            @tile_json, datetime('now'))
    ON CONFLICT(installation_id) DO UPDATE SET
      status            = excluded.status,
      status_label      = excluded.status_label,
      last_checked_at   = excluded.last_checked_at,
      last_ok_at        = excluded.last_ok_at,
      down_since        = excluded.down_since,
      consecutive_fails = excluded.consecutive_fails,
      last_error        = excluded.last_error,
      tile_json         = excluded.tile_json,
      updated_at        = datetime('now')
  `);
  const markDown = db.prepare(`
    UPDATE connector_tile_health_state
       SET status = 'down',
           consecutive_fails = consecutive_fails + 1,
           last_checked_at = ?,
           last_error = ?,
           updated_at = datetime('now')
     WHERE installation_id = ?
  `);
  const ensureRow = db.prepare(`
    INSERT OR IGNORE INTO connector_tile_health_state (installation_id) VALUES (?)
  `);

  return async function tile(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ConnectorSurfaceError('invalid_snapshot', 'tile adapter requires a snapshot object', 'tile');
    }
    const installationId = readInstallationId(snapshot);
    if (installationId == null) {
      throw new ConnectorSurfaceError('missing_installation_id', 'tile snapshot is missing installationId', 'tile');
    }

    if (!snapshot.ok) {
      // Adapter is only called when snapshot.ok===true via the engine's
      // writeSurfaces guard; if a future caller passes ok=false, we
      // surface that as DOWN on the tile row instead of throwing.
      ensureRow.run(installationId);
      const err = snapshot.error || { code: 'unknown', message: 'tile snapshot not ok' };
      const redacted = redactForTile(err.message || String(err));
      markDown.run(new Date().toISOString(), redacted, installationId);
      return { updated: 'down' };
    }

    const tileFields = snapshot.tile && typeof snapshot.tile === 'object'
      ? snapshot.tile : {};
    const status = classifyStatus(tileFields.status, snapshot.ok);
    const label = tileFields.label != null ? String(tileFields.label) : null;
    const checkedAt = snapshot.finishedAt || new Date().toISOString();
    upsertHealth.run({
      installation_id: installationId,
      status,
      status_label: label,
      last_checked_at: checkedAt,
      last_ok_at: checkedAt,
      down_since: status === 'down' ? checkedAt : null,
      consecutive_fails: 0,
      last_error: null,
      tile_json: JSON.stringify(tileFields),
    });
    return { updated: status };
  };
}

function classifyStatus(rawStatus, ok) {
  if (!ok) return 'down';
  // The runner only fires the adapter on ok===true, but we keep
  // this guard so a future caller can't accidentally write
  // 'healthy' for a failed snapshot. The runner's redactError()
  // path produces the `error` field for failed snapshots; we only
  // see it through the markDown branch above.
  if (rawStatus == null) return 'degraded';
  if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
    return rawStatus <= 0 ? 'degraded' : 'healthy';
  }
  // String statuses pass through the existing tile-status vocabulary
  // (`healthy` / `degraded` / `error`) so a template that emits
  // `status: "healthy"` works verbatim.
  if (typeof rawStatus === 'string') {
    const norm = rawStatus.toLowerCase();
    if (['healthy', 'up', 'ok'].includes(norm)) return 'healthy';
    if (['degraded', 'stale', 'warn'].includes(norm)) return 'degraded';
    if (['error', 'down', 'fail'].includes(norm)) return 'down';
    return 'degraded';
  }
  return 'degraded';
}

function redactForTile(msg) {
  // Belt-and-braces: even though the engine redacts upstream errors
  // before they reach us, an adapter-side message could conceivably
  // carry a secret if a future caller constructs the snapshot from
  // raw probe data. Keep this conservative and reusable.
  //
  // Match credential-shaped patterns: `key=Bearer <token>`, `Bearer
  // <token>`, `token <blob>`, `apiKey: <blob>`, etc. We use a single
  // regex per shape to keep this readable — the engine's
  // `redactError` is the primary line of defense; this is a
  // second-screen against adapter-side mistakes.
  if (typeof msg !== 'string') return String(msg || '');
  let out = String(msg);
  out = out
    .replace(/(?:Bearer|ApiKey|api[-_]?key|token|secret)\s*[:= ]\s*(?:Bearer\s+)?([A-Za-z0-9._\-]{6,})/gi,
             (m, val) => m.replace(val, '[REDACTED]'))
    .replace(/(?:key|token|secret|passw(?:ord)?)\s*[:= ]\s*([A-Za-z0-9+/=_\-]{12,})/gi,
             (m, val) => m.replace(val, '[REDACTED]'))
    .replace(/\bBearer\s+([A-Za-z0-9._\-]{6,})/gi,
             (m, val) => m.replace(val, '[REDACTED]'));
  return out.slice(0, 200);
}

// ---- card adapter -------------------------------------------------------
//
// Writes:
//   * connector_card_cache — JSON payload + precomputed summary_text
//
// The summary_text is produced via the closed-grammar brace resolver
// (lib/connector-placeholder.js). Templates are *not* free-form: the
// resolver rejects `{{...}}`, `${...}`, nested braces, dots, and
// any identifier that doesn't match /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.
// The spec author writes something like `"{count} comics · {recent_added} added this week"`
// and the renderer plugs the named extracted fields in. Missing
// fields render to the empty string, never the literal field name.
//
// Acceptance bullet: "Card renders with extracted summary fields."
// We write both the raw JSON (so the renderer can pick fields by
// name) and the rendered summary (so the home-grid UI can render
// without re-running the resolver on every page load).
function makeCardAdapter(db) {
  const upsertCard = db.prepare(`
    INSERT INTO connector_card_cache
      (installation_id, cache_json, summary_text, field_count, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(installation_id) DO UPDATE SET
      cache_json   = excluded.cache_json,
      summary_text = excluded.summary_text,
      field_count  = excluded.field_count,
      updated_at   = datetime('now')
  `);

  return async function card(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ConnectorSurfaceError('invalid_snapshot', 'card adapter requires a snapshot object', 'card');
    }
    const installationId = readInstallationId(snapshot);
    if (installationId == null) {
      throw new ConnectorSurfaceError('missing_installation_id', 'card snapshot is missing installationId', 'card');
    }
    const fields = snapshot.card && typeof snapshot.card === 'object' ? snapshot.card : {};

    // Render the summary using the closed-grammar resolver. If the
    // template ever ships a brace expression outside the grammar,
    // we DO NOT throw — we fall back to the literal summary derived
    // from the first named field. That keeps a malformed template
    // from blocking a poll cycle. The grammar error is surfaced in
    // the card's `summary_error` so the operator can see it.
    let summaryText = null;
    let summaryError = null;
    try {
      summaryText = renderDefaultSummary(fields);
    } catch (err) {
      summaryError = err && err.message ? err.message : String(err);
      summaryText = fields.label ? String(fields.label) : fallbackSummary(fields);
    }
    upsertCard.run(
      installationId,
      JSON.stringify(fields),
      summaryText,
      Object.keys(fields).length,
    );
    return { summary_text: summaryText, summary_error: summaryError, field_count: Object.keys(fields).length };
  };
}

// renderDefaultSummary(fields) → string
//
// Picks a human-readable summary from the extracted fields using the
// closed-grammar resolver. We try `{count}` first, then fall back to
// a few well-known label patterns. Anything more elaborate requires
// an explicit `card.template` field in the spec — that's a future
// iteration when the form wizard (PHA-2448) lands and operators want
// full control over the rendered string.
//
// The grammar check itself is the point: every brace expression
// goes through `placeholder.resolve`, which is the spec-side
// enforcement point for "NOT a general template language".
function renderDefaultSummary(fields) {
  // The default summary template is closed-grammar; `count` is a
  // standard extracted field across every reference template.
  // `recent` (when present) is the list of latest series names.
  const count = fields.count;
  const recent = fields.recent;
  const label = fields.label;
  if (Number.isFinite(count) && Array.isArray(recent) && recent.length > 0) {
    return placeholder.resolve('{count} {label} · {recent_added} added this week', {
      count, label: label || 'items', recent_added: recent.length,
    });
  }
  if (Number.isFinite(count)) {
    return placeholder.resolve('{count} {label}', {
      count, label: label || 'items',
    });
  }
  if (label) {
    return placeholder.resolve('{label}', { label });
  }
  // Last resort: stringify the field map. The renderer is allowed
  // to show this verbatim — no brace interpolation here, no grammar
  // risk.
  return fallbackSummary(fields);
}

function fallbackSummary(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(' · ') || '(no fields)';
}

// ---- entities adapter ---------------------------------------------------
//
// Writes:
//   * entities (upsert by kind + source_service + source_id)
//   * entity_edges (insert or update availability edge to the installation)
//
// The existing entity-graph schema (lib/sync/_schema.js) already
// provides the tables; this adapter is a thin upsert shell. We do
// NOT reuse lib/sync/plex.js or lib/dedup/matcher.js because those
// operate on a candidate-merging shape; here we have a single
// authoritative source_id from the connector spec, so a direct
// upsert is correct.
//
// Acceptance bullet: "Entity graph upsert creates comic_series
// nodes + available_at edges + deep links to the Komga series
// detail page." We honor:
//   * `entities[i].kind`            → entities.kind
//   * `entities[i].id`              → entities.source_id (stable external id)
//   * `entities[i].name`            → entities.name (and .slug via canonicalization)
//   * `entities[i].url`             → entity_edges.deep_link
//   * `installation_id`             → the from_id of the available_at edge
//                                    (resolved via the connector-installation
//                                    "tenant" entity — created if missing)
//   * spec.surfaces.entities.kind   → entity_edges.type  (default 'available_at')
//
// The deep_link is the URL the connector surface carries — typically
// a per-entity detail page (Komga's `/series/<id>`). That's how
// Tyler's [[Dune]]-style entity links route from the wall card
// straight into the source app.
function makeEntitiesAdapter(db) {
  const upsertEntity = db.prepare(`
    INSERT INTO entities
      (id, kind, name, slug, meta_json, created_at, updated_at,
       created_by, source_service, source_id, name_lower)
    VALUES (@id, @kind, @name, @slug, @meta_json, @now, @now,
            'connector:' || @source_service, @source_service, @source_id, @name_lower)
    ON CONFLICT(kind, source_service, source_id) WHERE source_id IS NOT NULL
    DO UPDATE SET
      name       = excluded.name,
      slug       = excluded.slug,
      name_lower = excluded.name_lower,
      meta_json  = excluded.meta_json,
      updated_at = excluded.updated_at
  `);
  const getEntity = db.prepare(`
    SELECT id FROM entities
     WHERE kind = ? AND source_service = ? AND source_id = ?
  `);
  const ensureInstallationEntity = db.prepare(`
    INSERT OR IGNORE INTO entities
      (id, kind, name, slug, meta_json, created_at, updated_at,
       created_by, source_service, source_id, name_lower)
    VALUES (?, 'connector_installation', ?, ?, '{}', ?, ?,
            'connector:installation', 'connector_install', ?, ?)
  `);
  const getInstallationEntity = db.prepare(`
    SELECT id FROM entities WHERE kind = 'connector_installation' AND source_id = ?
  `);
  const upsertEdge = db.prepare(`
    INSERT INTO entity_edges
      (id, from_id, to_id, type, source_service, source_id,
       deep_link, meta_json, weight, created_by, created_at, updated_at, stale)
    VALUES (@id, @from_id, @to_id, @type, @source_service, @source_id,
            @deep_link, '{}', 1.0, 'connector:' || @source_service, @now, @now, 0)
    ON CONFLICT(from_id, to_id, type, source_service, source_id)
    DO UPDATE SET
      deep_link  = excluded.deep_link,
      updated_at = excluded.updated_at,
      stale      = 0
  `);

  return async function entities(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ConnectorSurfaceError('invalid_snapshot', 'entities adapter requires a snapshot object', 'entities');
    }
    const installationId = readInstallationId(snapshot);
    if (installationId == null) {
      throw new ConnectorSurfaceError('missing_installation_id', 'entities snapshot is missing installationId', 'entities');
    }
    const list = Array.isArray(snapshot.entities) ? snapshot.entities : [];
    if (list.length === 0) return { upserted: 0, edges: 0 };
    const sourceService = snapshot.specId || 'connector';
    const specKind = (list[0] && list[0].kind) || 'unknown';
    const edgeType = (list[0] && list[0].edge_type) || 'available_at';

    const now = new Date().toISOString();
    const installationEntityId = ensureInstallationEntityNode(
      db, upsertEntity, getEntity, ensureInstallationEntity, getInstallationEntity,
      installationId, sourceService, now,
    );

    let upserted = 0;
    let edges = 0;
    const txn = db.transaction(() => {
      for (const item of list) {
        if (!item || item.id == null) continue;
        const kind = item.kind || specKind;
        const name = item.name != null ? String(item.name) : '(unnamed)';
        const url = item.url != null ? String(item.url) : null;
        const sourceId = String(item.id);
        const slug = slugify(name, kind, sourceId);
        const nameLower = name.toLowerCase();
        const metaJson = JSON.stringify({
          installation_id: installationId,
          spec_id: sourceService,
          url,
        });
        upsertEntity.run({
          id: stableEntityId(kind, sourceService, sourceId),
          kind, name, slug, meta_json: metaJson, now,
          source_service: sourceService, source_id: sourceId,
          name_lower: nameLower,
        });
        upserted += 1;
        // After upsert, look the row back up so we have the
        // canonical entity id (the PK is computed, but in the rare
        // case the row pre-existed with a different id we still
        // need the FK target).
        const row = getEntity.get(kind, sourceService, sourceId);
        if (!row) continue;
        upsertEdge.run({
          id: stableEdgeId(installationEntityId, row.id, edgeType, sourceService, sourceId),
          from_id: installationEntityId,
          to_id: row.id,
          type: edgeType,
          source_service: sourceService,
          source_id: sourceId,
          deep_link: url,
          now,
        });
        edges += 1;
      }
    });
    txn();
    return { upserted, edges };
  };
}

// Ensure the connector installation itself has a node in the entity
// graph so edges can target it. The "tenant" entity carries the
// installation id as source_id and the spec name (or install name)
// as display name. Created-once-per-installation via INSERT OR IGNORE.
function ensureInstallationEntityNode(
  db, _upsertEntity, _getEntity, ensureInstallationEntity, getInstallationEntity,
  installationId, sourceService, now,
) {
  const existing = getInstallationEntity.get(String(installationId));
  if (existing) return existing.id;
  // Pull the user-facing install name if we can; the schema doesn't
  // join here for performance reasons, so fall back to a stable label.
  let name = `Connector installation #${installationId}`;
  try {
    const row = db.prepare(`
      SELECT install_name FROM connector_installations WHERE id = ?
    `).get(installationId);
    if (row && row.install_name) name = String(row.install_name);
  } catch (_) { /* table missing in tests — keep default */ }
  const slug = `install-${installationId}`;
  const id = stableEntityId('connector_installation', 'connector_install', String(installationId));
  ensureInstallationEntity.run(id, name, slug, now, now, String(installationId), name.toLowerCase());
  const after = getInstallationEntity.get(String(installationId));
  return after ? after.id : id;
}

// Stable entity PK derived from the dedup triple. Deterministic so a
// re-run writes the same row, and short enough to index cheaply.
function stableEntityId(kind, sourceService, sourceId) {
  const h = crypto.createHash('sha256').update(`${kind}|${sourceService}|${sourceId}`).digest('hex');
  return `e_${h.slice(0, 24)}`;
}

function stableEdgeId(fromId, toId, type, sourceService, sourceId) {
  const h = crypto.createHash('sha256')
    .update(`${fromId}|${toId}|${type}|${sourceService}|${sourceId}`)
    .digest('hex');
  return `edge_${h.slice(0, 24)}`;
}

function slugify(name, kind, sourceId) {
  // Same approach as lib/dedup/matcher.js so a re-imported entity
  // doesn't change slug. Falls back to a deterministic numeric slug
  // when the name strips to nothing (rare; happens for numeric-only
  // or symbol-only labels in legacy libraries).
  const norm = (name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return norm || `${kind.toLowerCase()}-${sourceId}`.slice(0, 80) || 'untitled';
}

// ---- feed adapter -------------------------------------------------------
//
// Writes:
//   * wall_posts (one row per unique event_fingerprint)
//   * connector_feed_events (the dedupe ledger that gates the wall_posts insert)
//
// The dedupe ledger is the spec-side "exactly once per stable external
// id + event fingerprint" guarantee. A re-run with the same payload
// is a no-op. A re-run with a different payload (different
// `event_fingerprint`) is a new wall post.
//
// Per-user notification preferences:
//   * The wall_posts row lands on a wall determined by the installation
//     visibility: 'private' → the installer's personal wall (id =
//     `user:<user_id>:home`, looked up via the user's first writable
//     wall); 'group' → the household/media-club wall the user is in.
//     v1 uses a simple "first writable wall" lookup; a future
//     iteration can add explicit wall routing.
//   * Each recipient's `wall_notification_prefs` row is honored by
//     the existing notifications dispatcher — we don't bypass it.
//     Anything we send here flows through the same path as a manual
//     wall post. (See lib/walls.js + lib/notifications.js.)
//
// Acceptance bullet: "Feed event is emitted exactly once per stable
// external id + event fingerprint; respects per-user notification
// prefs." The dedupe ledger enforces the first half; the wall_posts
// shape + the existing dispatcher enforces the second half.
function makeFeedAdapter(db) {
  const findInstallation = db.prepare(`
    SELECT user_id, install_name, visibility FROM connector_installations WHERE id = ?
  `);
  const findDedup = db.prepare(`
    SELECT event_fingerprint, wall_post_id FROM connector_feed_events
     WHERE installation_id = ? AND event_fingerprint = ?
  `);
  const insertDedup = db.prepare(`
    INSERT OR IGNORE INTO connector_feed_events
      (installation_id, event_fingerprint, event_kind, stable_id, title, url, wall_post_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPost = db.prepare(`
    INSERT INTO wall_posts
      (id, wall_id, author_user_id, kind, text_body, link_url, link_title, created_at)
    VALUES (?, ?, ?, 'link', ?, ?, ?, ?)
  `);
  const findPersonalWall = db.prepare(`
    SELECT w.id
      FROM walls w
      JOIN wall_memberships m ON m.wall_id = w.id AND m.user_id = ?
     WHERE w.visibility = 'direct'
     ORDER BY w.created_at ASC
     LIMIT 1
  `);
  const findFirstWritableWall = db.prepare(`
    SELECT w.id
      FROM walls w
      JOIN wall_memberships m ON m.wall_id = w.id AND m.user_id = ?
     WHERE w.visibility IN ('direct','group')
     ORDER BY CASE WHEN w.visibility='direct' THEN 0 ELSE 1 END, w.created_at ASC
     LIMIT 1
  `);

  return async function feed(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ConnectorSurfaceError('invalid_snapshot', 'feed adapter requires a snapshot object', 'feed');
    }
    const installationId = readInstallationId(snapshot);
    if (installationId == null) {
      throw new ConnectorSurfaceError('missing_installation_id', 'feed snapshot is missing installationId', 'feed');
    }
    const events = Array.isArray(snapshot.feed) ? snapshot.feed : [];
    if (events.length === 0) return { emitted: 0, deduped: 0 };

    const installation = findInstallation.get(installationId);
    if (!installation) {
      throw new ConnectorSurfaceError(
        'installation_not_found',
        `feed adapter: installation ${installationId} not found`,
        'feed',
      );
    }
    const wallId = pickWall(db, findPersonalWall, findFirstWritableWall, installation);
    if (!wallId) {
      // No wall to post to — emit no posts but record the dedupe
      // keys so a future wall-creation doesn't trigger a flood of
      // catch-up posts for items already seen.
      const txn = db.transaction(() => {
        for (const ev of events) {
          const fp = fingerprint(installationId, snapshot.specId, ev);
          insertDedup.run(
            installationId, fp,
            eventKind(ev), stableId(ev),
            title(ev), url(ev),
            null,
            new Date().toISOString(),
          );
        }
      });
      const before = dedupeCount(db, installationId);
      txn();
      const after = dedupeCount(db, installationId);
      return { emitted: 0, deduped: after - before, wall: null };
    }

    let emitted = 0;
    let deduped = 0;
    const now = new Date().toISOString();
    const txn = db.transaction(() => {
      for (const ev of events) {
        const fp = fingerprint(installationId, snapshot.specId, ev);
        const prior = findDedup.get(installationId, fp);
        if (prior) {
          deduped += 1;
          continue;
        }
        const postId = crypto.randomUUID();
        const body = renderEventBody(installation, ev);
        const linkUrl = url(ev);
        insertPost.run(
          postId, wallId, installation.user_id,
          body, linkUrl, title(ev),
          now,
        );
        insertDedup.run(
          installationId, fp,
          eventKind(ev), stableId(ev),
          title(ev), linkUrl,
          postId,
          now,
        );
        emitted += 1;
      }
    });
    txn();
    return { emitted, deduped, wall: wallId };
  };
}

function pickWall(db, findPersonalWall, findFirstWritableWall, installation) {
  if (installation.visibility === 'private') {
    const row = findPersonalWall.get(installation.user_id);
    if (row) return row.id;
  }
  const row = findFirstWritableWall.get(installation.user_id);
  return row ? row.id : null;
}

function dedupeCount(db, installationId) {
  const row = db.prepare(
    `SELECT COUNT(*) c FROM connector_feed_events WHERE installation_id = ?`
  ).get(installationId);
  return row ? row.c : 0;
}

function eventKind(ev) {
  if (!ev || typeof ev !== 'object') return 'unknown';
  if (typeof ev.kind === 'string') return ev.kind;
  // Default for connector feed events: anything the runner emits is
  // a "new" activity (the surface is named `feed` and the runner
  // maps `feed.fields` to per-row events). Future kinds (`update`,
  // `delete`) can override via the spec.
  return 'new';
}

function stableId(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.id != null) return String(ev.id);
  if (ev.stable_id != null) return String(ev.stable_id);
  if (ev.url != null) return String(ev.url);
  return null;
}

function title(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.title != null) return String(ev.title);
  if (ev.name != null) return String(ev.name);
  return null;
}

function url(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.url != null) return String(ev.url);
  if (ev.link != null) return String(ev.link);
  return null;
}

// fingerprint(installationId, specId, ev) → string
//
// Stable hash of (installation, spec, stable_id, event_kind).
// Anything that varies (the wall post id, the created_at) does NOT
// participate in the fingerprint — same payload must always yield
// the same fingerprint for the dedupe PK to work across re-runs.
function fingerprint(installationId, specId, ev) {
  const payload = [
    String(installationId),
    String(specId || ''),
    String(stableId(ev) || ''),
    String(eventKind(ev)),
  ].join('|');
  const h = crypto.createHash('sha256').update(payload).digest('hex');
  return `fp_${h.slice(0, 40)}`;
}

// renderEventBody(installation, ev) → string
//
// Human-readable wall-post body. Uses the closed-grammar placeholder
// resolver against a fixed template so feed posts look consistent
// across connectors and the grammar is verified at the spec level.
//
// Template: "{install} · {kind}: {title}"
//
// When any of those fields are missing, the resolver renders an
// empty string for that slot. The body still composes — it never
// leaks the field name verbatim.
function renderEventBody(installation, ev) {
  const installName = installation.install_name ? String(installation.install_name) : '';
  const evKind = eventKind(ev);
  const evTitle = title(ev) || '(no title)';
  return placeholder.resolve('{install} · {kind}: {title}', {
    install: installName,
    kind: evKind,
    title: evTitle,
  });
}

// ---- Shared helpers -----------------------------------------------------

function readInstallationId(snapshot) {
  if (snapshot.installationId == null) return null;
  const n = Number(snapshot.installationId);
  if (!Number.isFinite(n)) return null;
  return n;
}

// ---- Public API ---------------------------------------------------------

module.exports = {
  createAdapters,
  migrate,
  SCHEMA_SQL,
  // Exposed for tests.
  _internals: {
    classifyStatus,
    renderDefaultSummary,
    renderEventBody,
    fingerprint,
    stableEntityId,
    stableEdgeId,
    ensureInstallationEntityNode,
  },
  // Re-exported so server-side renderers can `require` one module.
  placeholder,
  ConnectorSurfaceError,
};