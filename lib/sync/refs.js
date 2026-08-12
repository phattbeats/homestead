// Homestead — Cross-reference resolver sync worker (PHA-1624 Phase D, PHA-1877).
//
// Cron worker that walks every text container (tasks, events; list
// items and activity feed bodies when those tables land) and resolves
// any `[[entity-name]]` references to entities in the graph.
//
// Public surface:
//   * runRefsSync(options) →
//       { ok, added, resolved, edges, stubs, containers,
//         durationMs, errors, byKind }
//   * runRefsTickOnce(db, options?) →
//       Same shape as runRefsSync but takes an explicit `db`. Used by
//       the admin trigger endpoint and by the test harness.
//   * lastRefsSyncSummary() → object | null
//
// Cadence: every 1h, per issue acceptance. The actual cron tick lives
// in `server.js`'s boot scheduler — it just calls `runRefsTickOnce(db)`.
//
// Re-runnable: `mentioned_in` edges are keyed on
// (container_sentinel_id, target_entity_id, 'mentioned_in', refs:<kind>, container:<id>)
// via the existing UNIQUE constraint on entity_edges. Re-running the
// resolver never duplicates; it just updates `updated_at` and the meta
// blob with the latest confidence/alias.

'use strict';

const { resolveAllContainers } = require('../refs/resolver');

// ---- Worker ------------------------------------------------------------

async function runRefsTickOnce(db, options = {}) {
  const start = Date.now();
  const summary = {
    ok: false,
    added: 0,        // new entities created (Tier 3 stubs)
    resolved: 0,     // refs that resolved to a Tier 1/2/3 target
    edges: 0,        // new mentioned_in edges created
    stubs: 0,        // new stub entities (subset of `added`)
    containers: 0,   // total container rows scanned
    refs: 0,         // total `[[name]]` refs found across all containers
    durationMs: 0,
    errors: [],
    byKind: {},
    startedAt: new Date(start).toISOString(),
    finishedAt: null,
  };

  try {
    const res = resolveAllContainers(db, options);
    summary.added = res.stubs;          // "added" == new stubs for now
    summary.resolved = res.resolved;
    summary.edges = res.edges;
    summary.stubs = res.stubs;
    summary.containers = res.containers;
    summary.refs = res.refs;
    summary.byKind = res.byKind || {};
    summary.ok = true;
  } catch (e) {
    summary.errors.push({
      where: 'resolveAllContainers',
      message: e && e.message || String(e),
      stack: e && e.stack || null,
    });
  }

  summary.durationMs = Date.now() - start;
  summary.finishedAt = new Date().toISOString();
  return summary;
}

// ---- last-run summary (in-process) ------------------------------------

let _lastSummary = null;
function _recordSummary(s) { _lastSummary = s; }
function lastRefsSyncSummary() { return _lastSummary; }

// ---- runRefsSync ------------------------------------------------------

// Async orchestrator. Used by the cron tick AND by the admin manual
// trigger endpoint. Single-process serialization: a sync is in-flight
// if this flag is set. (Same pattern as runPlexSync / runKavitaSync
// in server.js — keeps HTTP requests snappy without lock files.)
let _refsRunning = false;

async function runRefsSync(options = {}) {
  if (_refsRunning) {
    return { ok: false, reason: 'in-flight', lastSummary: _lastSummary };
  }
  _refsRunning = true;
  try {
    if (!options.db) {
      return { ok: false, reason: 'no-db', errors: [{ where: 'runRefsSync', message: 'options.db is required' }] };
    }
    const summary = await runRefsTickOnce(options.db, options.tickOptions || {});
    _recordSummary(summary);
    return { ok: summary.ok, ...summary };
  } catch (e) {
    return {
      ok: false,
      reason: 'exception',
      errors: [{ where: 'runRefsSync', message: e && e.message || String(e), stack: e && e.stack || null }],
      lastSummary: _lastSummary,
    };
  } finally {
    _refsRunning = false;
  }
}

// Is a sync currently running? Used by the cron tick to skip when a
// manual admin trigger is in flight (same pattern as Plex/Kavita).
function refsSyncInFlight() { return _refsRunning; }

module.exports = {
  runRefsSync,
  runRefsTickOnce,
  lastRefsSyncSummary,
  refsSyncInFlight,
};