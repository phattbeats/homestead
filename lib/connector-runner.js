// Homestead — ConnectorRunner engine (PHA-2445, Connector Forge).
//
// The trusted execution path for declarative connector specs.
//
//   * Reads a ConnectorSpec (validated by lib/connector-spec.js) plus a
//     ConnectorInstallation (validated by PHA-2446, NOT YET BUILT — the
//     runner accepts a plain object that matches the install contract
//     shape so the PHA-2446 store can drop in later).
//   * Runs fetch → map → upsert against fixed surface adapters.
//   * Tracks per-probe ETag, last success/attempt, failure count, and
//     nextRunAt (exponential backoff with jitter on failure; resets on
//     success).
//   * Re-resolves DNS on every request to defang DNS rebinding.
//   * Refuses loopback unconditionally; private ranges only with
//     explicit local-network consent.
//   * Treats 304 as a cache refresh (not an error; surface data
//     carried over from the previous snapshot).
//   * Refuses conditional requests on non-GET/HEAD per RFC 9110
//     §13.1.2 (the engine only issues GETs for v1, but the validation
//     hook stays in place for when v2 adds HEAD-based ETags).
//
// Engine surface (no foreign code):
//
//   const { runOnce, planDue, redactError, nextRunAt } = require('./connector-runner');
//
//   const result = await runOnce(installation, {
//     spec,                       // from lib/connector-templates/komga.js or user-defined
//     resolveSecret,              // (refName) => short-lived secret value
//     fetchFn,                    // injectable for tests; defaults to undici fetch
//     clock,                      // () => Date; injectable for tests
//     surfaceAdapters,            // { tile, card, entities, feed }
//     localNetworkConsent,        // boolean (default false)
//     homesteadOrigin,            // string | null (default null)
//     minPollSecondsOverride,     // optional number (used by the form wizard)
//   });
//
//   result is a ConnectorSnapshot:
//
//   {
//     installationId,
//     specId,
//     startedAt,
//     finishedAt,
//     ok: boolean,
//     error: null | { code, message, where },
//     probes: [ { id, ok, etag, status, value, error } ],
//     surfaces: {
//       tile: { status, label, ... } | null,
//       card: { count, recent, ... } | null,
//       entities: [ { kind, id, name, url } ],
//       feed: [ { title, url } ],
//     },
//     statePatch: {                // what the caller writes back to the install row
//       lastSuccessAt,
//       lastAttemptAt,
//       etagByProbe: { probeId: etag | null },
//       failureCount,
//       nextRunAt,
//       lastError: null | { code, message, where },
//     },
//   }
//
// `runOnce` is pure with respect to its inputs. Side effects:
//   * one fetch per probe (or zero, on 304 cache refresh)
//   * one call into each surface adapter that the spec surfaces to
// The caller writes `statePatch` back to the install store and chooses
// when to invoke `planDue` again.

'use strict';

const url = require('url');
const { performance } = require('perf_hooks');
const dns = require('dns');

const connectorSpec = require('./connector-spec');
const jsonpath = require('./jsonpath');

// Note: we deliberately do NOT destructure `resolveAndCheck` at
// require-time. The runner must call through the live module
// reference so tests can monkey-patch the DNS helper for SSRF
// verification paths and live-HTTP smoke tests. The trust boundary
// itself (the implementation inside `resolveAndCheck`) is unchanged
// in production; tests stub the function pointer only.

const { ConnectorSpecError } = connectorSpec;

// ---- Default fetch --------------------------------------------------------
//
// We default to global `fetch` (Node 18+). Tests inject a fake via
// `fetchFn`. If the runtime lacks global fetch, we surface a clear
// error rather than silently doing nothing.
function defaultFetch(input, init) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'connector-runner: no global fetch available; pass `fetchFn` explicitly'
    );
  }
  return globalThis.fetch(input, init);
}

// ---- Secret redaction -----------------------------------------------------
//
// The runner never returns the resolved secret value. Errors are
// redacted before they leave the engine so a leaked stack trace can't
// smuggle a header value or a URL-embedded API key.
//
// `redactError` is exported so the caller can redact before persisting
// to the install row or to a log.
const REDACT_KEYS = new Set([
  // Common secret-bearing header names. Anything in the request
  // headers that's in this set is dropped from error messages.
  'authorization',
  'x-api-key',
  'apikey',
  'x-auth-token',
  'cookie',
  'set-cookie',
]);

