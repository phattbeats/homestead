// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead per-service health checker (PHA-1623, v0.0.6).
//
// Pure logic — no express, no HTTP, no SQLite prepared-statement
// closures beyond a single `db` handle. Imported by:
//   * server.js  — boots a checker for each service after migrate()
//   * scripts/test-health-checker.js — acceptance tests with a stub
//     fetch + temp SQLite
//
// Design (per PHA-1623 work order):
//   * per-service optional `health_url` (default: services.url) +
//     `health_interval_sec` (0 = opt-out, default 60s)
//   * HEAD then GET fallback, 5s timeout, from the host network
//   * 2xx / 3xx / 401 / 403 → UP (auth walls are healthy)
//   * timeouts, 5xx, conn-refused → fail; mark DOWN only after 2
//     consecutive fails (no flapping)
//   * runtime state in `service_health_state`:
//       status, last_status_code, last_checked_at, last_ok_at,
//       down_since, consecutive_fails, last_error
//   * optional DOWN-transition hook for the notifications primitive
//     (PHA-1619) — only fires if push infra is initialized
//
// All public functions are sync so the SQLite layer (better-sqlite3)
// stays simple. The actual network probe is `async` but the call
// site awaits it.

'use strict';

const PROCESS_STARTED_AT_MS = Date.now();

// Defaults — exported so tests can override.
const DEFAULTS = {
  DEFAULT_INTERVAL_SEC: 60,
  MIN_INTERVAL_SEC: 5,
  MAX_INTERVAL_SEC: 3600,
  REQUEST_TIMEOUT_MS: 5000,
  CONSECUTIVE_FAILS_FOR_DOWN: 2,
};

// Status classifications per PHA-1623 step 2.
const UP_STATUSES = new Set([200, 201, 202, 203, 204, 205, 206,
                              301, 302, 303, 304, 307, 308,
                              401, 403]);

function classifyStatus(code) {
  return UP_STATUSES.has(code) ? 'up' : 'down';
}

function clampInterval(sec) {
  const n = Number.isFinite(sec) ? sec : DEFAULTS.DEFAULT_INTERVAL_SEC;
  if (n <= 0) return 0;
  if (n < DEFAULTS.MIN_INTERVAL_SEC) return DEFAULTS.MIN_INTERVAL_SEC;
  if (n > DEFAULTS.MAX_INTERVAL_SEC) return DEFAULTS.MAX_INTERVAL_SEC;
  return n;
}

function nowIso() { return new Date().toISOString(); }

