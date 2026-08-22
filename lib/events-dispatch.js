// Homestead events webhook outbound dispatcher (PHA-1617.7).
//
// Pure dispatch module — no express. Fans a household event (task
// created, chore rotated, calendar event created, push notification
// sent) out to every enabled `kind='events'` agent_endpoints row for
// the target user(s), gated by that endpoint's `event_filter`
// opt-in map (design doc §6.1).
//
// Contract (design doc §6.1/6.5 — same wire mechanics as the drawer
// dispatcher, PHA-1617.6):
//
//   * POST {user, event: {category, id, occurred_at, data}} to the
//     endpoint's URL with the same signed-header shape as the drawer:
//       X-Homestead-User           <username>
//       X-Homestead-Request-Id     <uuid>
//       X-Homestead-Timestamp      <ISO-8601>
//       X-Homestead-Signature      sha256=<HMAC_SHA256(secret, ts + "." + body)>
//       X-Homestead-Event-Category <category>
//       User-Agent                 Homestead/<version> (+https://github.com/phattbeats/homestead)
//
//   * Per-category opt-in: an endpoint only receives a category if
//     `event_filter[category] === true`. Filter is opt-in (missing/
//     falsy → not dispatched), matching the agent-endpoints.js §6.1
//     comment's `{task_created: true, chore_rotated: true}` example.
//
//   * Retry + circuit breaker: identical schedule/thresholds to the
//     drawer dispatcher — reuses `drawerDispatch.httpPostOnce` for the
//     actual HTTP attempt so both dispatchers share one HTTP/SSE/JSON
//     response parser and can't drift.
//
//   * Unlike the drawer (a synchronous chat reply the browser is
//     waiting on), events dispatch is a background fan-out with
//     nothing waiting on the result. Callers (server.js route
//     handlers) invoke `dispatchEvent` without awaiting it; failures
//     are swallowed here (logged to bookkeeping columns + the streak
//     map) so a dead harness never surfaces as a 500 on the task/
//     chore/event/push action that triggered it.
//
//   * Bookkeeping + circuit breaker: same as drawer — every attempt
//     calls `agentEndpoints.recordDispatch`, and a per-endpoint
//     in-memory consecutive-failure streak (caller-supplied Map,
//     mirrors `app.locals.drawerStreakMap`) auto-disables the
//     endpoint at `CIRCUIT_FAILURE_THRESHOLD` (5) consecutive
//     failures.

'use strict';

const crypto = require('crypto');

const agentEndpoints = require('./agent-endpoints');
const drawerDispatch = require('./drawer-dispatch');

const VERSION = require('../package.json').version || '0.0.0';

const KIND_EVENTS = agentEndpoints.KIND_EVENTS;

// Same production defaults as the drawer dispatcher (§6.5 applies to
// both). Kept on a mutable object, like drawer-dispatch's `config`, so
// tests can patch retry timing without un-const-ing anything.
const config = {
  MAX_RETRIES: 4,
  BACKOFF_MS: [1000, 4000, 16000, 60000],
  CIRCUIT_FAILURE_THRESHOLD: 5,
};

function nowIso() {
  return new Date().toISOString();
}

function newUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Resolves the `assignee`/`owner` string used across tasks/events
// ('all' | a specific username) into the list of target user rows.
// 'all' fans out to every user in the household — each gets their own
// events dispatch, scoped to their own endpoints.
function resolveTargetUsers(db, assigneeOrOwner) {
  if (assigneeOrOwner === 'all' || assigneeOrOwner == null) {
    return db.prepare('SELECT id, username, display, color FROM users ORDER BY id').all();
  }
  const row = db.prepare('SELECT id, username, display, color FROM users WHERE username = ?').get(assigneeOrOwner);
  return row ? [row] : [];
}

// Does this endpoint's event_filter opt into `category`? Opt-in only —
// a missing or falsy key means the endpoint does NOT receive it.
function isCategoryEnabled(endpointRow, category) {
  let filter;
  try {
    filter = JSON.parse(endpointRow.event_filter || '{}');
  } catch (_) {
    filter = {};
  }
  return !!(filter && filter[category] === true);
}

function buildEventBody({ user, category, data, requestId, occurredAt }) {
  return {
    user: {
      id: user.id,
      username: user.username,
      display: user.display,
      color: user.color,
    },
    event: {
      category,
      id: requestId,
      occurred_at: occurredAt,
      data: data || {},
    },
  };
}

function sign(secret, timestamp, rawBody) {
  return agentEndpoints.signPayload(secret, timestamp, rawBody);
}

