// Homestead drawer outbound dispatcher (PHA-1617.6).
//
// Pure dispatch module — no express, no DB schema decisions beyond
// the `agentEndpoints.recordDispatch` call (which is the bookkeeping
// hook the §6.5 retry/circuit-breaker layer needs to count
// consecutive failures).
//
// Contract (design doc §6.2–6.5):
//
//   * POST {user, message, context, snapshot} to the user's
//     configured drawer_endpoint URL with these headers:
//       X-Homestead-User           <username>
//       X-Homestead-Request-Id     <uuid>
//       X-Homestead-Timestamp      <ISO-8601>
//       X-Homestead-Signature      sha256=<HMAC_SHA256(secret, ts + "." + body)>
//       X-Homestead-Conversation-Id <conversation_id>
//       User-Agent                 Homestead/<version> (+https://github.com/phattbeats/homestead)
//
//   * Response handling:
//       - text/event-stream → consume `event: chunk` / `event: done`
//         events, accumulate text + extract tokens_in/out from `done`,
//         return {kind:'sse', text, request_id, tokens_in, tokens_out,
//         chunks, duration_ms}
//       - application/json → single shot {kind:'json', text, actions?,
//         request_id, tokens_in, tokens_out}
//       - anything else → 200 with {ignored:true} so the drawer doesn't
//         fail because the harness returned a weird shape
//
//   * Retry (exponential backoff, §6.5):
//       - 30s timeout for the SSE first chunk / JSON first byte
//       - 60s total deadline
//       - On non-2xx or timeout → BACKOFF_MS = [1s, 4s, 16s, 60s]
//         (max `config.MAX_RETRIES` retries after the initial attempt)
//
//   * Circuit breaker (§6.5):
//       - The route layer maintains an in-memory consecutive-failure
//         streak per endpoint id. After each dispatch:
//           · success → streak := 0
//           · failure → streak += <attempts> (count of HTTP attempts
//             that failed in this dispatch)
//         When streak >= `config.CIRCUIT_FAILURE_THRESHOLD` (5), the
//         route layer auto-disables the endpoint (`enabled = 0`) and
//         the drawer falls through to a "endpoint offline / auto-
//         disabled" banner instead of hanging on retries.
//
//   * Bookkeeping: every dispatch (success or failure) calls
//     `agentEndpoints.recordDispatch(endpointId, {statusCode, error})`
//     so the settings UI shows accurate `last_used_at` /
//     `last_status_code` / `last_error` columns.
//
// The shape returned to the route layer is a structured result:
//   { ok: true, kind: 'sse'|'json'|'ignored', text, request_id,
//     tokens_in, tokens_out, attempts, duration_ms, ... }
//   { ok: false, lastError, lastStatus, attempts, request_id }

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const agentEndpoints = require('./agent-endpoints');
const snapshot = require('./snapshot');

// PHA-2827.C (server-side Hearth runtime): the dispatcher short-circuits
// to lib/agent-runtime.js when the user has a default `hearth` character
// row. Both modules are optional at require-time so this file keeps
// working on a fresh main checkout where PHA-2827.B (hearth-characters)
// hasn't merged yet — production server.js requires lib/hearth-characters
// before this file sees traffic.
const agentRuntime = require('./agent-runtime');
const hearthCharacters = (function () {
  try { return require('./hearth-characters'); }
  catch (_) { return null; }
})();

const VERSION = require('../package.json').version || '0.0.0';

const KIND_DRAWER = agentEndpoints.KIND_DRAWER;

// Live config — kept on a mutable object so tests can patch
// `config.MAX_RETRIES` / `config.BACKOFF_MS` /
// `config.CIRCUIT_FAILURE_THRESHOLD` without un-const-ing anything.
// These are still the production defaults; nothing else mutates them.
const config = {
  MAX_RETRIES: 4,
  BACKOFF_MS: [1000, 4000, 16000, 60000],
  FIRST_CHUNK_TIMEOUT_MS: 30 * 1000,
  TOTAL_DEADLINE_MS: 60 * 1000,
  CIRCUIT_FAILURE_THRESHOLD: 5,
};

