// Homestead — Cross-reference resolver (PHA-1624 Phase D, PHA-1877).
//
// Takes parsed `[[name]]` refs and resolves each one to a real entity
// in the graph. The resolution ladder (per design doc §9):
//
//   Tier 1 — deterministic name/alias match (case-insensitive exact)
//            → resolve to that entity, confidence 1.0
//   Tier 2 — fuzzy title match via the dedup matcher's trigram Jaccard
//            (≥ 0.9 confidence) → resolve + add alias
//   Tier 3 — < 0.9 confidence → create a stub entity with
//            `created_by="refs:resolver"` and `meta.unresolved=true`
//
// Side effects per resolved ref:
//   * Upserts a `mentioned_in` edge from the container to the entity.
//     The edge's `source_service` is the container kind
//     (`task|event|list_item|activity`); `source_id` is the row id of
//     the container; `meta` carries the matched alias (if any) and the
//     confidence score.
//   * For Tier 2 matches: appends an alias row on the resolved entity
//     so future deterministic matches hit it. (This is exactly the
//     `addAlias` from lib/dedup/matcher.js — we reuse it.)
//   * For Tier 3: creates a stub entity of kind `concept` keyed on a
//     deterministic slug. The resolver never *resolves* the stub — the
//     UI "create or link" picker surfaces it for the user. Future runs
//     will hit Tier 1 if the user links it.
//
// Container sources:
//   The caller hands the resolver a `container` descriptor:
//     { kind: 'task'|'event'|'list_item'|'activity',
//       id: <row id in that table>, text: <full text scanned> }
//   The resolver scans `text`, resolves every ref, and emits one
//   `mentioned_in` edge per (container, entity) pair.
//
// Idempotency:
//   `mentioned_in` is keyed on
//   (from_container_kind, from_container_id, to_id)
//   via `entity_edges.UNIQUE(from_id,to_id,type,source_service,source_id)`.
//   But the schema's `from_id`/`to_id` are entity-typed FKs; a container
//   id is NOT an entity id. We solve this by creating a sentinel
//   "container entity" for each container row on first reference, and
//   re-using it on subsequent runs. The sentinel is a `concept` entity
//   with `created_by="refs:container"` and `meta.containerKind/containerId`
//   so we can round-trip it. This keeps the schema unchanged — Phase D
//   doesn't introduce new tables.
//
// Stub lifecycle:
//   Stubs are created with `kind='concept'` and `meta.unresolved=true`.
//   When the user opens the "create or link" picker and either links
//   the stub to an existing entity (Tier 2 path with the alias
//   manually attached) or fills in real metadata, the stub is either
//   merged or kept as a placeholder. Phase D's resolver only creates
//   stubs; the picker is a separate UI concern (see public/index.html
//   in this PR).

'use strict';

const crypto = require('crypto');
const { scanForReferences } = require('./parser');
const dedup = require('../dedup/matcher');

// ---- Constants ---------------------------------------------------------

const SERVICE = 'refs:resolver';
const CONTAINER_SERVICE = 'refs:container';

// Per issue body + design doc §9 thresholds.
const FUZZY_THRESHOLD = 0.9;

// ---- Utilities ---------------------------------------------------------

function uuid() {
  return crypto.randomUUID();
}

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch (_) { return {}; }
}

// Slugify: identical to the dedup matcher's `slugify`. Mirrored here
// to avoid a circular import via matcher → refs.
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

// Deterministic container-id so a re-run finds the same sentinel row.
function containerEntityId(kind, id) {
  // Hash inputs so we don't store the raw `task:42` string in the row.
  const h = crypto.createHash('sha256').update(`${kind}:${id}`).digest('hex').slice(0, 24);
  return `container-${h}`;
}

// ---- Tier 1: deterministic name/alias match ----------------------------

// Returns the entity id for an exact lowercase-name OR alias match, or
// null. Looks across all `kind`s — refs are not kind-scoped at parse
// time, and the resolver's job is to find *the* entity the user meant.
function tier1Deterministic(db, name) {
  const want = name.toLowerCase();
  const row = db.prepare(`
    SELECT e.id FROM entities e
    WHERE e.name_lower = ?
    LIMIT 1
  `).get(want);
  if (row) return row.id;
  const aliasRow = db.prepare(`
    SELECT e.id FROM entity_aliases ea
    JOIN entities e ON e.id = ea.entity_id
    WHERE ea.alias_lower = ?
    LIMIT 1
  `).get(want);
  return aliasRow ? aliasRow.id : null;
}