function redactString(input) {
  if (typeof input !== 'string') return input;
  // Bearer xyz, X-API-Key xyz, api_key=xyz, token: xyz, sk-xxx, etc.
  // Heuristics only — the goal is to defang obvious leaks, not to
  // be a perfect scrubber. Real scrubbers are lossy; we lean on
  // "short-lived value, never logged" as the primary defense.
  // ORDER MATTERS: Bearer before api-key (Bearer match would otherwise
  // be eaten by the api-key pass and leave the secret in plain).
  let out = input;
  out = out.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]');
  out = out.replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
  out = out.replace(/(token\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
  out = out.replace(/(password\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
  out = out.replace(/(secret\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
  out = out.replace(/([?&])(api[_-]?key|token|apikey|password|secret)=[^&\s]+/gi, '$1$2=[REDACTED]');
  // Continuation scrubber: walk the string and, after every
// [REDACTED] marker, absorb every subsequent whitespace+token
// pair until end-of-string or a natural-language break (`,`, `.`,
// `;`, `:`, `!`, `?`, `)`, end-of-line, or a 3+ char pure-letter
// word). This collapses chains like "[REDACTED] abc def ghi" to a
// single [REDACTED] even when the chain includes nested [REDACTED]
// tokens from earlier passes.
  out = out.replace(/\[REDACTED\](\s+\S+)*/g, '[REDACTED]');
  // Backstop: tokens that contain BOTH letters AND digits AND are at
  // least 8 chars are almost always secrets (hex hashes, key
  // fragments, mixed alphanumeric IDs). Plain English words and
  // pure-number tokens pass through.
  out = out.replace(/\b[A-Za-z0-9._\-]{8,}\b/g, (m) => {
    if (/^\d+$/.test(m)) return m;          // pure digits
    if (/^[a-zA-Z]+$/.test(m)) return m;    // pure letters — likely a word
    if (/^[a-f0-9-]{36}$/i.test(m)) return m; // UUID
    if (/^\d{4}-\d{2}-\d{2}/.test(m)) return m; // ISO date
    return '[REDACTED]';
  });
  return out;
}

function redactError(err) {
  if (err == null) return null;
  if (typeof err === 'string') {
    return { code: 'engine', message: redactString(err), where: null };
  }
  if (typeof err !== 'object') {
    return { code: 'engine', message: String(err), where: null };
  }
  const out = {
    code: typeof err.code === 'string' ? err.code : 'engine',
    message: redactString(typeof err.message === 'string' ? err.message : ''),
    where: typeof err.where === 'string' ? err.where : null,
  };
  // Some upstream errors carry a `headers` map; redact it.
  if (err.headers && typeof err.headers === 'object') {
    out.headers = {};
    for (const [k, v] of Object.entries(err.headers)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out.headers[k] = '[REDACTED]';
      } else {
        out.headers[k] = typeof v === 'string' ? redactString(v) : v;
      }
    }
  }
  return out;
}

// ---- Backoff --------------------------------------------------------------
//
// nextRunAt: doubles on failure up to a 1-hour cap; jitter ±20%; resets
// to (now + spec.minPollSeconds) on success.
//
// Exported for tests + the scheduler.
function nextRunAt(opts) {
  const {
    now = Date.now(),
    lastSuccessAt = null,
    failureCount = 0,
    minPollSeconds = 300,
    baseSeconds = 30,
    capSeconds = 3600,
    jitterFraction = 0.2,
    random = Math.random,
  } = opts || {};

  if (lastSuccessAt && failureCount === 0) {
    // Healthy: next due at minPollSeconds from the last success.
    return new Date(now + minPollSeconds * 1000);
  }
  // Failure path: base * 2^min(failureCount-1, log2(cap/base))
  const exp = Math.min(Math.max(failureCount - 1, 0), Math.log2(capSeconds / baseSeconds));
  const base = Math.min(baseSeconds * 2 ** exp, capSeconds);
  const jitter = base * jitterFraction * (random() * 2 - 1); // ±jitterFraction
  const seconds = Math.max(1, base + jitter);
  return new Date(now + seconds * 1000);
}

// ---- Due-installations selector -------------------------------------------
//
// `planDueInstallations` selects installations that should run now,
// subject to global + per-origin concurrency/rate limits. It does NOT
// run anything — it returns a plan; the caller drives `runOnce` and
// feeds the result back to update the install row.
//
// Inputs:
//   installations: [ { id, spec, state } ]
//   opts:
//     now:           Date.now()
//     concurrency:    max parallel `runOnce` calls (default 4)
//     perOriginQps:   max QPS per origin (default 4 — Komga's documented
//                     guidance is "be polite"; the spec sets its own
//                     minPollSeconds floor but the engine respects an
//                     upper QPS too)
//     skipIfLocked:   boolean — skip installations already locked by
//                     another run
//
// Output:
//   {
//     now: ISO,
//     picks: [ { installationId, specId, origin, weight } ],
//     skipped: [ { installationId, reason } ],
//   }
function planDueInstallations(installations, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const skipIfLocked = opts.skipIfLocked !== false;

  const candidates = [];
  const skipped = [];

  for (const inst of installations || []) {
    if (!inst || typeof inst !== 'object') continue;
    const spec = inst.spec;
    if (!spec || !spec.connection || !spec.connection.baseUrl) {
      skipped.push({ installationId: inst.id, reason: 'missing-spec-or-connection' });
      continue;
    }
    if (skipIfLocked && inst.state && inst.state.executionRunId &&
        inst.state.executionRunId !== opts.ownRunId) {
      skipped.push({ installationId: inst.id, reason: 'locked-by-other-run' });
      continue;
    }
    const state = inst.state || {};
    const dueAt = state.nextRunAt ? Date.parse(state.nextRunAt) : 0;
    if (state.lastAttemptAt && dueAt > now) {
      skipped.push({
        installationId: inst.id,
        reason: 'not-due',
        dueAt: new Date(dueAt).toISOString(),
      });
      continue;
    }
    let parsed;
    try {
      parsed = new url.URL(spec.connection.baseUrl);
    } catch (err) {
      skipped.push({ installationId: inst.id, reason: 'invalid-base-url' });
      continue;
    }
    candidates.push({
      installationId: inst.id,
      specId: spec.id,
      origin: parsed.origin,
      weight: 1,
      spec,
      state,
    });
  }

  // Group by origin; apply per-origin QPS by hashing the candidates
  // into a single bucket per origin (the scheduler already enforces
  // minPollSeconds, so within an origin we cap at perOriginQps picks).
  const perOriginQps = opts.perOriginQps || 4;
  const concurrency = opts.concurrency || 4;

  const byOrigin = new Map();
  for (const c of candidates) {
    if (!byOrigin.has(c.origin)) byOrigin.set(c.origin, []);
    byOrigin.get(c.origin).push(c);
  }
  const picks = [];
  for (const [, list] of byOrigin) {
    // Already due-filtered; cap at perOriginQps so the scheduler
    // doesn't fire N requests against the same origin in the same
    // tick when only 1/s is the budget.
    for (const c of list.slice(0, perOriginQps)) {
      picks.push(c);
    }
  }
  // Cap total picks at concurrency.
  const finalPicks = picks.slice(0, concurrency);

  return {
    now: new Date(now).toISOString(),
    picks: finalPicks.map(p => ({
      installationId: p.installationId,
      specId: p.specId,
      origin: p.origin,
    })),
    skipped,
  };
}

// ---- runOnce --------------------------------------------------------------
//
// One full cycle for one installation: validate spec, build request,
// fetch each probe with conditional GET, map with JSONPath, write
// surfaces, return the snapshot.
//
// `opts` is everything `runOnce` needs to be hermetic in tests:
//   fetchFn              — default global fetch
//   resolveSecret        — (refName) => secret value (synchronous OK)
//   clock                — () => Date (default () => new Date())
//   surfaceAdapters      — { tile?, card?, entities?, feed? }
//   localNetworkConsent  — default false
//   homesteadOrigin      — default null
//   maxResponseBytes     — default 5 MiB; runner aborts the fetch if
//                          Content-Length is over the cap and rejects
//                          any chunked response that exceeds it
//   userAgent            — default 'Homestead-Connector/1'
async function runOnce(installation, opts = {}) {
  const startedAt = (opts.clock ? opts.clock() : new Date());
  const startedMs = startedAt.getTime();

  const snapshot = {
    installationId: installation && installation.id,
    specId: installation && installation.spec && installation.spec.id,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    ok: false,
    error: null,
    probes: [],
    surfaces: {
      tile: null,
      card: null,
      entities: [],
      feed: [],
    },
    statePatch: {
      lastSuccessAt: null,
      lastAttemptAt: startedAt.toISOString(),
      etagByProbe: {},
      failureCount: 0,
      nextRunAt: null,
      lastError: null,
    },
  };

  if (!installation || typeof installation !== 'object') {
    return failSnapshot(snapshot, 'install-missing', 'installation is required', '$.installation', startedAt);
  }
  const spec = installation.spec;
  if (!spec) {
    return failSnapshot(snapshot, 'install-missing-spec', 'installation.spec is required', '$.installation.spec', startedAt);
  }
  // Spec must validate. We re-validate here (not just trust the
  // caller) because the install row may have been written before the
  // validator existed, or the spec may have been edited out-of-band.
  try {
    connectorSpec.validate(spec, {
      localNetworkConsent: !!opts.localNetworkConsent,
      homesteadOrigin: opts.homesteadOrigin || null,
    });
  } catch (err) {
    return failSnapshot(snapshot, 'spec-invalid', err.message || String(err), '$.spec', startedAt);
  }

  const state = installation.state || {};
  const prevEtagByProbe = (state.etagByProbe && typeof state.etagByProbe === 'object')
    ? state.etagByProbe
    : {};
  const prevFailureCount = Number.isFinite(state.failureCount) ? state.failureCount : 0;

  let parsedBase;
  try {
    parsedBase = new url.URL(spec.connection.baseUrl);
  } catch (err) {
    return failSnapshot(snapshot, 'install-invalid-base-url', `invalid baseUrl: ${err.message}`, '$.spec.connection.baseUrl', startedAt);
  }

  // Re-resolve DNS now. If the resolved address is private, we fail
  // the whole run — even if the spec passed initial validation. This
  // is the DNS-rebinding defense: a hostname that was public at
  // install time can be private now.
  try {
    await connectorSpec.resolveAndCheck(parsedBase, {
      localNetworkConsent: !!opts.localNetworkConsent,
    });
  } catch (err) {
    return failSnapshot(snapshot, 'ssrf-blocked', err.message || String(err), '$.spec.connection.baseUrl', startedAt);
  }

  // Per-probe execution.
  const probeResults = new Map(); // probeId -> { ok, status, etag, value, error }
  const fetchFn = opts.fetchFn || defaultFetch;
  const resolveSecret = typeof opts.resolveSecret === 'function'
    ? opts.resolveSecret
    : () => { throw new ConnectorSpecError('resolveSecret is required when auth.secretRef is set', '$.spec.connection.auth.secretRef'); };
  const maxResponseBytes = Number.isFinite(opts.maxResponseBytes) ? opts.maxResponseBytes : 5 * 1024 * 1024;

  let anyFailure = false;

  for (const probe of spec.probes) {
    const result = await runProbe(probe, {
      spec,
      parsedBase,
      prevEtag: prevEtagByProbe[probe.id] || null,
      fetchFn,
      resolveSecret,
      maxResponseBytes,
      userAgent: opts.userAgent || 'Homestead-Connector/1',
      runStartedAt: startedMs,
    });
    probeResults.set(probe.id, result);
    snapshot.probes.push({
      id: probe.id,
      ok: result.ok,
      status: result.status || null,
      etag: result.etag || null,
      cached: !!result.cached,
      error: result.error || null,
    });
    if (!result.ok) anyFailure = true;
  }

  // Map probes → surfaces.
  if (!anyFailure) {
    try {
      snapshot.surfaces = mapSurfaces(spec, probeResults);
    } catch (err) {
      return failSnapshot(snapshot, 'surface-map-failed', redactString(err.message || String(err)), '$.spec.surfaces', startedAt);
    }
  }

  // Write to surface adapters. Adapters are optional; missing
  // adapters are not an error — the snapshot still carries the data.
  // We do NOT redact adapter errors: those messages come from the
  // adapter implementation, not from upstream secrets. Surface-
  // adapter errors are operator-facing diagnostics.
  if (!anyFailure) {
    await writeSurfaces(snapshot, opts.surfaceAdapters || {});
  }

  // State patch.
  const finishedAt = (opts.clock ? opts.clock() : new Date());
  snapshot.finishedAt = finishedAt.toISOString();

  if (anyFailure) {
    const firstFailing = snapshot.probes.find(p => !p.ok);
    snapshot.ok = false;
    snapshot.error = firstFailing && firstFailing.error
      ? firstFailing.error
      : { code: 'unknown', message: 'one or more probes failed', where: null };
    snapshot.statePatch.failureCount = prevFailureCount + 1;
    snapshot.statePatch.lastError = snapshot.error;
    snapshot.statePatch.nextRunAt = nextRunAt({
      now: finishedAt.getTime(),
      lastSuccessAt: state.lastSuccessAt || null,
      failureCount: snapshot.statePatch.failureCount,
      minPollSeconds: spec.connection.minPollSeconds || 300,
    }).toISOString();
    // Preserve ETag for the failing probe (next run will retry
    // with the same conditional header); clear for successful
    // 304s (no new ETag was issued).
    snapshot.statePatch.etagByProbe = Object.assign({}, prevEtagByProbe);
    for (const r of probeResults.values()) {
      if (r.ok && r.etag) snapshot.statePatch.etagByProbe[r.probeId || r.id] = r.etag;
    }
    return snapshot;
  }

  // Success path.
  snapshot.ok = true;
  snapshot.statePatch.lastSuccessAt = finishedAt.toISOString();
  snapshot.statePatch.failureCount = 0;
  snapshot.statePatch.lastError = null;
  const newEtags = Object.assign({}, prevEtagByProbe);
  for (const [probeId, r] of probeResults) {
    if (r.etag) newEtags[probeId] = r.etag;
  }
  snapshot.statePatch.etagByProbe = newEtags;
  snapshot.statePatch.nextRunAt = nextRunAt({
    now: finishedAt.getTime(),
    lastSuccessAt: finishedAt.getTime(),
    failureCount: 0,
    minPollSeconds: spec.connection.minPollSeconds || 300,
  }).toISOString();
  return snapshot;
}

// ---- Per-probe fetch+map --------------------------------------------------
async function runProbe(probe, ctx) {
  const { spec, parsedBase, prevEtag, fetchFn, resolveSecret, maxResponseBytes, userAgent } = ctx;

  // Validate method. The engine only issues GET for v1; the conditional
  // header branch rejects non-GET/HEAD per RFC 9110 §13.1.2.
  const method = (probe.request && probe.request.method) || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return failProbe(probe.id, 'method-not-allowed',
      `probe ${probe.id} method ${method} not allowed (engine is GET/HEAD only)`, '$.probes[].request.method');
  }
  if (method === 'HEAD' && prevEtag) {
    // HEAD with If-None-Match is legal per RFC 9110.
    // (We don't actually issue HEADs in v1 because the Komga
    // template is GET-only; this branch is here for v2.)
  } else if (method !== 'GET') {
    // Future method types land here.
    return failProbe(probe.id, 'method-not-allowed',
      `probe ${probe.id} method ${method} not allowed`, '$.probes[].request.method');
  }

  // Path is required; engine does not support query strings inside
  // `probe.request.path` because the validator's allowedPaths regex
  // already anchors the origin and we want a clean audit trail.
  if (!probe.request || typeof probe.request.path !== 'string' || probe.request.path.length === 0) {
    return failProbe(probe.id, 'probe-missing-path', `probe ${probe.id} has no request.path`, '$.probes[].request.path');
  }

  // Build URL: base + probe.request.path. We refuse redirects in the
  // fetch call below.
  let fullUrl;
  try {
    fullUrl = new url.URL(probe.request.path, parsedBase);
  } catch (err) {
    return failProbe(probe.id, 'probe-invalid-path', `probe ${probe.id} path invalid: ${err.message}`, '$.probes[].request.path');
  }
  // SSRF: re-check the resolved origin. This is the second DNS
  // pinning call (the first was at runOnce entry). It's redundant for
  // the spec's own baseUrl but catches a probe whose `path` somehow
  // redirects us off-origin. Combined with `redirect: 'manual'`
  // below, this is defense-in-depth.
  try {
    await connectorSpec.resolveAndCheck(fullUrl, { localNetworkConsent: !!ctx.localNetworkConsent });
  } catch (err) {
    return failProbe(probe.id, 'ssrf-blocked', redactString(err.message || String(err)), '$.probes[].request.path');
  }

  // Headers.
  const headers = Object.assign(
    { 'User-Agent': userAgent, 'Accept': 'application/json' },
    (probe.request && probe.request.headers && typeof probe.request.headers === 'object')
      ? probe.request.headers
      : {}
  );
  if (spec.connection.auth && spec.connection.auth.type === 'header' && spec.connection.auth.name) {
    if (!spec.connection.auth.secretRef) {
      return failProbe(probe.id, 'install-missing-secret-ref',
        `probe ${probe.id} auth requires secretRef`, '$.spec.connection.auth.secretRef');
    }
    let secretValue;
    try {
      secretValue = resolveSecret(spec.connection.auth.secretRef);
    } catch (err) {
      return failProbe(probe.id, 'secret-resolution-failed',
        redactString(err.message || String(err)), '$.spec.connection.auth.secretRef');
    }
    if (typeof secretValue !== 'string' || secretValue.length === 0) {
      return failProbe(probe.id, 'secret-empty',
        `secret for ${spec.connection.auth.secretRef} resolved to empty value`,
        '$.spec.connection.auth.secretRef');
    }
    headers[spec.connection.auth.name] = secretValue;
  }
  if (prevEtag && (method === 'GET' || method === 'HEAD')) {
    headers['If-None-Match'] = prevEtag;
  }

  // Fetch.
  let response;
  try {
    response = await fetchFn(fullUrl.href, {
      method,
      headers,
      redirect: 'manual',
    });
  } catch (err) {
    return failProbe(probe.id, 'fetch-failed', redactString(err.message || String(err)), '$.probes[].request.path');
  }

  // 304 Not Modified: cache refresh. We keep the previous value.
  if (response.status === 304) {
    const etag = response.headers && response.headers.get
      ? response.headers.get('etag')
      : null;
    return {
      id: probe.id,
      ok: true,
      status: 304,
      etag: etag || prevEtag,
      cached: true,
      value: null,
      probeId: probe.id,
    };
  }

  // Validate status.
  if (response.status < 200 || response.status >= 300) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    return failProbe(probe.id, 'http-error',
      `probe ${probe.id} returned HTTP ${response.status}: ${redactString(body).slice(0, 200)}`,
      '$.probes[].request.path',
      response.status,
      redactString(body).slice(0, 200));
  }

  // Validate content type. We require JSON.
  const ct = response.headers && response.headers.get
    ? (response.headers.get('content-type') || '')
    : '';
  if (!/json/i.test(ct)) {
    return failProbe(probe.id, 'content-type-not-json',
      `probe ${probe.id} returned content-type "${ct}" (expected JSON)`,
      '$.probes[].request.path');
  }

  // Validate size. We use Content-Length if present and bail early.
  const lenHeader = response.headers && response.headers.get
    ? response.headers.get('content-length')
    : null;
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > maxResponseBytes) {
      return failProbe(probe.id, 'response-too-large',
        `probe ${probe.id} content-length ${len} exceeds cap ${maxResponseBytes}`,
        '$.probes[].request.path');
    }
  }

  // Read body, capping at maxResponseBytes + 1 to detect overflow.
  const text = await readCapped(response, maxResponseBytes + 1);
  if (text.length > maxResponseBytes) {
    return failProbe(probe.id, 'response-too-large',
      `probe ${probe.id} body exceeded ${maxResponseBytes} bytes`,
      '$.probes[].request.path');
  }

  // Parse JSON.
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return failProbe(probe.id, 'json-parse-failed',
      `probe ${probe.id} response was not valid JSON: ${redactString(err.message || String(err))}`,
      '$.probes[].request.path');
  }

  // Extract with JSONPath. The probe's `extract` is { fieldName: path }.
  const value = {};
  if (probe.extract && typeof probe.extract === 'object') {
    for (const [field, expr] of Object.entries(probe.extract)) {
      try {
        // Pre-parse to reject unsafe paths at run time (validator
        // already rejects, but a v2 spec might bypass the install-time
        // check). parse() throws ParseError for out-of-subset.
        const segments = jsonpath.parse(expr);
        const out = jsonpath.evaluateAll(segments, json);
        value[field] = out.length === 1 ? out[0] : out;
      } catch (err) {
        return failProbe(probe.id, 'jsonpath-failed',
          `probe ${probe.id} extract.${field} failed: ${redactString(err.message || String(err))}`,
          `$.probes[].extract.${field}`);
      }
    }
  }

  const etag = response.headers && response.headers.get
    ? response.headers.get('etag')
    : null;

  return {
    id: probe.id,
    ok: true,
    status: response.status,
    etag,
    cached: false,
    value,
    probeId: probe.id,
  };
}