// Headers we never forward from / accept on the outbound request (the
// server controls every header here; we just defend against accidental
// spread).
const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
]);

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

// Look up a single enabled drawer endpoint owned by `userId`. Returns
// the full row (including the HMAC secret — needed for signing). This
// is the dispatch-side replacement for the inline SELECT the stub ran.
function findEndpoint(db, userId, endpointId) {
  return db.prepare(
    `SELECT * FROM agent_endpoints
       WHERE id = ? AND user_id = ? AND kind = ? AND enabled = 1`
  ).get(endpointId, userId, KIND_DRAWER) || null;
}

// Pull the groups for a user. The snapshot builder already does this
// (and includes them under `snapshot.user.groups`); we duplicate it
// here so the dispatcher's `user.groups` claim is also correct (matches
// the design doc §6.2 wire shape).
function getUserGroups(db, userId) {
  return db.prepare(`
    SELECT g.name FROM user_groups ug
    JOIN groups g ON g.id = ug.group_id
    WHERE ug.user_id = ?
    ORDER BY g.name COLLATE NOCASE
  `).all(userId).map(r => r.name);
}

// Build the full POST body per design doc §6.2.
function buildBody({ me, message, snapshotPayload, requestId, conversationId, view = 'drawer' }) {
  return {
    user: {
      id: me.id,
      username: me.username,
      display: me.display,
      color: me.color,
      groups: me.groups || [],
    },
    message,
    context: {
      now: nowIso(),
      tz: snapshotPayload && snapshotPayload.user && snapshotPayload.user.tz
        ? snapshotPayload.user.tz : 'UTC',
      view,
      conversation_id: conversationId,
      request_id: requestId,
    },
    // Design doc §6.2 lays out the snapshot block with the SAME flat
    // shape as /api/me/snapshot (PHA-1617.9): today_tasks, today_events,
    // overdue_tasks, active_lists, recent_activity. snapshot.build()
    // already produces this flat shape so we just pass through.
    snapshot: snapshotPayload ? {
      today_tasks: snapshotPayload.today_tasks || [],
      today_events: snapshotPayload.today_events || [],
      overdue_tasks: snapshotPayload.overdue_tasks || [],
      active_lists: snapshotPayload.lists || {},
      recent_activity: snapshotPayload.activity_recent || [],
    } : {
      today_tasks: [],
      today_events: [],
      overdue_tasks: [],
      active_lists: {},
      recent_activity: [],
    },
  };
}

// Sign per design doc §6.4:
//   X-Homestead-Signature: sha256=<hex>
//   hex = HMAC_SHA256(secret, timestamp + "." + raw_body)
function sign(secret, timestamp, rawBody) {
  return agentEndpoints.signPayload(secret, timestamp, rawBody);
}