// ---- Tier 2: fuzzy title match (≥ 0.9) --------------------------------

// Compute the best fuzzy match score against entity names of any kind.
// Reuses the dedup matcher's `trigrams` + `trigramJaccard` helpers
// (exported from lib/dedup/matcher.js — see module.exports there).
function tier2Fuzzy(db, name) {
  const want = name.toLowerCase().trim();
  if (!want) return null;
  // Compute trigrams for the query once.
  const wantTrigrams = dedup.trigrams(want);
  if (wantTrigrams.size === 0) return null;
  // Cap candidate scan to a reasonable set — 200 entities is plenty for
  // v1; if the graph grows past that we'll switch to FTS5 prefix + trigram.
  const candidates = db.prepare(`
    SELECT id, name, name_lower FROM entities
    WHERE name_lower LIKE ?
    LIMIT 200
  `).all(`${want.slice(0, 4)}%`);
  if (candidates.length === 0) return null;
  let best = null;
  for (const c of candidates) {
    const score = dedup.trigramJaccard(wantTrigrams, dedup.trigrams(c.name_lower));
    if (!best || score > best.score) {
      best = { entityId: c.id, score };
    }
  }
  if (!best || best.score < FUZZY_THRESHOLD) return null;
  return best;
}

// ---- Stub creation -----------------------------------------------------

