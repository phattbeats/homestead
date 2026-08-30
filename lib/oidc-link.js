// Homestead — OIDC identity-linking flow (PHA-2706).
//
// "Link Authentik later" is the self-service companion to PHA-2704's
// foundation: a Homestead user who registered standalone (local
// username + password) later wants to add an OIDC provider (Authentik
// in production, any compatible IdP in theory) as a SECOND way to log
// in — without migrating or replacing the existing account.
//
// The security model is intentionally strict because the action is
// permanent: once a Homestead user id has an identity_links row for
// (provider, issuer, subject), the canonical login path is "if any
// identity_links row matches, that's the user" — so getting this row
// wrong can hand an account to an attacker or orphan an honest user.
//
//   1. Start only from an authenticated Homestead session. The link
//      endpoints refuse unauthenticated calls (401) — there is no
//      way to bootstrap a link without an existing account.
//
//   2. Require local re-authentication before linking. The Start
//      endpoint accepts a plaintext local password and verifies it
//      through identity.verifyLocalPassword — this is the "you are
//      really the account owner" check, since the session cookie
//      alone might be replayable by a session-hijacker.
//
//   3. OIDC authorization-code flow with PKCE (RFC 7636), state
//      (RFC 6749 §10.12), and nonce (OIDC Core §3.1.2.1). Code
//      challenge = S256. State and nonce are stored server-side
//      keyed by a one-time opaque handle; the handle is bound to
//      the requesting user, the local re-auth timestamp, and the
//      PKCE code_verifier.
//
//   4. Final explicit confirmation naming both identities. The
//      callback does the token exchange and ID-token validation
//      but does NOT write to identity_links yet — it returns a
//      pending payload that names (a) the Homestead username +
//      display and (b) the OIDC subject + email/display, and the
//      user clicks "Link" to call /confirm. Cancel at any point
//      burns the handle.
//
//   5. Insert one identity_links row pointing at the existing
//      users.id. /confirm calls identity.linkIdentity in a single
//      transaction. The UNIQUE(provider, issuer, provider_subject)
//      constraint is the collision check — linkIdentity throws
//      identity_collision when the subject is already owned by
//      a different user, and the endpoint maps that to a 409
//      with a clear "contact admin for recovery" hint.
//
//   6. Never auto-link by email alone. The subject claim in the
//      ID token is the only thing that becomes the
//      provider_subject; email is surfaced for display only.
//
//   7. Provider-subject collision routes to admin review. When a
//      collision happens, the endpoint refuses to link AND
//      surfaces the conflicting user id so the UI can show
//      "this Authentik account is already linked to a different
//      Homestead user — contact an admin."
//
//   8. Unlink rules cannot remove the last viable login path.
//      The existing identity.unlinkIdentity() guard (in
//      lib/identity.js) refuses the last link for a user with no
//      local credential; we re-use it for the self-service
//      /unlink endpoint so the rule is uniform across admin and
//      self-service paths.
//
// Configuration (process.env):
//   OIDC_ISSUER             — required. Base URL of the IdP, used to
//                              validate the token endpoint and the
//                              ID token's `iss` claim. In production
//                              this is https://authentik.phatt.vip/
//                              application/oauth/homestead/.
//   OIDC_CLIENT_ID          — required. Public identifier.
//   OIDC_CLIENT_SECRET      — required. Confidential secret.
//   OIDC_REDIRECT_URI       — required. Must be HTTPS in production.
//                              In dev, the host can be the local IP.
//   OIDC_SCOPES             — optional, default "openid profile email".
//   OIDC_LINK_TTL_MS        — optional, default 600000 (10 minutes).
//                              Max 15 minutes. A pending link that
//                              isn't confirmed within the TTL is
//                              pruned on read and on cleanup.
//
// Production Authentik integration:
//   The Homestead front-end renders a "Link Authentik" button on the
//   account / identities page (public/identities-link.html). Clicking
//   it posts to /api/me/identities/link/start with the local password;
//   the server redirects to the Authentik /authorize endpoint with
//   PKCE + state + nonce. Authentik handles the user-side flow and
//   redirects back to /api/me/identities/link/callback?code=...&state=...
//   The server completes the token exchange, validates the ID token,
//   and renders a confirmation page naming both identities. Clicking
//   "Confirm link" posts to /api/me/identities/link/confirm and writes
//   the identity_links row. From that point forward, the user can
//   sign in either with username+password OR via Authentik (subject
//   look-up in identity_links takes priority over username match).
//
// Test-mode mock:
//   For automated tests, lib/oidc-link-test-helper.js spins up an
//   in-process OIDC mock (RFC-compliant /authorize, /token, jwks,
//   discovery) that this module can be pointed at via OIDC_ISSUER
//   without any external network dependency.

