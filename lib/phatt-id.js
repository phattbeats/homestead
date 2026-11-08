'use strict';

// PHATT ID assertions (`Authorization: PhattId <assertion>`).
//
// The PHATT hub (clubhouse) mints short-lived Ed25519-signed assertions
// for a signed-in member, bound to one audience host. A trusted relying
// server (The Lodge) forwards the viewer's own assertion to Homestead,
// which verifies it here and treats the request as that member — but
// only for a fixed, narrow route table (PHATTID_ROUTES below).
//
// Deny-by-default on purpose: most Homestead routes are guarded by
// `auth` alone, so the generic app-token scope check (requireScope)
// would leave tasks, events, admin and settings routes reachable. A
// PhattId request may only reach a (method, path) pair listed below
// whose scope is in the configured scope set; everything else is 403.
//
// Token: pa1.<base64url(JSON claims)>.<base64url(Ed25519 sig over "pa1.<body>")>
// Claims: { sub, member, username, name, aud, iat, exp } (seconds).
//
// Off unless PHATTID_HUB_URL (hub base; key fetched from
// <hub>/auth/phatt-id/key) or PHATTID_HUB_KEY (pinned JWK `x`) is set.

const crypto = require('crypto');

const DEFAULT_AUD = 'homestead.phatt.vip';
const DEFAULT_SCOPES = Object.freeze([
  'read:me', 'read:lists', 'write:lists', 'read:tasks', 'write:tasks', 'read:events',
]);
const KEY_TTL_MS = 60 * 60 * 1000;     // cached hub key lifetime
const REFETCH_MIN_MS = 60 * 1000;      // forced refetch at most once a minute

// The ONLY routes a PhattId request may reach. [method, path regex, scope].
// Paths are matched case-insensitively with an optional trailing slash,
// mirroring Express's non-strict, case-insensitive routing.
const ID = '[^/]+';
const PHATTID_ROUTES = Object.freeze([
  ['GET', '/api/me/snapshot', 'read:me'],
  ['GET', '/api/lists', 'read:lists'],
  ['GET', '/api/lists/stats', 'read:lists'],
  ['GET', `/api/lists/${ID}`, 'read:lists'],
  ['GET', `/api/lists/${ID}/items`, 'read:lists'],
  ['POST', '/api/lists', 'write:lists'],
  ['POST', '/api/lists/reorder', 'write:lists'],
  ['PATCH', `/api/lists/${ID}`, 'write:lists'],
  ['DELETE', `/api/lists/${ID}`, 'write:lists'],
  ['POST', `/api/lists/${ID}/items`, 'write:lists'],
  ['PATCH', `/api/list-items/${ID}`, 'write:lists'],
  ['DELETE', `/api/list-items/${ID}`, 'write:lists'],
  ['GET', '/api/tasks', 'read:tasks'],
  ['POST', '/api/tasks', 'write:tasks'],
  ['PUT', `/api/tasks/${ID}`, 'write:tasks'],
  ['POST', `/api/tasks/${ID}/toggle`, 'write:tasks'],
  ['DELETE', `/api/tasks/${ID}`, 'write:tasks'],
  ['GET', '/api/events', 'read:events'],
  ['GET', '/api/events/merged', 'read:events'],
].map(([method, p, scope]) => Object.freeze({ method, re: new RegExp(`^${p}/?$`, 'i'), scope })));

function config(env = process.env) {
  const hubUrl = String(env.PHATTID_HUB_URL || '').trim().replace(/\/+$/, '');
  const pinnedX = String(env.PHATTID_HUB_KEY || '').trim();
  if (!hubUrl && !pinnedX) return null;
  const aud = String(env.PHATTID_AUD || '').trim() || DEFAULT_AUD;
  const raw = String(env.PHATTID_SCOPES || '').trim();
  const scopes = raw ? raw.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES.slice();
  return { hubUrl, pinnedX, aud, scopes };
}

// Port of the hub's reference verifier (clubhouse server/phattid.js),
// plus try/catch so a malformed key or signature is a 401, not a 500.
function verifyAssertion(token, publicKey, { aud, now = Date.now() } = {}) {
  const [pre, body, sig] = String(token || '').split('.');
  if (pre !== 'pa1' || !body || !sig || !publicKey || !publicKey.x) return null;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.x }, format: 'jwk' });
    if (!crypto.verify(null, Buffer.from(pre + '.' + body), key, Buffer.from(sig, 'base64url'))) return null;
  } catch (_) {
    return null;
  }
  let c; try { c = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  const t = Math.floor(now / 1000);
  if (!c || !c.sub || c.aud !== aud || !(c.exp > t) || c.iat > t + 60) return null;
  return c;
}

