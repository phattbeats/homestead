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
// Claims: { sub, member, username, name, groups, aud, iat, exp } (seconds).
//
// Household (PHA-4352, Brandon 2026-11-09): PHATT ID is the only source.
// The hub names the member's Authentik groups that are on its allow-list
// (`groups`, default just 'household'). A PhattId request whose claims do
// not include PHATTID_GROUP (default 'household') is 403 not_household,
// whoever it maps to. A household member with no Homestead user yet gets
// one on first use (keyed on the PHATT ID uuid through identity_links,
// never on the username), and the user's Homestead membership of that
// one group follows the claim on every PhattId request; no other group
// is touched. Such a user is a stand-in: when its member later links a
// Homestead account of their own (Settings, Link PHATT ID), the link
// moves to that account (takeOverStandIn). PHATTID_PROVISION=0 turns the
// stand-ins off (then only linked members get in).
//
// Off unless PHATTID_HUB_URL (hub base; key fetched from
// <hub>/auth/phatt-id/key) or PHATTID_HUB_KEY (pinned JWK `x`) is set.

const crypto = require('crypto');

const DEFAULT_GROUP = 'household';
const STAND_IN = 'phatt_id'; // users.auth_provider of a user made here for a household member
const DEFAULT_AUD = 'life.phatt.vip'; // Homestead's public host (homestead.phatt.vip is the Lodge's, a different server)
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
  const group = String(env.PHATTID_GROUP || '').trim().toLowerCase() || DEFAULT_GROUP;
  const provision = String(env.PHATTID_PROVISION || '').trim() !== '0';
  const issuer = String(env.HUB_PHATTID_ISSUER || env.OIDC_ISSUER || '').trim(); // the issuer Link PHATT ID writes
  return { hubUrl, pinnedX, aud, scopes, group, provision, issuer };
}

// does the hub say this PHATT ID is in the group?
function inGroup(claims, cfg) {
  return !!claims && Array.isArray(claims.groups) && claims.groups.includes(cfg.group);
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
//   identity_links.provider = 'authentik' and provider_subject =
//   claims.sub (restricted to HUB_PHATTID_ISSUER when set): the link a
//   member makes once in Homestead (Settings, Link PHATT ID; the
//   homestead OIDC provider's subject is the Authentik user uuid, the
//   same `sub` the hub signs). Ambiguous (>1 user) -> null.
//   Never by username: PHATT ID usernames are member-chosen and can be
//   renamed, so an equal name is not the same person (PHA-4352).
function resolveUser(db, claims, env = process.env) {
  const issuer = env.HUB_PHATTID_ISSUER;
  const linked = issuer
    ? db.prepare("SELECT DISTINCT user_id FROM identity_links WHERE provider = 'authentik' AND provider_subject = ? AND issuer = ?").all(String(claims.sub), issuer)
    : db.prepare("SELECT DISTINCT user_id FROM identity_links WHERE provider = 'authentik' AND provider_subject = ?").all(String(claims.sub));
  if (linked.length !== 1) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(linked[0].user_id) || null;
}

// A household member's own Homestead user: their link, or else (when
// provisioning is on) a new stand-in user linked to their PHATT ID uuid.
// The username starts from their PHATT ID username but never takes an
// existing one: a taken name gets -2, -3, ... (names are member-chosen,
// so equal names are different people). Returns the users row or null.
function resolveOrProvision(db, claims, cfg, env = process.env) {
  const found = resolveUser(db, claims, env);
  if (found || !cfg.provision || !cfg.issuer || !inGroup(claims, cfg)) return found;
  const userModel = require('./user-model');
  const identity = require('./identity');
  const base = (String(claims.username || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)) || 'member';
  const name = (b) => (b.length >= 2 ? b : `${b}-member`);
  const taken = (u) => !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(u);
  let username = name(base);
  for (let n = 2; taken(username); n++) {
    if (n > 999) return null;
    username = `${name(base).slice(0, 32 - String(n).length - 1)}-${n}`;
  }
  const display = String(claims.name || claims.username || username).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) || username;
  try {
    db.transaction(() => {
      const r = db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, auth_provider, provider_subject, claimed_at, last_seen_at)
        VALUES (?, ?, ?, '', 0, ?, ?, datetime('now'), datetime('now'))`).run(username, display, userModel.nextColor(db), STAND_IN, String(claims.sub));
      identity.linkIdentity(db, r.lastInsertRowid, 'authentik', cfg.issuer, String(claims.sub));
    })();
    console.log(`[phatt-id] household member ${claims.sub}: new Homestead user ${username}`);
  } catch (e) {
    // another request for the same member got there first (the link is UNIQUE): use theirs
    if (e.code !== 'identity_collision' && !/UNIQUE/.test(e.message)) throw e;
  }
  return resolveUser(db, claims, env);
}

// The user's membership of cfg.group follows the claim; nothing else changes.
function syncGroup(db, userId, claims, cfg) {
  const userModel = require('./user-model');
  const gid = userModel.getOrCreateGroupId(db, cfg.group);
  if (!gid) return;
  if (inGroup(claims, cfg)) db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, gid);
  else db.prepare('DELETE FROM user_groups WHERE user_id = ? AND group_id = ?').run(userId, gid);
}

// Link PHATT ID found the PHATT ID already linked to `ownerId`. If that is
// a stand-in made here (no password, no other link), the member is now
// linking their real account: move the link to `userId` and say so.
// Anything else stays a collision for an admin. -> true when moved.
function takeOverStandIn(db, ownerId, userId, provider, issuer, subject) {
  if (provider !== 'authentik' || ownerId === userId) return false;
  const u = db.prepare('SELECT auth_provider FROM users WHERE id = ?').get(ownerId);
  if (!u || u.auth_provider !== STAND_IN) return false;
  const pw = db.prepare('SELECT COUNT(*) c FROM local_credentials WHERE user_id = ?').get(ownerId).c;
  const links = db.prepare('SELECT COUNT(*) c FROM identity_links WHERE user_id = ?').get(ownerId).c;
  if (pw || links !== 1) return false;
  const r = db.prepare('UPDATE identity_links SET user_id = ? WHERE user_id = ? AND provider = ? AND issuer = ? AND provider_subject = ?')
    .run(userId, ownerId, provider, issuer, subject);
  if (r.changes !== 1) return false;
  db.prepare("UPDATE users SET auth_provider = 'phatt_id_moved', updated_at = datetime('now') WHERE id = ?").run(ownerId);
  db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(ownerId);
  console.log(`[phatt-id] ${subject}: link moved from stand-in user ${ownerId} to user ${userId}`);
  return true;
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
  DEFAULT_AUD, DEFAULT_SCOPES, DEFAULT_GROUP, PHATTID_ROUTES, STAND_IN,
  config, verifyAssertion, createKeyStore, resolveUser, requiredScope,
  inGroup, resolveOrProvision, syncGroup, takeOverStandIn,
};