// Single HTTP attempt against the endpoint. Resolves with either:
//   {ok: true, kind: 'sse', chunks: [...], done: {...}, headers}
//   {ok: true, kind: 'json', body: {...}, headers}
//   {ok: true, kind: 'ignored', body, headers}
//   {ok: false, error: '<reason>', statusCode?}
//
// Connection-level errors come back with ok:false and a stable `error`
// string (`connect_refused`, `connect_timeout`, `read_timeout`,
// `protocol_error`, `body_timeout`, `total_deadline`). HTTP status
// codes outside the 2xx range also come back as ok:false with the
// numeric `statusCode` so the retry layer can branch on it.
function httpPostOnce({ url, headers, body }) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return resolve({ ok: false, error: 'invalid_url' });
    }
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyBuf = Buffer.from(body, 'utf8');

    const safeHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (FORBIDDEN_OUTBOUND_HEADERS.has(k.toLowerCase())) continue;
      safeHeaders[k] = v;
    }
    safeHeaders['Content-Length'] = String(bodyBuf.length);

    const reqOpts = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      headers: safeHeaders,
    };

    let settled = false;
    const settle = (val) => { if (!settled) { settled = true; resolve(val); } };

    const totalTimer = setTimeout(() => {
      settle({ ok: false, error: 'total_deadline' });
      try { req.destroy(new Error('total_deadline')); } catch (_) {}
    }, config.TOTAL_DEADLINE_MS);

    let req;
    try {
      req = lib.request(reqOpts, (res) => {
        clearTimeout(totalTimer);
        const statusCode = res.statusCode;
        const ct = String(res.headers['content-type'] || '').toLowerCase();

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          res.on('end', () => settle({ ok: false, error: 'http_status', statusCode }));
          return;
        }

        if (ct.includes('text/event-stream')) {
          handleSse(res, settle);
          return;
        }

        if (ct.includes('application/json')) {
          handleJson(res, settle);
          return;
        }

        // Anything else (per §6.3): 200 with {ignored:true}. We still
        // drain the body so the socket can close cleanly.
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => settle({
          ok: true, kind: 'ignored',
          body: chunks.length ? Buffer.concat(chunks).toString('utf8') : '',
          headers: res.headers,
        }));
      });
    } catch (e) {
      clearTimeout(totalTimer);
      return settle({ ok: false, error: 'protocol_error', detail: e.message });
    }

    req.setTimeout(config.FIRST_CHUNK_TIMEOUT_MS, () => {
      settle({ ok: false, error: 'read_timeout' });
      try { req.destroy(new Error('read_timeout')); } catch (_) {}
    });

    req.on('error', (err) => {
      clearTimeout(totalTimer);
      if (err && err.code === 'ECONNREFUSED') return settle({ ok: false, error: 'connect_refused' });
      if (err && err.code === 'ETIMEDOUT') return settle({ ok: false, error: 'connect_timeout' });
      if (err && err.code === 'ECONNRESET') return settle({ ok: false, error: 'connect_reset' });
      return settle({ ok: false, error: 'protocol_error', detail: err.message });
    });

    try {
      req.write(bodyBuf);
      req.end();
    } catch (e) {
      clearTimeout(totalTimer);
      settle({ ok: false, error: 'protocol_error', detail: e.message });
    }
  });
}

function handleJson(res, settle) {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { /* malformed JSON — ignore */ }
    if (!parsed) return settle({ ok: true, kind: 'ignored', body: raw, headers: res.headers });
    settle({
      ok: true, kind: 'json',
      body: {
        request_id: parsed.request_id,
        text: typeof parsed.text === 'string' ? parsed.text : '',
        actions: Array.isArray(parsed.actions) ? parsed.actions : undefined,
        tokens_in: typeof parsed.tokens_in === 'number' ? parsed.tokens_in : undefined,
        tokens_out: typeof parsed.tokens_out === 'number' ? parsed.tokens_out : undefined,
      },
      headers: res.headers,
    });
  });
}

// SSE consumer: collects chunks as they arrive. Settles with the
// accumulated text + terminal `done` event when the server closes.
function handleSse(res, settle) {
  const chunks = [];
  let buffer = '';
  let doneEvent = null;

  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (!ev) continue;
      if (ev.event === 'chunk' && ev.data && typeof ev.data.text === 'string') {
        chunks.push(ev.data.text);
      } else if (ev.event === 'done' && ev.data) {
        doneEvent = ev.data;
        settle({
          ok: true, kind: 'sse',
          chunks: chunks.slice(),
          done: doneEvent,
          text: chunks.join(''),
          headers: res.headers,
        });
      } else if (ev.event === 'error') {
        settle({ ok: false, error: 'sse_error_event', detail: JSON.stringify(ev.data) });
        try { res.destroy(); } catch (_) {}
      }
    }
  });

  res.on('end', () => {
    if (doneEvent) return;
    settle({
      ok: true, kind: 'sse',
      chunks: chunks.slice(),
      done: doneEvent || {},
      text: chunks.join(''),
      headers: res.headers,
    });
  });

  res.on('error', (err) => {
    settle({ ok: false, error: 'protocol_error', detail: err.message });
  });
}

function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? '' : line.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') dataLines.push(val);
  }
  if (!dataLines.length && event === 'message') return null;
  const joined = dataLines.join('\n');
  let parsed = joined;
  try { parsed = JSON.parse(joined); } catch (_) { /* keep as string */ }
  return { event, data: parsed };
}