// One-shot probe. Returns { ok, code, error, elapsedMs }.
// Uses global `fetch` (Node 22+) with an AbortController for the
// 5s timeout. Tries HEAD first (lighter), falls back to GET on
// 405/501 (some apps don't implement HEAD).
async function probe(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: 'HEAD', signal: ac.signal, redirect: 'follow' });
      if (res.status === 405 || res.status === 501) {
        // Server doesn't support HEAD; retry as GET. We don't keep
        // the response body — drain it so the socket can close.
        try { await res.arrayBuffer(); } catch (_) { /* ignore */ }
        res = await fetchImpl(url, { method: 'GET', signal: ac.signal, redirect: 'follow' });
      }
    } catch (err) {
      // HEAD threw — retry once as GET in case the server is allergic
      // to HEAD (rare but real — e.g. some auth proxies).
      if (err && err.name === 'AbortError') throw err;
      res = await fetchImpl(url, { method: 'GET', signal: ac.signal, redirect: 'follow' });
    }
    const elapsedMs = Date.now() - t0;
    return { ok: classifyStatus(res.status) === 'up', code: res.status, error: null, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const msg = err && err.name === 'AbortError' ? `timeout after ${timeoutMs}ms`
              : err && err.message ? err.message
              : 'probe failed';
    return { ok: false, code: null, error: msg, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

// Compute the new state row from a probe result + previous state.
// Pure function — exported for unit testing.
function nextState(prev, probeResult) {
  const now = nowIso();
  const prev_fails = (prev && prev.consecutive_fails) || 0;
  const prev_status = (prev && prev.status) || 'unknown';

  if (probeResult.ok) {
    return {
      status: 'up',
      last_status_code: probeResult.code,
      last_checked_at: now,
      last_ok_at: now,
      // Only clear down_since when we transition UP -> UP from a DOWN
      // state. If already UP, leave down_since as NULL (idempotent).
      down_since: prev_status === 'down' ? null : (prev && prev.down_since) || null,
      consecutive_fails: 0,
      last_error: null,
      // Transition flag for the notification hook.
      transitioned: prev_status === 'down',
    };
  }

  const new_fails = prev_fails + 1;
  const is_down = new_fails >= DEFAULTS.CONSECUTIVE_FAILS_FOR_DOWN;
  return {
    status: is_down ? 'down' : 'up', // still UP until 2nd fail
    last_status_code: probeResult.code,
    last_checked_at: now,
    last_ok_at: prev && prev.last_ok_at ? prev.last_ok_at : null,
    // Stamp down_since only on the transition (up -> down).
    down_since: is_down && prev_status !== 'down'
      ? now
      : (prev && prev.down_since) || null,
    consecutive_fails: new_fails,
    last_error: probeResult.error || (probeResult.code ? `HTTP ${probeResult.code}` : 'probe failed'),
    transitioned: is_down && prev_status !== 'down',
  };
}

// SQL helpers — kept here so server.js stays declarative.
const SQL = {
  listTargets: `
    SELECT s.id, s.url, s.health_url, s.health_interval_sec,
           h.status, h.last_status_code, h.last_checked_at,
           h.last_ok_at, h.down_since, h.consecutive_fails, h.last_error
    FROM services s
    LEFT JOIN service_health_state h ON h.service_id = s.id
  `,
  getState: `SELECT * FROM service_health_state WHERE service_id = ?`,
  upsertState: `
    INSERT INTO service_health_state
      (service_id, status, last_status_code, last_checked_at,
       last_ok_at, down_since, consecutive_fails, last_error)
    VALUES (@service_id, @status, @last_status_code, @last_checked_at,
            @last_ok_at, @down_since, @consecutive_fails, @last_error)
    ON CONFLICT(service_id) DO UPDATE SET
      status = excluded.status,
      last_status_code = excluded.last_status_code,
      last_checked_at = excluded.last_checked_at,
      last_ok_at = excluded.last_ok_at,
      down_since = excluded.down_since,
      consecutive_fails = excluded.consecutive_fails,
      last_error = excluded.last_error
  `,
  listAll: `
    SELECT s.id AS service_id, s.name, s.url, s.icon, s.health_url, s.health_interval_sec,
           h.status, h.last_status_code, h.last_checked_at,
           h.last_ok_at, h.down_since, h.consecutive_fails, h.last_error
    FROM services s
    LEFT JOIN service_health_state h ON h.service_id = s.id
    ORDER BY s.sort, s.id
  `,
  deleteStateForService: `DELETE FROM service_health_state WHERE service_id = ?`,
};

// Persist a computed state to SQLite. Returns the row written.
function persistState(db, serviceId, state) {
  const row = {
    service_id: serviceId,
    status: state.status,
    last_status_code: state.last_status_code,
    last_checked_at: state.last_checked_at,
    last_ok_at: state.last_ok_at,
    down_since: state.down_since,
    consecutive_fails: state.consecutive_fails,
    last_error: state.last_error,
  };
  db.prepare(SQL.upsertState).run(row);
  return row;
}

// Public: read current state for all services (no auth — for /api/services/health).
function listAll(db) {
  return db.prepare(SQL.listAll).all().map(r => ({
    service_id: r.service_id,
    name: r.name,
    url: r.url,
    icon: r.icon,
    health_url: r.health_url || null,
    health_interval_sec: r.health_interval_sec || 0,
    status: r.status || 'unknown',
    last_status_code: r.last_status_code,
    last_checked_at: r.last_checked_at,
    last_ok_at: r.last_ok_at,
    down_since: r.down_since,
    consecutive_fails: r.consecutive_fails || 0,
    last_error: r.last_error,
  }));
}

// Public: read a single service's current state (null if unknown).
function getState(db, serviceId) {
  return db.prepare(SQL.getState).get(serviceId) || null;
}

// Build the URL to actually probe for a given service row.
// Prefers the explicit health_url; falls back to the tile url.
function probeUrlFor(service) {
  const u = (service.health_url && String(service.health_url).trim()) || service.url;
  return u;
}

// Internal: run one check for a single service, persist the result,
// and invoke the optional onDownTransition hook.
async function checkOne(db, service, hooks, opts) {
  const url = probeUrlFor(service);
  if (!url) return null; // no URL = no probe

  const prev = getState(db, service.id);
  const result = await probe(url, opts);
  const state = nextState(prev, result);
  const row = persistState(db, service.id, state);

  // Fire the DOWN-transition hook exactly once per state transition.
  if (state.transitioned && hooks && typeof hooks.onDownTransition === 'function') {
    try {
      await hooks.onDownTransition({
        service: { id: service.id, name: service.name, url: service.url, icon: service.icon },
        state: row,
      });
    } catch (err) {
      // Don't let a notification failure poison the health state.
      console.error(`[health] down-transition hook for service ${service.id}:`, err.message);
    }
  }

  return row;
}

// Public: the checker itself. Returns { stop() }.
//
// `db`           — better-sqlite3 handle (already migrated)
// `hooks`        — optional { onDownTransition, onUpTransition, log }
// `opts`         — optional { fetchImpl, requestTimeoutMs }
//
// We run N independent timers (one per enabled service) because the
// per-service interval is configurable and we don't want a slow
// service to delay a fast one. At the ~20 services Brandon mentioned,
// setInterval overhead is negligible; this is exactly the pattern
// PHA-1623 step 1 calls out ("setInterval is fine at this scale").
function start(db, hooks = {}, opts = {}) {
  if (!db) throw new Error('health-checker: db is required');

  const timers = new Map(); // serviceId -> { handle, intervalSec }
  const log = hooks.log || ((...args) => console.log('[health]', ...args));

  async function tick(serviceId) {
    const service = db.prepare(
      `SELECT id, name, url, icon, health_url, health_interval_sec
       FROM services WHERE id = ?`).get(serviceId);
    if (!service) {
      stopTimer(serviceId);
      return;
    }
    if (!probeUrlFor(service)) return;
    try {
      const row = await checkOne(db, service, hooks, opts);
      if (row) log(`service ${serviceId} (${service.name}) → ${row.status}${row.status === 'down' ? ` since ${row.down_since}` : ''}`);
    } catch (err) {
      log(`service ${serviceId} check threw:`, err.message);
    }
  }

  function startTimer(service) {
    if (timers.has(service.id)) return; // already scheduled
    const sec = clampInterval(service.health_interval_sec);
    if (sec <= 0) return; // opted out
    const handle = setInterval(() => { tick(service.id); }, sec * 1000);
    // Don't keep the event loop alive just for health checks.
    if (handle.unref) handle.unref();
    timers.set(service.id, { handle, intervalSec: sec });
  }

  function stopTimer(serviceId) {
    const t = timers.get(serviceId);
    if (!t) return;
    clearInterval(t.handle);
    timers.delete(serviceId);
  }

  function refresh() {
    const rows = db.prepare(`
      SELECT id, name, url, icon, health_url, health_interval_sec FROM services
    `).all();
    const enabledIds = new Set();
    for (const s of rows) {
      const sec = clampInterval(s.health_interval_sec);
      if (sec <= 0) continue;
      enabledIds.add(s.id);
      const existing = timers.get(s.id);
      if (!existing) {
        startTimer(s);
      } else if (existing.intervalSec !== sec) {
        // Interval changed — restart.
        stopTimer(s.id);
        startTimer(s);
      }
    }
    // Stop timers for services that no longer exist or are now disabled.
    for (const id of Array.from(timers.keys())) {
      if (!enabledIds.has(id)) stopTimer(id);
    }
  }

  // Stagger initial probes so 20 services don't all hit their hosts at
  // the same instant. Cap the per-service offset at the interval
  // itself so a 5-minute interval doesn't delay the first check by 5min.
  const initialRows = db.prepare(`
    SELECT id, name, url, icon, health_url, health_interval_sec FROM services
  `).all();
  for (const s of initialRows) {
    const sec = clampInterval(s.health_interval_sec);
    if (sec <= 0) continue;
    startTimer(s);
    const delayMs = Math.min(sec * 1000, 2000) * (Math.random() || 0.1);
    setTimeout(() => { tick(s.id); }, Math.max(50, delayMs));
    if (timers.get(s.id).handle.unref) timers.get(s.id).handle.unref();
  }

  log(`started; ${timers.size} service timer(s)`);

  return {
    stop() {
      for (const id of Array.from(timers.keys())) stopTimer(id);
      log('stopped');
    },
    refresh,
    tick, // exposed for tests
  };
}

module.exports = {
  start,
  probe,
  nextState,
  classifyStatus,
  clampInterval,
  listAll,
  getState,
  probeUrlFor,
  DEFAULTS,
  PROCESS_STARTED_AT_MS,
};