'use strict';

const crypto = require('crypto');

const DEFAULT_SCOPES = 'openid profile email';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;

// base64url — RFC 7515 §2 — URL-safe base64 without padding.
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// PKCE pair — code_verifier is a high-entropy random URL-safe string;
// code_challenge = BASE64URL(SHA256(code_verifier)).
function generatePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

// generateState / generateNonce — opaque high-entropy tokens. We keep
// the canonical base64url form (URL-safe, no padding) so they survive
// every redirect hop without escaping.
function generateOpaque(len = 32) { return b64url(crypto.randomBytes(len)); }

// `loadConfig` — single point of truth for the OIDC parameters. Reads
// from process.env at call time so test setups that mutate env vars
// see the change without needing to reset module-level state.
function loadConfig() {
  const issuer = process.env.OIDC_ISSUER || '';
  const clientId = process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET || '';
  const redirectUri = process.env.OIDC_REDIRECT_URI || '';
  const scopes = process.env.OIDC_SCOPES || DEFAULT_SCOPES;
  const ttlMs = Math.min(parseInt(process.env.OIDC_LINK_TTL_MS, 10) || DEFAULT_TTL_MS, MAX_TTL_MS);
  return { issuer, clientId, clientSecret, redirectUri, scopes, ttlMs };
}