// Dispatches one event to one endpoint, with retry/backoff. Mirrors
// `dispatchDrawer`'s retry loop but doesn't care about the reply body
// shape (SSE/JSON/ignored are all just "the harness ack'd it") — the
// events webhook is fire-and-forget, not a chat round-trip.
async function dispatchToEndpoint(db, ep, { user, category, data }) {
  const requestId = newUuid();
  const ts = nowIso();
  const body = buildEventBody({ user, category, data, requestId, occurredAt: ts });
  const rawBody = JSON.stringify(body);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Homestead-User': user.username,
    'X-Homestead-Request-Id': requestId,
    'X-Homestead-Timestamp': ts,
    'X-Homestead-Signature': sign(ep.secret, ts, rawBody),
    'X-Homestead-Event-Category': category,
    'User-Agent': `Homestead/${VERSION} (+https://github.com/phattbeats/homestead)`,
  };

  let attempt = 0;
  let lastError = null;
  let lastStatus = null;

  while (attempt <= config.MAX_RETRIES) {
    const result = await drawerDispatch.httpPostOnce({ url: ep.url, headers, body: rawBody });

    if (result.ok) {
      agentEndpoints.recordDispatch(db, ep.id, { statusCode: 200, error: null });
      return { ok: true, endpointId: ep.id, requestId, attempts: attempt + 1 };
    }

    lastError = result.error;
    lastStatus = result.statusCode;
    agentEndpoints.recordDispatch(db, ep.id, {
      statusCode: result.statusCode || null,
      error: result.error,
    });

    if (attempt === config.MAX_RETRIES) break;
    await new Promise(r => setTimeout(r, config.BACKOFF_MS[attempt]));
    attempt++;
  }

  return {
    ok: false, endpointId: ep.id, requestId,
    lastError, lastStatus, attempts: attempt + 1,
  };
}

// Applies the §6.5 circuit breaker to a dispatch result: updates the
// caller-supplied streak map and auto-disables the endpoint at
// `CIRCUIT_FAILURE_THRESHOLD` consecutive failures. `streakMap` is
// typically `app.locals.eventsStreakMap` — same pattern as the
// drawer's `app.locals.drawerStreakMap`, kept as a separate map since
// drawer and events endpoints trip their breakers independently.
function applyCircuitBreaker(db, streakMap, result) {
  if (!streakMap) return;
  if (result.ok) {
    streakMap.set(result.endpointId, 0);
    return;
  }
  const newStreak = (streakMap.get(result.endpointId) || 0) + (result.attempts || 1);
  streakMap.set(result.endpointId, newStreak);
  if (newStreak >= config.CIRCUIT_FAILURE_THRESHOLD) {
    const epRow = db.prepare('SELECT id, enabled FROM agent_endpoints WHERE id = ?').get(result.endpointId);
    if (epRow && epRow.enabled) {
      db.prepare('UPDATE agent_endpoints SET enabled = 0 WHERE id = ?').run(result.endpointId);
      agentEndpoints.recordDispatch(db, result.endpointId, {
        statusCode: result.lastStatus || null,
        error: `circuit_broken:${result.lastError || 'unknown'}`,
      });
    }
  }
}

// Top-level entry point. Fans `category`/`data` out to every enabled
// events endpoint owned by `user` that has opted into `category` via
// `event_filter`. Callers should NOT await this on the request/response
// path that triggered the event — call it fire-and-forget (it never
// throws; per-endpoint failures are caught and recorded).
//
//   eventsDispatch.dispatchEvent(db, streakMap, user, 'task_created', {task});
async function dispatchEvent(db, streakMap, user, category, data) {
  if (!user || !user.id) return [];
  const endpoints = agentEndpoints.listEnabledForDispatch(db, user.id, KIND_EVENTS)
    .filter(ep => isCategoryEnabled(ep, category));
  if (!endpoints.length) return [];

  return Promise.all(endpoints.map(async (ep) => {
    let result;
    try {
      result = await dispatchToEndpoint(db, ep, { user, category, data });
    } catch (err) {
      result = { ok: false, endpointId: ep.id, lastError: 'dispatch_exception', attempts: 1 };
    }
    applyCircuitBreaker(db, streakMap, result);
    return result;
  }));
}

// Fans `category`/`data` out to every user resolved from an
// 'all' | username assignee/owner string — the common case for
// task/chore/event triggers, which are scoped by assignee/owner
// rather than a single already-resolved user.
async function dispatchEventForAssignee(db, streakMap, assigneeOrOwner, category, data) {
  const users = resolveTargetUsers(db, assigneeOrOwner);
  const results = await Promise.all(
    users.map(u => dispatchEvent(db, streakMap, u, category, data))
  );
  return results.flat();
}

const __test__ = {
  get config() { return config; },
  get MAX_RETRIES() { return config.MAX_RETRIES; },
  set MAX_RETRIES(v) { config.MAX_RETRIES = v; },
  get BACKOFF_MS() { return config.BACKOFF_MS; },
  set BACKOFF_MS(v) { config.BACKOFF_MS = v; },
  buildEventBody,
  isCategoryEnabled,
  resolveTargetUsers,
  dispatchToEndpoint,
  applyCircuitBreaker,
};

module.exports = {
  KIND_EVENTS,
  MAX_RETRIES: config.MAX_RETRIES,
  BACKOFF_MS: config.BACKOFF_MS,
  CIRCUIT_FAILURE_THRESHOLD: config.CIRCUIT_FAILURE_THRESHOLD,
  sign,
  buildEventBody,
  isCategoryEnabled,
  resolveTargetUsers,
  dispatchEvent,
  dispatchEventForAssignee,
  __test__,
};