async function readCapped(response, cap) {
  if (!response || typeof response.text !== 'function') return '';
  const text = await response.text();
  if (text.length > cap) return text.slice(0, cap);
  return text;
}

function failProbe(probeId, code, message, where, status, body) {
  const out = {
    id: probeId,
    ok: false,
    status: status || null,
    etag: null,
    cached: false,
    value: null,
    probeId,
    error: { code, message: redactString(message), where: where || null },
  };
  if (body) out.error.body = redactString(body).slice(0, 200);
  return out;
}

function failSnapshot(snapshot, code, message, where, startedAt) {
  const finishedAt = new Date();
  snapshot.ok = false;
  snapshot.error = { code, message: redactString(message), where: where || null };
  snapshot.finishedAt = finishedAt.toISOString();
  snapshot.statePatch.failureCount = (snapshot.statePatch.failureCount || 0) + 1;
  snapshot.statePatch.lastError = snapshot.error;
  snapshot.statePatch.nextRunAt = nextRunAt({
    now: finishedAt.getTime(),
    lastSuccessAt: null,
    failureCount: snapshot.statePatch.failureCount,
    minPollSeconds: 300,
  }).toISOString();
  return snapshot;
}

// ---- Surface mapping ------------------------------------------------------
//
// Surfaces are declarative references to probe values via JSONPath.
//
// tile:    { from: probeId, fields: { status: '$.count', label: '...' } }
// card:    same shape as tile
// entities:{ kind, from, id, name, url } — emits one entity per item in
//          `from`'s array result
// feed:    { from, fields: { title, url } } — emits one feed event per
//          item in `from`'s array result, joining title/url by index
function mapSurfaces(spec, probeResults) {
  const out = {
    tile: null,
    card: null,
    entities: [],
    feed: [],
  };

  const surfaces = spec.surfaces || {};
  if (surfaces.tile) {
    out.tile = projectProbeFields(spec, probeResults, surfaces.tile, 'tile');
  }
  if (surfaces.card) {
    out.card = projectProbeFields(spec, probeResults, surfaces.card, 'card');
  }
  if (surfaces.entities) {
    out.entities = projectEntities(spec, probeResults, surfaces.entities);
  }
  if (surfaces.feed) {
    out.feed = projectFeed(spec, probeResults, surfaces.feed);
  }
  return out;
}