// `migrate(db)` — creates the oidc_link_states table. Idempotent.
// Re-uses the existing migrate(db) shape used by lib/user-model.js and
// lib/identity.js so the server boot path stays uniform.
function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS oidc_link_states (
  handle TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  local_reauth_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  validated_at TEXT,
  validated_subject TEXT,
  validated_email TEXT,
  validated_email_verified INTEGER,
  validated_display TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_oidc_link_states_user ON oidc_link_states(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oidc_link_states_expiry ON oidc_link_states(expires_at);
`);
}

// `createPending(db, userId)` — generates a fresh handle + PKCE pair
// + state + nonce + bound config and persists the row. Returns the
// handle (opaque, returned to the client to track the session), the
// state value (sent to the IdP), the nonce (sent to the IdP), and the
// authorize URL the SPA redirects to.
//
// If the OIDC environment is not configured (e.g. during unit tests
// that don't touch the link flow), the helper throws
// `oidc_not_configured` so the caller can short-circuit cleanly.
function createPending(db, userId) {
  const cfg = loadConfig();
  if (!cfg.issuer || !cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
    const e = new Error('OIDC issuer/client_id/client_secret/redirect_uri not configured');
    e.code = 'oidc_not_configured';
    throw e;
  }
  const handle = generateOpaque(24);
  const pkce = generatePkce();
  const state = generateOpaque(24);
  const nonce = generateOpaque(24);
  const now = Date.now();
  const expiresAt = new Date(now + cfg.ttlMs).toISOString();

  db.prepare(`
    INSERT INTO oidc_link_states
      (handle, user_id, provider, issuer, client_id, redirect_uri,
       scopes, state, nonce, code_verifier, code_challenge,
       code_challenge_method, local_reauth_at, created_at, expires_at, status)
    VALUES
      (?, ?, 'authentik', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
       datetime('now'), ?, 'pending')
  `).run(
    handle, userId, cfg.issuer, cfg.clientId, cfg.redirectUri, cfg.scopes,
    state, nonce, pkce.verifier, pkce.challenge, pkce.method,
    expiresAt
  );

  const authorizeUrl = buildAuthorizeUrl({
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    scopes: cfg.scopes,
    state,
    nonce,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: pkce.method,
  });

  return {
    handle,
    state,
    nonce,
    expiresAt,
    authorizeUrl,
    provider: 'authentik',
    issuer: cfg.issuer,
  };
}

// `buildAuthorizeUrl` — composes the OIDC /authorize URL with the
// five required parameters plus response_type=code. OpenID Connect
// Discovery 1.0 lets us optionally accept `authorization_endpoint` from
// the discovery doc, but the config here is direct (we're the OAuth
// client, not a generic OIDC client); the issuer base URL is
// sufficient for Authentik.
function buildAuthorizeUrl({ issuer, clientId, redirectUri, scopes, state, nonce, codeChallenge, codeChallengeMethod }) {
  const base = issuer.replace(/\/+$/, '');
  const url = new URL(base.replace(/\/application\/oauth\/[^/]+\/?$/, '') + '/application/o/authorize/');
  // The above strips the trailing /application/oauth/<slug>/ and
  // re-appends /application/o/authorize/. Authentik's authorize URL
  // is <iss>/application/o/authorize/. If a future IdP uses a
  // different path, the caller can override via OIDC_AUTHORIZE_URL.
  const override = process.env.OIDC_AUTHORIZE_URL;
  const finalUrl = override || url.toString();
  const u = new URL(finalUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', codeChallengeMethod);
  return u.toString();
}

// `findPending(db, handle)` — looks up a pending row by handle and
// returns it (or null). Used by the callback to fetch the original
// PKCE code_verifier + nonce + bound config. Refuses consumed or
// expired rows. Status transitions are atomic.
function findPending(db, handle) {
  const row = db.prepare(`
    SELECT handle, user_id, provider, issuer, client_id, redirect_uri,
           scopes, state, nonce, code_verifier, code_challenge,
           code_challenge_method, local_reauth_at, expires_at, status
      FROM oidc_link_states WHERE handle = ?
  `).get(handle);
  if (!row) return null;
  if (row.status !== 'pending') return { ...row, _stale: true };
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare("UPDATE oidc_link_states SET status = 'expired' WHERE handle = ? AND status = 'pending'").run(handle);
    return { ...row, _stale: true, _expired: true };
  }
  return row;
}

// `recordValidated(db, handle, claims)` — stamps the validated OIDC
// claims onto the pending row after a successful token exchange + ID
// token validation. The /preview and /confirm endpoints read these
// values so the SPA never sees the raw id_token. Returns the number
// of affected rows (1 = success, 0 = row already consumed/expired).
function recordValidated(db, handle, claims) {
  const r = db.prepare(`
    UPDATE oidc_link_states
       SET validated_at = datetime('now'),
           validated_subject = ?,
           validated_email = ?,
           validated_email_verified = ?,
           validated_display = ?
     WHERE handle = ? AND status = 'pending'
       AND datetime(expires_at) > datetime('now')
  `).run(
    claims.sub || null,
    typeof claims.email === 'string' ? claims.email : null,
    claims.email_verified ? 1 : 0,
    (typeof claims.preferred_username === 'string' ? claims.preferred_username
      : (typeof claims.name === 'string' ? claims.name : null)),
    handle
  );
  return r.changes;
}

// `findValidated(db, handle)` — returns the validated row (subject +
// email + display) so the SPA confirmation UI can name both
// identities. Refuses if status isn't 'pending' or expiry has passed.
function findValidated(db, handle) {
  const row = db.prepare(`
    SELECT handle, user_id, provider, issuer, validated_subject,
           validated_email, validated_email_verified, validated_display,
           expires_at, status
      FROM oidc_link_states WHERE handle = ?
  `).get(handle);
  if (!row) return null;
  if (row.status !== 'pending') return { ...row, _stale: true };
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare("UPDATE oidc_link_states SET status = 'expired' WHERE handle = ? AND status = 'pending'").run(handle);
    return { ...row, _stale: true, _expired: true };
  }
  if (!row.validated_subject) return { ...row, _stale: true, _not_validated: true };
  return row;
}

// `consumePending(db, handle)` — marks the row consumed exactly once.

// `consumePending(db, handle)` — marks the row consumed exactly once.
// Returns the number of affected rows (1 = successful, 0 = already
// consumed / expired / unknown). The endpoint then knows whether
// this is a replay (0) and can refuse.
function consumePending(db, handle) {
  const r = db.prepare(`
    UPDATE oidc_link_states
       SET status = 'consumed', consumed_at = datetime('now')
     WHERE handle = ? AND status = 'pending'
       AND datetime(expires_at) > datetime('now')
  `).run(handle);
  return r.changes;
}

// `cancelPending(db, handle, userId)` — user cancels. Refuses to
// cancel a row that doesn't belong to `userId` so the endpoint
// can't be used to interfere with another user's pending link.
function cancelPending(db, handle, userId) {
  const r = db.prepare(`
    UPDATE oidc_link_states
       SET status = 'cancelled'
     WHERE handle = ? AND user_id = ? AND status = 'pending'
  `).run(handle, userId);
  return r.changes;
}

// `purgeExpired(db)` — house-keeping. Removes rows whose status is
// terminal (consumed / cancelled / expired) and whose created_at is
// older than 24 hours. Called on a slow path so the table doesn't
// grow unbounded under heavy use.
function purgeExpired(db) {
  return db.prepare(`
    DELETE FROM oidc_link_states
     WHERE status IN ('consumed', 'cancelled', 'expired')
       AND datetime(created_at) < datetime('now', '-24 hours')
  `).run().changes;
}

// `verifyIdToken` — minimal OIDC ID-token validation that runs
// without an external JWKS fetch (the caller — the test helper in
// dev and the live IdP integration in prod — supplies the public key
// and the issuer we expect to see).
//
//   * Signature MUST verify with the supplied public key against
//     the algorithm in the JWT header. RS256 only — HS256 / none
//     would be a downgrade attack and we refuse.
//   * `iss` MUST equal the configured issuer (case-sensitive —
//     OIDC issuers carry meaningful case in their URL form).
//   * `aud` MUST contain the configured client_id (string or
//     array — RFC 7519 §4.1.3 allows either).
//   * `nonce` MUST equal the one we stored at /start (replay
//     protection — the ID token MUST prove the user actually
//     completed the Authentik UI, not a captured static response).
//   * `exp` MUST be in the future. `iat` SHOULD be in the past
//     (within a 5-minute skew window to allow for clock drift).
//   * `sub` MUST be present and non-empty. We carry it forward
//     verbatim as the identity_links.provider_subject.
//
// Returns the parsed claims on success. Throws a typed error on
// failure so the endpoint can map it to the right HTTP code:
//
//   { code: 'id_token_invalid_signature' }
//   { code: 'id_token_issuer_mismatch' }
//   { code: 'id_token_audience_mismatch' }
//   { code: 'id_token_nonce_mismatch' }
//   { code: 'id_token_expired' }
//   { code: 'id_token_unparseable' }
function verifyIdToken(idToken, { expectedIssuer, expectedAudience, expectedNonce, publicKeyPem }) {
  if (!idToken || typeof idToken !== 'string') {
    const e = new Error('id_token missing'); e.code = 'id_token_unparseable'; throw e;
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    const e = new Error('id_token must have three segments'); e.code = 'id_token_unparseable'; throw e;
  }
  let header, claims;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    const e = new Error('id_token JSON parse failed'); e.code = 'id_token_unparseable'; throw e;
  }
  if (header.alg !== 'RS256') {
    const e = new Error(`id_token alg ${header.alg} rejected (only RS256)`); e.code = 'id_token_invalid_signature'; throw e;
  }
  // Verify signature — node's crypto module takes the raw signing input
  // (header.payload) and the detached signature over base64url-decoded
  // signature bytes.
  const signingInput = Buffer.from(parts[0] + '.' + parts[1]);
  const sig = b64urlDecode(parts[2]);
  const ok = crypto.createVerify('RSA-SHA256').update(signingInput).verify(publicKeyPem, sig);
  if (!ok) {
    const e = new Error('id_token signature invalid'); e.code = 'id_token_invalid_signature'; throw e;
  }
  if (claims.iss !== expectedIssuer) {
    const e = new Error(`id_token iss mismatch (got ${claims.iss}, expected ${expectedIssuer})`);
    e.code = 'id_token_issuer_mismatch'; throw e;
  }
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(expectedAudience) : aud === expectedAudience;
  if (!audOk) {
    const e = new Error('id_token aud mismatch'); e.code = 'id_token_audience_mismatch'; throw e;
  }
  if (claims.nonce !== expectedNonce) {
    const e = new Error('id_token nonce mismatch (replay or substitution)'); e.code = 'id_token_nonce_mismatch'; throw e;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < nowSec) {
    const e = new Error('id_token expired'); e.code = 'id_token_expired'; throw e;
  }
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) {
    const e = new Error('id_token iat in the future'); e.code = 'id_token_unparseable'; throw e;
  }
  if (!claims.sub || typeof claims.sub !== 'string') {
    const e = new Error('id_token missing sub'); e.code = 'id_token_unparseable'; throw e;
  }
  return claims;
}

// `exchangeCodeForTokens` — POSTs to the IdP's token endpoint with
// grant_type=authorization_code + code_verifier. Returns the parsed
// JSON response ({ id_token, access_token, ... }). Caller is
// responsible for ID-token validation via verifyIdToken.
//
// IdP token endpoints are normally HTTPS; tests bypass TLS by
// pointing OIDC_TOKEN_URL at an http:// in-process server.
async function exchangeCodeForTokens({ tokenUrl, clientId, clientSecret, redirectUri, code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const e = new Error(`token endpoint returned ${r.status}: ${text.slice(0, 200)}`);
    e.code = 'token_exchange_failed';
    throw e;
  }
  return r.json();
}

// `formatLinkPayload` — assembles the JSON the /confirm endpoint
// returns. Names both identities explicitly (Homestead username +
// display AND OIDC subject + email + display) so the UI can show
// the user "you are about to link <homestead_user> to <oidc_account>"
// before they click "Link".
function formatLinkPayload(user, claims, issuer) {
  return {
    homestead: {
      user_id: user.id,
      username: user.username,
      display: user.display,
    },
    oidc: {
      provider: 'authentik',
      issuer,
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      email_verified: !!claims.email_verified,
      display: typeof claims.preferred_username === 'string' ? claims.preferred_username
        : (typeof claims.name === 'string' ? claims.name : null),
      // The raw claims are NOT echoed back — callers don't need them
      // and exposing the full token contents would leak identity
      // info beyond what's needed for the confirmation UI.
    },
  };
}

module.exports = {
  // Configuration
  loadConfig,
  // Migration
  migrate,
  // State lifecycle
  createPending,
  findPending,
  recordValidated,
  findValidated,
  consumePending,
  cancelPending,
  purgeExpired,
  // URL builder
  buildAuthorizeUrl,
  // Token validation + exchange
  verifyIdToken,
  exchangeCodeForTokens,
  formatLinkPayload,
  // Constants exposed for tests
  DEFAULT_SCOPES,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  // Helpers exposed for tests
  b64url,
  b64urlDecode,
  generatePkce,
  generateOpaque,
};