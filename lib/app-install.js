// Third-party app install flow (PHA-2201.1 / PHA-2229). Design note:
// PHA-2201 §2 (install flow) and §7 (endpoint surface).
//
// Pure DB/business logic — no express. Imported by server.js, which
// mounts the six /api/apps/* routes over these functions, and by
// scripts/test-app-install.js.
//
// State machine: resolve -> consent -> install, plus list/get/revoke/
// reinstall. `resolve` is a pure read: it fetches + validates a
// manifest and returns a preview WITHOUT writing to the DB (verified
// by the acceptance suite) — it may only ever call `.get()`/`.all()`,
// never `.run()`/`.exec()`, on the `db` handle it's given.
//
// A third-party app is a token holder, not code in Homestead's
// process (PHA-2201 §4): install mints a per-user, app-scoped PAT
// (agent_tokens.app_id) with the manifest's declared scopes, backed
// by the SAME `lib/registry-validate.js` shape check and
// `lib/scope-display.js` §3 vocabulary that built-in modules use —
// reused here, not forked.
//
// `installed_apps` (key TEXT PRIMARY KEY) is a household-shared
// catalog row, not per-user: the first household member to install an
// app fetches + caches its manifest once; every other member who
// installs the same app (by key) reuses that row and gets their own
// agent_tokens row instead of a second installed_apps insert. Per-user
// state — "is this app installed for me" — always lives on
// agent_tokens (user_id, app_id, revoked_at), never on installed_apps
// alone.
//
// "Enable the room" (PHA-2201 §2 step 5) does NOT mean minting a new
// user_modules row for the app's own key — user_modules.module_key is
// CHECK-constrained to the six built-in keys (lib/modules.js
// REGISTRY, static and frozen; PHA-2200's explicit scope discipline:
// "NOT a plugin architecture"). Third-party apps launch from the
// existing `apps` module (the tiled launcher, PHA-1863), so installing
// any third-party app ensures `apps` is enabled for that user via the
// existing `setUserModule` upsert; revoking a user's last third-party
// app disables it again.
//
// `listApps`/`getApp` (PHA-2201.4 / PHA-2232, Settings → Apps) surface
// BOTH halves of the dogfood contract: built-in modules (their
// "install" is an enabled `user_modules` row) and third-party apps
// (their install is the token exchange above) through the same
// registry-shaped response, tagged `builtin: true/false`. Built-ins
// have no app-scoped token and are never written to `app_api_log`
// (PHA-2231), so their `activity_summary` is always zero and there's
// no revoke action for them — the Settings UI hides Revoke/Activity
// for `builtin: true` rows rather than calling an endpoint that 404s.

'use strict';

const crypto = require('crypto');

const registryValidate = require('./registry-validate');
const modules = require('./modules');
const scopeDisplay = require('./scope-display');
const agentTokens = require('./agent-tokens');
const userModel = require('./user-model');
const appApiLog = require('./app-api-log');

const CONSENT_TTL_SECONDS = 60;
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

// In-memory manifest cache, keyed by manifest URL: { json, etag,
// fetchedAt }. Deliberately NOT DB-backed — `resolveManifest` must
// never write to the DB, and this is a plain read-side optimization
// that lives for the life of the process (same pattern would apply to
// any restart-cold cache; a 5-minute TTL makes that fine).
const manifestCache = new Map();

class AppInstallError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