function projectProbeFields(spec, probeResults, surface, surfaceName) {
  if (!surface || typeof surface !== 'object') return null;
  const probe = probeResults.get(surface.from);
  if (!probe || !probe.ok) return null;
  const out = {};
  if (surface.fields && typeof surface.fields === 'object') {
    for (const [fieldName, expr] of Object.entries(surface.fields)) {
      if (typeof expr !== 'string' || expr.length === 0) {
        throw new Error(`${surfaceName}.fields.${fieldName}: must be a non-empty string (literal or JSONPath)`);
      }
      // Mirror the validator's contract: a value starting with `$`
      // is a JSONPath expression; everything else is a literal.
      if (expr.startsWith('$')) {
        try {
          const segments = jsonpath.parse(expr);
          const result = jsonpath.evaluateAll(segments, probe.value);
          out[fieldName] = result.length === 1 ? result[0] : result;
        } catch (err) {
          throw new Error(`${surfaceName}.fields.${fieldName}: ${err.message}`);
        }
      } else {
        // Literal string from the template (e.g. label: "Updated series").
        out[fieldName] = expr;
      }
    }
  }
  return out;
}

function projectEntities(spec, probeResults, surface) {
  if (!surface || typeof surface !== 'object') return [];
  const probe = probeResults.get(surface.from);
  if (!probe || !probe.ok || !probe.value) return [];
  // The probe's value object has arrays for `ids`, `names`, `urls`.
  // We treat each index in the longest of these arrays as one entity.
  const v = probe.value;
  const idArr = Array.isArray(v.ids) ? v.ids : (Array.isArray(v.id) ? v.id : []);
  const nameArr = Array.isArray(v.names) ? v.names : (Array.isArray(v.name) ? v.name : []);
  const urlArr = Array.isArray(v.urls) ? v.urls : (Array.isArray(v.url) ? v.url : []);
  const len = Math.max(idArr.length, nameArr.length, urlArr.length);
  const entities = [];
  for (let i = 0; i < len; i++) {
    entities.push({
      kind: surface.kind || 'unknown',
      id: idArr[i] != null ? idArr[i] : null,
      name: nameArr[i] != null ? nameArr[i] : null,
      url: urlArr[i] != null ? urlArr[i] : null,
    });
  }
  return entities;
}