// Create (or fetch) the stub entity for an unresolved ref. Stubs are
// `concept` entities keyed by slug (deterministic merge on slug means
// `[[Dune]]` and `[[dune]]` collapse to the same stub on first run).
//
// If an existing non-stub entity already has the same slug (e.g. the
// user wrote `[[Dune-Messiah]]` but the canonical entity is `Dune Messiah`
// slugged as `dune-messiah`), we return that existing entity instead of
// trying to create a duplicate slug — which would otherwise violate the
// UNIQUE constraint. Callers detect this via the `existing` field on the
// return shape.
function ensureStub(db, name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const slug = slugify(clean);
  const existing = db.prepare(`SELECT id FROM entities WHERE slug = ?`).get(slug);
  if (existing) {
    // Bump updated_at and ensure unresolved flag stays set on stubs.
    const meta = safeParse(db.prepare(`SELECT meta_json FROM entities WHERE id = ?`).get(existing.id).meta_json);
    if (meta.unresolved !== true) {
      meta.unresolved = true;
      db.prepare(`UPDATE entities SET meta_json = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(meta), existing.id);
    }
    return { id: existing.id, created: false, existing: true };
  }
  const id = uuid();
  db.prepare(`
    INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
    VALUES (?, 'concept', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)
  `).run(id, clean, slug, JSON.stringify({
    unresolved: true,
    stub_kind: 'reference',
    original_name: clean,
  }), SERVICE, SERVICE, `stub:${slug}`, clean.toLowerCase());
  return { id, created: true };
}

// ---- Container sentinel (so `mentioned_in` edges type-check) -----------

// Returns the entity id for the sentinel entity representing `container`.
// Creates it on first reference; idempotent on re-run.
function ensureContainerEntity(db, container) {
  const id = containerEntityId(container.kind, container.id);
  const existing = db.prepare(`SELECT id FROM entities WHERE id = ?`).get(id);
  if (existing) return existing.id;
  db.prepare(`
    INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
    VALUES (?, 'concept', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)
  `).run(
    id,
    `${container.kind}:${container.id}`,
    `container-${container.kind}-${container.id}`,
    JSON.stringify({
      containerKind: container.kind,
      containerId: String(container.id),
      stub_kind: 'container',
    }),
    CONTAINER_SERVICE,
    CONTAINER_SERVICE,
    `${container.kind}:${container.id}`,
    `${container.kind}:${container.id}`.toLowerCase(),
  );
  return id;
}

// ---- Mentioned-in edge --------------------------------------------------

// Upsert a `mentioned_in` edge from the container sentinel to the entity.
// Idempotent via the existing UNIQUE constraint on
// (from_id, to_id, type, source_service, source_id).
function upsertMentionedInEdge(db, { fromContainerId, toEntityId, sourceService, sourceId, confidence, matchedAlias }) {
  const existing = db.prepare(`
    SELECT id, meta_json FROM entity_edges
    WHERE from_id = ? AND to_id = ? AND type = 'mentioned_in'
      AND source_service = ? AND source_id = ?
  `).get(fromContainerId, toEntityId, sourceService, sourceId);
  const meta = { confidence, matched_alias: matchedAlias || null };
  if (existing) {
    const merged = { ...safeParse(existing.meta_json), ...meta };
    db.prepare(`
      UPDATE entity_edges SET meta_json = ?, updated_at = datetime('now'), stale = 0 WHERE id = ?
    `).run(JSON.stringify(merged), existing.id);
    return { id: existing.id, created: false };
  }
  const id = uuid();
  db.prepare(`
    INSERT INTO entity_edges
      (id, from_id, to_id, type, source_service, source_id,
       deep_link, meta_json, weight, created_by, created_at,
       updated_at, stale)
    VALUES (?, ?, ?, 'mentioned_in', ?, ?, NULL, ?, 1.0, ?, datetime('now'), datetime('now'), 0)
  `).run(id, fromContainerId, toEntityId, sourceService, sourceId,
         JSON.stringify(meta), SERVICE);
  return { id, created: true };
}

// ---- Public: resolveContainer -----------------------------------------

// Scan `container.text` for refs, resolve each, and emit the
// `mentioned_in` edges + stub entities. Returns a summary the worker
// can log.
//
// `container`:
//   { kind: 'task'|'event'|'list_item'|'activity', id: <row id>, text: <text> }
function resolveContainer(db, container, opts = {}) {
  if (!container || !container.kind || container.id == null) {
    return { refs: [], edges: 0, stubs: 0, resolved: 0, skipped: 'bad-container' };
  }
  const scan = scanForReferences(container.text || '', container.kind, { preserveRaw: true });
  if (scan.refs.length === 0) {
    return { refs: [], edges: 0, stubs: 0, resolved: 0, skipped: null };
  }

  // Ensure the container sentinel exists once per container row.
  // Wrapped in a transaction so a partial failure rolls back cleanly.
  const tx = db.transaction(() => {
    const containerEntityId = ensureContainerEntity(db, container);
    let edges = 0;
    let stubs = 0;
    let resolved = 0;
    const seen = new Set();   // de-dupe (container, entity) pairs within one scan
    const refResults = [];

    for (const ref of scan.refs) {
      const name = ref.name;
      // Tier 1
      const t1 = tier1Deterministic(db, name);
      let targetId = t1;
      let tier = t1 ? 1 : null;
      let confidence = t1 ? 1.0 : null;
      let matchedAlias = null;

      // Tier 2 (only if Tier 1 missed)
      if (!targetId) {
        const t2 = tier2Fuzzy(db, name);
        if (t2) {
          targetId = t2.entityId;
          tier = 2;
          confidence = t2.score;
          matchedAlias = name;
          // Record the alias so future deterministic matches hit Tier 1.
          dedup.addAlias(db, {
            entityId: targetId,
            alias: name,
            source: `${SERVICE}:tier2`,
          });
        }
      }

      // Tier 3 — stub
      if (!targetId) {
        const stub = ensureStub(db, name);
        if (stub) {
          targetId = stub.id;
          tier = 3;
          confidence = 0;
          stubs += stub.created ? 1 : 0;
        }
      }

      if (!targetId || tier == null) {
        refResults.push({ name, tier: null, confidence: null, entityId: null });
        continue;
      }
      resolved += 1;

      // Dedup within one scan: skip if we already emitted for (container, target).
      const k = `${targetId}`;
      if (seen.has(k)) continue;
      seen.add(k);

      // Emit the edge.
      const sourceService = `refs:${container.kind}`;
      const sourceId = String(container.id);
      const edge = upsertMentionedInEdge(db, {
        fromContainerId: containerEntityId,
        toEntityId: targetId,
        sourceService,
        sourceId,
        confidence,
        matchedAlias,
      });
      if (edge.created) edges += 1;

      refResults.push({
        name,
        tier,
        confidence,
        entityId: targetId,
        edgeId: edge.id,
      });
    }

    return { refs: refResults, edges, stubs, resolved };
  });

  return tx();
}

// ---- Public: walker ----------------------------------------------------

// Pull every container row from the data tables, scan its text fields,
// and call `resolveContainer` for each. The walker is intentionally
// simple — the cron tick is short-lived and the per-row cost is tiny.
//
// `db` — better-sqlite3 Database with the entity-graph schema installed.
// `opts`:
//   kinds: array subset of ['task','event','list_item','activity'] —
//          defaults to all four (the latter two are no-ops if their
//          tables don't exist yet).
//   onProgress: optional callback({ kind, id, refs, edges, stubs })
function resolveAllContainers(db, opts = {}) {
  const wantKinds = new Set(opts.kinds || ['task', 'event', 'list_item', 'activity']);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const summary = { containers: 0, refs: 0, resolved: 0, edges: 0, stubs: 0, byKind: {} };

  // Tasks — scan both `title` and `notes`.
  if (wantKinds.has('task')) {
    const rows = db.prepare(`SELECT id, title, notes FROM tasks`).all();
    const kindSummary = { containers: 0, refs: 0, resolved: 0, edges: 0, stubs: 0 };
    for (const r of rows) {
      const text = `${r.title || ''}\n${r.notes || ''}`;
      const res = resolveContainer(db, { kind: 'task', id: r.id, text });
      kindSummary.containers += 1;
      kindSummary.refs += res.refs.length;
      kindSummary.resolved += res.resolved;
      kindSummary.edges += res.edges;
      kindSummary.stubs += res.stubs;
      if (onProgress) onProgress({ kind: 'task', id: r.id, ...res });
    }
    summary.containers += kindSummary.containers;
    summary.refs += kindSummary.refs;
    summary.resolved += kindSummary.resolved;
    summary.edges += kindSummary.edges;
    summary.stubs += kindSummary.stubs;
    summary.byKind.task = kindSummary;
  }

  // Events — scan both `title` and `notes`.
  if (wantKinds.has('event')) {
    const rows = db.prepare(`SELECT id, title, notes FROM events`).all();
    const kindSummary = { containers: 0, refs: 0, resolved: 0, edges: 0, stubs: 0 };
    for (const r of rows) {
      const text = `${r.title || ''}\n${r.notes || ''}`;
      const res = resolveContainer(db, { kind: 'event', id: r.id, text });
      kindSummary.containers += 1;
      kindSummary.refs += res.refs.length;
      kindSummary.resolved += res.resolved;
      kindSummary.edges += res.edges;
      kindSummary.stubs += res.stubs;
      if (onProgress) onProgress({ kind: 'event', id: r.id, ...res });
    }
    summary.containers += kindSummary.containers;
    summary.refs += kindSummary.refs;
    summary.resolved += kindSummary.resolved;
    summary.edges += kindSummary.edges;
    summary.stubs += kindSummary.stubs;
    summary.byKind.event = kindSummary;
  }

  // list_item + activity are forward-compat no-ops (the underlying
  // tables don't exist yet). When they land, the walker pattern is the
  // same: SELECT id, body FROM <table>; resolveContainer({ kind, id, text }).
  if (wantKinds.has('list_item')) summary.byKind.list_item = { containers: 0, refs: 0, resolved: 0, edges: 0, stubs: 0, skipped: 'no-table' };
  if (wantKinds.has('activity')) summary.byKind.activity = { containers: 0, refs: 0, resolved: 0, edges: 0, stubs: 0, skipped: 'no-table' };

  return summary;
}

module.exports = {
  // public API
  resolveContainer,
  resolveAllContainers,
  // helpers (exported for tests + reuse)
  tier1Deterministic,
  tier2Fuzzy,
  ensureStub,
  ensureContainerEntity,
  upsertMentionedInEdge,
  // constants
  SERVICE,
  CONTAINER_SERVICE,
  FUZZY_THRESHOLD,
};