// Top-level entry point used by the route. Returns a structured
// result; the route layer turns it into either an SSE stream or a
// JSON response depending on `Accept`. The dispatcher returns the
// number of attempts in the result so the route can update its
// consecutive-failure streak correctly (one dispatch = up to
// `config.MAX_RETRIES + 1` attempts).
//
// PHA-2827.C (server-side Hearth runtime): before the external POST,
// check whether the user's character is `hearth` (the default character
// seeded by lib/hearth-characters.js, PHA-2827.B) AND a model-provider
// is configured (BYOK or server-staged env). If so, route through
// `lib/agent-runtime.js` instead of the external POST. The external
// POST path is unchanged.
async function dispatchDrawer(db, me, opts) {
  const { message, conversationId, endpointId } = opts;

  // PHA-2827.C: Hearth short-circuit. Only fires when the user has a
  // default `hearth` character row (seeded by PHA-2829 at first-enable).
  // Inside the gate, AND a model key is configured (BYOK via opts.byokKey
  // or server-staged env resolved by agent-runtime), we route the call
  // through lib/agent-runtime.js instead of the external POST. When the
  // key is NOT configured, return a typed `hearth_no_key` status so the
  // route layer can render the "Hearth needs a model key" fallback
  // (issue acceptance: negative case 3) — we never try the external POST
  // for a Hearth user, since the drawer's contract is "Hearth answers, or
  // Hearth tells you why it can't".
  if (agentRuntime && hearthCharacters) {
    const character = hearthCharacters.getDefaultCharacter(db, me.id);
    if (character && character.character_key === agentRuntime.CHAR_KEY_HEARTH) {
      // Per-character key resolution: the dispatcher accepts a
      // caller-resolved BYOK key via opts.byokKey; agent-runtime falls
      // back to the server-staged env var. Either path is enough to
      // short-circuit.
      const provider = opts.provider || process.env.HEARTH_PROVIDER || 'litellm';
      const key = agentRuntime.resolveKey({
        provider,
        byokKey: opts.byokKey || '',
      });
      if (!key || !key.apiKey) {
        // Hearth is the user's character but no model key is available.
        // Surface the friendly fallback rather than the external POST.
        return {
          ok: false,
          status: 'hearth_no_key',
          lastError: (key && key.reason) || 'no_key',
          attempts: 0,
          hearth: true,
        };
      }
      const hearthResult = await agentRuntime.dispatchHearth({
        db,
        me,
        message,
        conversationId,
        requestId: newUuid(),
        view: 'drawer',
        snapshotPayload: snapshot.build(db, me.username, {}),
        byokKey: opts.byokKey || '',
        // Tests can pass providerCfg (with a stubbed fetchImpl); production
        // leaves it undefined and falls through to the env-driven default.
        providerCfg: opts.providerCfg || null,
      });
      if (hearthResult.ok) {
        // Mirror the {kind: 'json', text, ...} shape the route expects.
        // No external HTTP attempts → attempts:1 so the streak math
        // stays well-defined.
        return {
          ok: true,
          kind: 'json',
          requestId: hearthResult.requestId,
          conversationId,
          text: hearthResult.text || '',
          tokensIn: hearthResult.tokensIn,
          tokensOut: hearthResult.tokensOut,
          durationMs: 0,
          chunks: [hearthResult.text || ''],
          attempts: 1,
          hearth: true,
        };
      }
      if (hearthResult.kind === 'hearth_no_key' || hearthResult.status === 'no_key') {
        return {
          ok: false,
          status: 'hearth_no_key',
          lastError: hearthResult.lastError || 'no_key',
          attempts: 0,
          hearth: true,
        };
      }
      // Provider error: surface it as a typed failure so the route can
      // render a graceful fallback (rather than auto-tripping the
      // circuit breaker on the user's external endpoint URL, which we
      // never even tried).
      return {
        ok: false,
        status: 'hearth_provider_error',
        lastError: hearthResult.lastError || 'provider_error',
        lastStatus: hearthResult.lastStatus || null,
        attempts: 0,
        hearth: true,
      };
    }
  }

  const ep = findEndpoint(db, me.id, endpointId);
  if (!ep) return { ok: false, status: 'endpoint_not_found', attempts: 0 };

  // Snapshot is the morning-brief envelope (design doc §7), the same
  // shape `/api/me/snapshot` returns. Building it here (rather than at
  // the route) keeps the dispatcher testable in isolation.
  const snapshotPayload = snapshot.build(db, me.username, {});

  const requestId = newUuid();
  const ts = nowIso();
  const body = buildBody({
    me: { ...me, groups: getUserGroups(db, me.id) },
    message,
    snapshotPayload,
    requestId,
    conversationId,
    view: 'drawer',
  });
  const rawBody = JSON.stringify(body);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream, application/json',
    'X-Homestead-User': me.username,
    'X-Homestead-Request-Id': requestId,
    'X-Homestead-Timestamp': ts,
    'X-Homestead-Signature': sign(ep.secret, ts, rawBody),
    'X-Homestead-Conversation-Id': conversationId,
    'User-Agent': `Homestead/${VERSION} (+https://github.com/phattbeats/homestead)`,
  };

  let attempt = 0;
  let lastError = null;
  let lastStatus = null;
  const startedAt = Date.now();

  // Up to MAX_RETRIES attempts. Each failed attempt waits
  // BACKOFF_MS[i] before the next one. The loop bails on first success.
  while (attempt <= config.MAX_RETRIES) {
    const result = await httpPostOnce({ url: ep.url, headers, body: rawBody });

    if (result.ok) {
      agentEndpoints.recordDispatch(db, ep.id, {
        statusCode: 200,
        error: null,
      });
      // Extract tokens from the SSE `done` event or the JSON body so
      // the route layer can echo them back to the frontend.
      const tokensIn = result.kind === 'json' && result.body
        ? result.body.tokens_in
        : (result.kind === 'sse' && result.done ? result.done.tokens_in : undefined);
      const tokensOut = result.kind === 'json' && result.body
        ? result.body.tokens_out
        : (result.kind === 'sse' && result.done ? result.done.tokens_out : undefined);
      return {
        ok: true,
        kind: result.kind,
        requestId,
        conversationId,
        text: result.kind === 'sse' ? result.text
          : result.kind === 'json' ? (result.body && result.body.text) || ''
          : '',
        actions: result.kind === 'json' && result.body ? result.body.actions : undefined,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
        chunks: result.kind === 'sse' ? result.chunks : undefined,
        attempts: attempt + 1,
      };
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
    ok: false,
    status: 'endpoint_offline',
    lastError,
    lastStatus,
    requestId,
    conversationId,
    attempts: attempt + 1,
  };
}