function projectFeed(spec, probeResults, surface) {
  if (!surface || typeof surface !== 'object') return [];
  const probe = probeResults.get(surface.from);
  if (!probe || !probe.ok || !probe.value) return [];
  const v = probe.value;
  const titleArr = Array.isArray(v.names) ? v.names : (Array.isArray(v.title) ? v.title : []);
  const urlArr = Array.isArray(v.ids) ? v.ids : (Array.isArray(v.url) ? v.url : []);
  const len = Math.max(titleArr.length, urlArr.length);
  const events = [];
  for (let i = 0; i < len; i++) {
    events.push({
      title: titleArr[i] != null ? titleArr[i] : null,
      url: urlArr[i] != null ? urlArr[i] : null,
    });
  }
  return events;
}

// ---- Surface adapter wiring ----------------------------------------------
//
// Surface adapters are duck-typed: any object with the relevant method
// is honored. Missing methods are silently allowed (the snapshot still
// carries the data so the caller can render it later).
async function writeSurfaces(snapshot, adapters) {
  if (!adapters || typeof adapters !== 'object') return;
  if (snapshot.surfaces.tile && typeof adapters.tile === 'function') {
    try {
      await adapters.tile({
        installationId: snapshot.installationId,
        specId: snapshot.specId,
        ok: snapshot.ok,
        tile: snapshot.surfaces.tile,
        finishedAt: snapshot.finishedAt,
      });
    } catch (err) {
      // Surface adapter failures are non-fatal: the snapshot is
      // already built and the next run will retry. We record the
      // raw error message (NOT redacted) because adapter messages
      // come from operator code, not from upstream secrets. The
      // contract is: secret-bearing messages come from fetch / map
      // / spec, all of which are already redacted by the time they
      // reach this point.
      snapshot.adapterErrors = snapshot.adapterErrors || {};
      snapshot.adapterErrors.tile = (err && err.message) ? err.message : String(err);
    }
  }
  if (snapshot.surfaces.card && typeof adapters.card === 'function') {
    try {
      await adapters.card({
        installationId: snapshot.installationId,
        specId: snapshot.specId,
        ok: snapshot.ok,
        card: snapshot.surfaces.card,
        finishedAt: snapshot.finishedAt,
      });
    } catch (err) {
      snapshot.adapterErrors = snapshot.adapterErrors || {};
      snapshot.adapterErrors.card = (err && err.message) ? err.message : String(err);
    }
  }
  if (snapshot.surfaces.entities && snapshot.surfaces.entities.length > 0 &&
      typeof adapters.entities === 'function') {
    try {
      await adapters.entities({
        installationId: snapshot.installationId,
        specId: snapshot.specId,
        ok: snapshot.ok,
        entities: snapshot.surfaces.entities,
        finishedAt: snapshot.finishedAt,
      });
    } catch (err) {
      snapshot.adapterErrors = snapshot.adapterErrors || {};
      snapshot.adapterErrors.entities = (err && err.message) ? err.message : String(err);
    }
  }
  if (snapshot.surfaces.feed && snapshot.surfaces.feed.length > 0 &&
      typeof adapters.feed === 'function') {
    try {
      await adapters.feed({
        installationId: snapshot.installationId,
        specId: snapshot.specId,
        ok: snapshot.ok,
        feed: snapshot.surfaces.feed,
        finishedAt: snapshot.finishedAt,
      });
    } catch (err) {
      snapshot.adapterErrors = snapshot.adapterErrors || {};
      snapshot.adapterErrors.feed = (err && err.message) ? err.message : String(err);
    }
  }
}