// Loopback hosts a third-party manifest/iframe URL may never target
// outside dev mode. Scope is deliberately narrow (loopback only, per
// the PHA-2201 design note) — broader SSRF hardening (RFC1918/link-
// local ranges) is out of scope for this ticket.
function isLoopbackHost(hostname) {
  const h = (hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
}

// Third-party `url` MUST be https:// with a non-loopback host; dev
// mode (an explicit per-request flag, never a manifest property — a
// manifest can't self-declare its way past its own security check) is
// the only way to relax this, for pointing Homestead at a
// locally-running app under development.
function checkUrlSecurity(rawUrl, { dev = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new AppInstallError(422, 'manifest_invalid', `url is not a valid URL: ${rawUrl}`);
  }
  if (!dev) {
    if (parsed.protocol !== 'https:') {
      throw new AppInstallError(422, 'manifest_invalid', `url must be https:// (got "${parsed.protocol}")`);
    }
    if (isLoopbackHost(parsed.hostname)) {
      throw new AppInstallError(422, 'manifest_invalid', `url host "${parsed.hostname}" is a loopback address — not allowed outside dev mode`);
    }
  }
  return parsed;
}

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS app_consent_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manifest_url TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_consent_tokens_hash ON app_consent_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_app_consent_tokens_user ON app_consent_tokens(user_id, manifest_url);
`);
}

// Fetches a manifest JSON document, honoring the in-memory cache
// (keyed by URL, ETag conditional revalidation, 5-minute TTL). Throws
// AppInstallError(422, 'manifest_unreachable', ...) on any network
// failure/timeout/non-2xx, or AppInstallError(422, 'manifest_invalid',
// ...) if the body isn't valid JSON.
async function fetchManifest(url, { dev = false, fetchImpl } = {}) {
  checkUrlSecurity(url, { dev });
  const doFetch = fetchImpl || globalThis.fetch;

  const cached = manifestCache.get(url);
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) < MANIFEST_CACHE_TTL_MS) {
    return cached.json;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    const headers = {};
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
    res = await doFetch(url, { method: 'GET', signal: ac.signal, redirect: 'follow', headers });
  } catch (err) {
    throw new AppInstallError(422, 'manifest_unreachable', `could not fetch manifest: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304 && cached) {
    cached.fetchedAt = now;
    return cached.json;
  }
  if (!res.ok) {
    throw new AppInstallError(422, 'manifest_unreachable', `manifest fetch failed with status ${res.status}`);
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new AppInstallError(422, 'manifest_invalid', `manifest response is not valid JSON: ${err.message}`);
  }
  const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null;
  manifestCache.set(url, { json, etag, fetchedAt: now });
  return json;
}

// Structural + vocabulary validation. Throws AppInstallError(422,
// 'manifest_invalid', ...) on the first failure. Reuses
// `registry-validate.validateEntryShape` (the same check built-ins
// pass) and `scope-display.describeScopes` (the §3 vocabulary) rather
// than forking either.
function validateManifestShape(manifest, { dev = false } = {}) {
  const shapeErr = registryValidate.validateEntryShape(manifest);
  if (shapeErr) {
    throw new AppInstallError(422, 'manifest_invalid', shapeErr.message);
  }
  try {
    scopeDisplay.describeScopes(manifest.scopes, { entityKinds: manifest.entity_kinds || [] });
  } catch (err) {
    // "Unknown scopes fail validation listing valid ones" (PHA-2229) —
    // the vocabulary list rides along on the error response.
    throw new AppInstallError(422, 'manifest_invalid', err.message, { valid_scopes: scopeDisplay.SCOPE_VOCABULARY });
  }
  if (manifest.url) {
    checkUrlSecurity(manifest.url, { dev });
  }
}

// Key-collision check. `db` is optional and read-only here (no
// `.run()`/`.exec()` calls) — resolve is allowed to READ the DB, it
// just may never WRITE to it.
//   1. Built-in key collision (e.g. "wall") -> always 409, never
//      overwritten.
//   2. A DIFFERENT manifest URL already claims this key in the shared
//      installed_apps catalog -> 409 (key squatting / mistake), so a
//      second app can never silently shadow an already-installed
//      third-party app's catalog entry.
function checkKeyConflict(db, manifest, sourceUrl) {
  if (modules.isModuleKey(manifest.key)) {
    throw new AppInstallError(409, 'manifest_key_conflict', `key "${manifest.key}" collides with a built-in module — never overwritten`);
  }
  if (db) {
    const existing = db.prepare('SELECT manifest_url FROM installed_apps WHERE key = ? AND revoked_at IS NULL').get(manifest.key);
    if (existing && existing.manifest_url && existing.manifest_url !== sourceUrl) {
      throw new AppInstallError(409, 'manifest_key_conflict', `key "${manifest.key}" is already installed from a different manifest URL`);
    }
  }
}