// Hub public-key cache. Pinned key (PHATTID_HUB_KEY) wins and is never
// fetched. Otherwise GET <hub>/auth/phatt-id/key, cached KEY_TTL_MS;
// a verify failure forces a refetch, rate-limited to REFETCH_MIN_MS.
function createKeyStore({ fetchImpl = globalThis.fetch } = {}) {
  let cached = null;       // { hubUrl, key: { alg, kid, x }, fetchedAt }
  let lastFetchAt = 0;
  let inflight = null;

  async function fetchKey(hubUrl) {
    lastFetchAt = Date.now();
    try {
      const res = await fetchImpl(`${hubUrl}/auth/phatt-id/key`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`hub_${res.status}`);
      const j = await res.json();
      if (!j || j.alg !== 'Ed25519' || typeof j.x !== 'string' || !j.x) throw new Error('bad_key_document');
      cached = { hubUrl, key: { alg: j.alg, kid: j.kid, x: j.x }, fetchedAt: Date.now() };
    } catch (err) {
      console.warn('[phatt-id] key fetch failed:', err.message);
    }
    return cached && cached.hubUrl === hubUrl ? cached.key : null;
  }

  async function getKey(cfg, { force = false } = {}) {
    if (cfg.pinnedX) return { x: cfg.pinnedX };
    const mine = cached && cached.hubUrl === cfg.hubUrl ? cached : null;
    if (mine && !force && Date.now() - mine.fetchedAt < KEY_TTL_MS) return mine.key;
    if (inflight) return inflight;
    if (Date.now() - lastFetchAt < REFETCH_MIN_MS) return mine ? mine.key : null;
    inflight = fetchKey(cfg.hubUrl).finally(() => { inflight = null; });
    return inflight;
  }

  async function verify(token, cfg, { now } = {}) {
    let key = await getKey(cfg);
    let claims = key ? verifyAssertion(token, key, { aud: cfg.aud, now }) : null;
    if (claims || cfg.pinnedX) return claims;
    // Possibly a rotated hub key: refetch (rate-limited) and retry once.
    const before = key && key.x;
    key = await getKey(cfg, { force: true });
    if (!key || key.x === before) return null;
    return verifyAssertion(token, key, { aud: cfg.aud, now });
  }

  return { getKey, verify, _reset() { cached = null; lastFetchAt = 0; inflight = null; } };
}

// Map verified claims to an EXISTING Homestead user. Never provisions.
//   1. identity_links.provider_subject = claims.sub (restricted to
//      HUB_PHATTID_ISSUER when set). Ambiguous (>1 user) -> null.
//   2. Else users.username = claims.username (NOCASE, validated like
//      every other username) — unless that user already has a link
//      under HUB_PHATTID_ISSUER to a different subject.
function resolveUser(db, claims, env = process.env) {
  const issuer = env.HUB_PHATTID_ISSUER;
  const linked = issuer
    ? db.prepare('SELECT DISTINCT user_id FROM identity_links WHERE provider_subject = ? AND issuer = ?').all(String(claims.sub), issuer)
    : db.prepare('SELECT DISTINCT user_id FROM identity_links WHERE provider_subject = ?').all(String(claims.sub));
  if (linked.length > 1) return null;
  if (linked.length === 1) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(linked[0].user_id) || null;
  }
  const uname = String(claims.username || '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(uname)) return null;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (!u) return null;
  if (issuer) {
    const other = db.prepare('SELECT 1 FROM identity_links WHERE user_id = ? AND issuer = ? LIMIT 1').get(u.id, issuer);
    if (other) return null;
  }
  return u;
}

// Scope required for (method, path), or null when the route is not in
// the PhattId table. HEAD is routed like GET by Express, so treat it so.
function requiredScope(method, path) {
  const m = String(method || '').toUpperCase() === 'HEAD' ? 'GET' : String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0];
  const hit = PHATTID_ROUTES.find(r => r.method === m && r.re.test(p));
  return hit ? hit.scope : null;
}

module.exports = {
  DEFAULT_AUD, DEFAULT_SCOPES, PHATTID_ROUTES,
  config, verifyAssertion, createKeyStore, resolveUser, requiredScope,
};