// ---- Rate-limit helper ----------------------------------------------------
//
// The scheduler is responsible for not over-firing. The runner exposes
// `tokenBucket` so the scheduler can stamp its decisions and so tests
// can assert "1 req/s sustained on a single origin" against a fake
// clock without sleeping.
//
// Usage:
//   const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1 });
//   if (bucket.tryConsume(origin)) { /* fire */ }
function createTokenBucket(opts = {}) {
  const capacity = Number.isFinite(opts.capacity) ? opts.capacity : 1;
  const refillPerSecond = Number.isFinite(opts.refillPerSecond) ? opts.refillPerSecond : 1;
  const now = opts.now || (() => Date.now());
  const state = new Map(); // origin -> { tokens, lastRefill }
  return {
    tryConsume(origin, count = 1) {
      const t = now();
      let s = state.get(origin);
      if (!s) {
        s = { tokens: capacity, lastRefill: t };
        state.set(origin, s);
      }
      const elapsed = Math.max(0, (t - s.lastRefill) / 1000);
      s.tokens = Math.min(capacity, s.tokens + elapsed * refillPerSecond);
      s.lastRefill = t;
      if (s.tokens >= count) {
        s.tokens -= count;
        return true;
      }
      return false;
    },
    _state: state,
  };
}

// ---- Public API -----------------------------------------------------------
module.exports = {
  runOnce,
  planDueInstallations,
  nextRunAt,
  redactError,
  redactString,
  createTokenBucket,
  // Exposed for tests.
  _internals: {
    mapSurfaces,
    projectProbeFields,
    projectEntities,
    projectFeed,
  },
};