// resolveManifest(db, url, opts) -> validated manifest object.
// No DB writes — the PHA-2229 acceptance suite verifies this directly.
async function resolveManifest(db, url, { dev = false, fetchImpl } = {}) {
  if (!url || typeof url !== 'string') {
    throw new AppInstallError(422, 'manifest_invalid', 'url is required');
  }
  const manifest = await fetchManifest(url, { dev, fetchImpl });
  validateManifestShape(manifest, { dev });
  checkKeyConflict(db, manifest, url);
  return manifest;
}

function hashConsentToken(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function generateConsentToken() {
  return 'homestead_consent_' + crypto.randomBytes(24).toString('base64url');
}

// issueConsent(db, userId, manifestUrl, opts) -> { consent_token, manifest }
// Re-derives the manifest server-side (never trusts client-echoed
// JSON) and snapshots it onto the consent token row, so `installApp`
// installs exactly what was shown on the consent screen even if the
// remote manifest changes in the intervening 60 seconds.
async function issueConsent(db, userId, manifestUrl, { acknowledged = false, dev = false, fetchImpl } = {}) {
  if (!acknowledged) {
    throw new AppInstallError(412, 'consent_required', 'acknowledged must be true');
  }
  const manifest = await resolveManifest(db, manifestUrl, { dev, fetchImpl });
  const plaintext = generateConsentToken();
  const hash = hashConsentToken(plaintext);
  db.prepare(`INSERT INTO app_consent_tokens (user_id, manifest_url, manifest_json, token_hash, expires_at)
              VALUES (?, ?, ?, ?, datetime('now', '+${CONSENT_TTL_SECONDS} seconds'))`)
    .run(userId, manifestUrl, JSON.stringify(manifest), hash);
  return { consent_token: plaintext, manifest };
}

// installApp(db, userId, consentTokenPlaintext) -> { app, token_plaintext }
// One transaction: consumes the consent token (single-use, bound to
// this user), inserts/reactivates the shared installed_apps row,
// mints an app-scoped PAT, and enables the `apps` launcher module for
// this user. Any failure rolls back everything, including the
// consent-token consumption, so a transient error never burns the
// user's one-shot token for nothing.
function installApp(db, userId, consentTokenPlaintext) {
  if (!consentTokenPlaintext || typeof consentTokenPlaintext !== 'string') {
    throw new AppInstallError(410, 'consent_expired', 'consent_token is required');
  }
  const hash = hashConsentToken(consentTokenPlaintext);

  const tx = db.transaction(() => {
    // Not found / wrong user / already used / expired all collapse to
    // the same response so a guesser learns nothing from the error.
    const row = db.prepare(
      `SELECT * FROM app_consent_tokens
        WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > datetime('now')`
    ).get(hash, userId);
    if (!row) {
      throw new AppInstallError(410, 'consent_expired', 'consent token is invalid, already used, or expired');
    }
    db.prepare(`UPDATE app_consent_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);

    const manifest = JSON.parse(row.manifest_json);
    // Defensive re-check: the registry could have drifted in the 60s
    // between consent and install.
    checkKeyConflict(db, manifest, row.manifest_url);

    const already = db.prepare(
      `SELECT id FROM agent_tokens WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL`
    ).get(userId, manifest.key);
    if (already) {
      throw new AppInstallError(409, 'already_installed', `app "${manifest.key}" is already installed for this user`);
    }

    const existingApp = db.prepare('SELECT * FROM installed_apps WHERE key = ?').get(manifest.key);
    if (!existingApp) {
      db.prepare(`INSERT INTO installed_apps (key, name, manifest_url, manifest_json, installed_by_user_id)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(manifest.key, manifest.name, row.manifest_url, JSON.stringify(manifest), userId);
    } else if (existingApp.revoked_at) {
      db.prepare(`UPDATE installed_apps SET revoked_at = NULL WHERE key = ?`).run(manifest.key);
    }

    const issued = agentTokens.issue(db, userId, {
      label: `App: ${manifest.name}`,
      scopes: JSON.stringify(manifest.scopes),
      appId: manifest.key,
    });
    userModel.setUserModule(db, userId, 'apps', true);

    return {
      app: { key: manifest.key, name: manifest.name, icon: manifest.icon },
      token_plaintext: issued.token_plaintext,
    };
  });
  return tx();
}

// reinstallApp(db, userId, key) -> { app, token_plaintext }
// Mints a fresh token with the SAME scopes as the original install,
// for a user who has installed this app before (consent already
// given) — most commonly to recover from a suspected leaked token, or
// to undo their own prior revoke. Does not re-run consent; a user with
// no install history for this key must go through resolve -> consent
// -> install instead.
function reinstallApp(db, userId, key) {
  const tx = db.transaction(() => {
    const existingApp = db.prepare('SELECT * FROM installed_apps WHERE key = ?').get(key);
    const priorToken = db.prepare(
      `SELECT id FROM agent_tokens WHERE user_id = ? AND app_id = ? ORDER BY id DESC LIMIT 1`
    ).get(userId, key);
    if (!existingApp || !priorToken) {
      throw new AppInstallError(404, 'not_installed', `app "${key}" was never installed for this user`);
    }

    db.prepare(`UPDATE agent_tokens SET revoked_at = datetime('now')
                WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL`).run(userId, key);

    if (existingApp.revoked_at) {
      db.prepare(`UPDATE installed_apps SET revoked_at = NULL WHERE key = ?`).run(key);
    }

    const manifest = JSON.parse(existingApp.manifest_json);
    const issued = agentTokens.issue(db, userId, {
      label: `App: ${manifest.name}`,
      scopes: JSON.stringify(manifest.scopes),
      appId: key,
    });
    userModel.setUserModule(db, userId, 'apps', true);

    return {
      app: { key: manifest.key, name: manifest.name, icon: manifest.icon },
      token_plaintext: issued.token_plaintext,
    };
  });
  return tx();
}

// revokeApp(db, userId, key) -> { ok: true }
// Soft-revokes this user's app-scoped token(s) (immediate 401 on
// their next call, per the partial-unique-index exclusion `verify()`
// already relies on) and "removes the tile": disables the `apps`
// module for this user if it was their last third-party app, and
// archives the shared installed_apps row if no other household member
// still holds an active token for it.
function revokeApp(db, userId, key) {
  const appRow = db.prepare('SELECT * FROM installed_apps WHERE key = ?').get(key);
  if (!appRow) throw new AppInstallError(404, 'not_found', `app "${key}" not found`);

  const active = db.prepare(
    `SELECT id FROM agent_tokens WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL`
  ).get(userId, key);
  if (!active) throw new AppInstallError(404, 'not_installed', `app "${key}" is not installed for this user`);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE agent_tokens SET revoked_at = datetime('now')
                WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL`).run(userId, key);

    const stillHasApps = db.prepare(
      `SELECT id FROM agent_tokens WHERE user_id = ? AND app_id IS NOT NULL AND revoked_at IS NULL LIMIT 1`
    ).get(userId);
    if (!stillHasApps) {
      userModel.setUserModule(db, userId, 'apps', false);
    }

    const anyoneElseActive = db.prepare(
      `SELECT id FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL LIMIT 1`
    ).get(key);
    if (!anyoneElseActive) {
      db.prepare(`UPDATE installed_apps SET revoked_at = datetime('now') WHERE key = ?`).run(key);
    }
    return { ok: true };
  });
  return tx();
}

// listApps(db, userId) -> metadata-only array, this user's installed
// apps — built-in (enabled `user_modules` rows) AND third-party
// (active-token installs), never another household member's. Both
// halves read off the SAME registry shape (PHA-2201 §1/§6 dogfood
// principle, PHA-2232 acceptance: "same registry read path") — a
// built-in is just an app whose install mechanism is a `user_modules`
// toggle instead of a consent-token exchange.
function listApps(db, userId) {
  const userModules = userModel.getUserModules(db, userId);
  const builtinRows = modules.listModules()
    .filter((m) => userModules[m.key] && userModules[m.key].enabled)
    .map((m) => ({
      key: m.key,
      name: m.name,
      icon: m.icon,
      author: m.author,
      version: m.version,
      installed_at: userModules[m.key].enabled_at,
      builtin: true,
    }));

  const thirdPartyRows = db.prepare(`
    SELECT ia.key, ia.name, ia.manifest_json, ia.installed_at
      FROM agent_tokens at
      JOIN installed_apps ia ON ia.key = at.app_id
     WHERE at.user_id = ? AND at.app_id IS NOT NULL AND at.revoked_at IS NULL
     ORDER BY ia.installed_at DESC
  `).all(userId).map((r) => {
    const manifest = JSON.parse(r.manifest_json);
    return {
      key: r.key,
      name: r.name,
      icon: manifest.icon,
      author: manifest.author,
      version: manifest.version,
      installed_at: r.installed_at,
      builtin: false,
    };
  });

  return builtinRows.concat(thirdPartyRows);
}

// getApp(db, userId, key) -> one app + granted scopes + activity
// summary, for this user only. Built-in modules have no app-scoped
// token or app_api_log rows (PHA-2231: built-in calls are never
// logged) — their activity_summary is always zero/never, and there's
// no revoke action for them (revokeApp 404s on a built-in key, since
// it's never in `installed_apps`; the UI hides the button instead of
// relying on that 404).
function getApp(db, userId, key) {
  if (modules.isModuleKey(key)) {
    const enabled = userModel.getUserModules(db, userId)[key];
    if (!enabled || !enabled.enabled) throw new AppInstallError(404, 'not_found', `app "${key}" not found for this user`);
    const m = modules.getModule(key);
    return {
      key: m.key,
      name: m.name,
      icon: m.icon,
      description: m.description,
      author: m.author,
      version: m.version,
      manifest_url: null,
      installed_at: enabled.enabled_at,
      scopes: m.scopes,
      entity_kinds: m.entity_kinds,
      builtin: true,
      activity_summary: { call_count: 0, last_used_at: null },
    };
  }

  const row = db.prepare(`
    SELECT ia.*, at.scopes
      FROM agent_tokens at
      JOIN installed_apps ia ON ia.key = at.app_id
     WHERE at.user_id = ? AND at.app_id = ? AND at.revoked_at IS NULL
  `).get(userId, key);
  if (!row) throw new AppInstallError(404, 'not_found', `app "${key}" not found for this user`);
  const manifest = JSON.parse(row.manifest_json);
  return {
    key: row.key,
    name: row.name,
    icon: manifest.icon,
    description: manifest.description,
    author: manifest.author,
    version: manifest.version,
    manifest_url: row.manifest_url,
    installed_at: row.installed_at,
    scopes: JSON.parse(row.scopes),
    entity_kinds: manifest.entity_kinds || [],
    builtin: false,
    activity_summary: appApiLog.summary(db, userId, key),
  };
}

module.exports = {
  AppInstallError,
  migrate,
  resolveManifest,
  issueConsent,
  installApp,
  reinstallApp,
  revokeApp,
  listApps,
  getApp,
  // Exposed for tests only.
  _manifestCache: manifestCache,
  _CONSENT_TTL_SECONDS: CONSENT_TTL_SECONDS,
};