// Test-only export of the live config so test scripts can patch
// MAX_RETRIES / BACKOFF_MS / threshold without un-const-ing anything.
// The retry loop reads `config.MAX_RETRIES` and `config.BACKOFF_MS`
// on every iteration, so swapping the array (or the number) here
// takes effect immediately. We mirror MAX_RETRIES + BACKOFF_MS as
// top-level fields too — that's what the tests touch directly with
// `__test__.BACKOFF_MS[0] = 5` style mutations.
const __test__ = {
  get config() { return config; },
  get MAX_RETRIES() { return config.MAX_RETRIES; },
  set MAX_RETRIES(v) { config.MAX_RETRIES = v; },
  get BACKOFF_MS() { return config.BACKOFF_MS; },
  set BACKOFF_MS(v) { config.BACKOFF_MS = v; },
  buildBody,
  sign,
  parseSseBlock,
  findEndpoint,
  getUserGroups,
  httpPostOnce,
};

module.exports = {
  KIND_DRAWER,
  MAX_RETRIES: config.MAX_RETRIES,
  BACKOFF_MS: config.BACKOFF_MS,
  FIRST_CHUNK_TIMEOUT_MS: config.FIRST_CHUNK_TIMEOUT_MS,
  TOTAL_DEADLINE_MS: config.TOTAL_DEADLINE_MS,
  CIRCUIT_FAILURE_THRESHOLD: config.CIRCUIT_FAILURE_THRESHOLD,
  dispatchDrawer,
  // exported for unit tests
  findEndpoint,
  getUserGroups,
  buildBody,
  sign,
  parseSseBlock,
  httpPostOnce,
  __test__,
};
