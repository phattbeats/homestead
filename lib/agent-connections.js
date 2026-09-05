// Homestead first-class agent connection & pairing flow — backend
// (PHA-2880, phase 1 of PHA-2855's design note).
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (runs `migrate(db)` at boot, mounts the
//     /api/agent-connections routes)
//   * scripts/test-agent-connections.js (acceptance tests)
//
// Contract (PHA-2855 design note):
//   * `agent_connections` is the companion-mediated counterpart to
//     `lib/agent-endpoints.js`'s generic-webhook rows. It backs the
//     "Connect an agent" wizard's OpenClaw / Claude Code / Codex tiles —
//     the Advanced/generic-webhook `agent_endpoints` path is untouched
//     by this file.
//   * Pairing is two steps: (1) the browser session mints a short-lived
//     `pairing_code` bound to the initiating user_id (`mintPairingCode`),
//     (2) the local companion — running on the user's own machine,
//     never inside Homestead — redeems it while session-authenticated
//     (`redeemPairingCode`). Redemption is single-use, 10-minute TTL,
//     and can only be completed by the SAME user_id that minted the
//     code — a different logged-in user cannot claim someone else's
//     pairing code.
//   * On successful redemption Homestead mints a connection secret and
//     returns the plaintext exactly once, mirroring `agent_endpoints`'
//     "copy-once" secret reveal. Per the design note's security-boundary
//     section this is meant to move to a hashed-at-rest secret in a
//     follow-up (`secret-box` style envelope encryption); for v0 it is
//     stored the same way `agent_endpoints.secret` is today — plaintext
//     is the trust boundary, because `signPayload()` verification is
//     symmetric-HMAC and requires the server to recompute the digest
//     from the same key the companion holds. This mirrors the existing,
//     already-accepted trade-off in agent-endpoints.js — not a new gap.
//   * Scopes are validated against the PHA-2201 §3 vocabulary
//     (`lib/scope-display.js`) — same discipline as third-party app
//     manifests, so a connection can never be granted an unmapped or
//     rejected scope.
//   * Signing reuses `agent-endpoints.js`'s `signPayload()` HMAC-SHA256
//     scheme verbatim (same header trio: X-Homestead-Signature /
//     -Timestamp / -Request-Id) — no parallel crypto implementation.

'use strict';

const crypto = require('crypto');
const agentEndpoints = require('./agent-endpoints');
const scopeDisplay = require('./scope-display');

const PROVIDER_OPENCLAW = 'openclaw';
const PROVIDER_CLAUDE_CODE = 'claude_code';
const PROVIDER_CODEX = 'codex';
const VALID_PROVIDERS = new Set([PROVIDER_OPENCLAW, PROVIDER_CLAUDE_CODE, PROVIDER_CODEX]);

const STATUS_PENDING = 'pending';
const STATUS_ACTIVE = 'active';
const STATUS_REVOKED = 'revoked';
const VALID_STATUSES = new Set([STATUS_PENDING, STATUS_ACTIVE, STATUS_REVOKED]);

const SECRET_PREFIX_LABEL = 'homestead_conn_';
const SECRET_RANDOM_BYTES = 32; // → 43 chars base64url, no padding

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const PAIRING_CODE_LEN = 6;
const PAIRING_TTL_MINUTES = 10;

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_connections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('openclaw','claude_code','codex')),
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked')),
  secret TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  pairing_code TEXT,
  pairing_code_expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  redeemed_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  last_status_code INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_connections_user ON agent_connections(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_connections_pairing_code
  ON agent_connections(pairing_code) WHERE pairing_code IS NOT NULL;
`);
}

function validateProvider(provider) {
  if (typeof provider !== 'string') return null;
  const p = provider.trim().toLowerCase();
  return VALID_PROVIDERS.has(p) ? p : null;
}

function validateLabel(label) {
  const l = (label || '').trim();
  if (l.length > 128) throw new Error('label too long (max 128 chars)');
  return l;
}

// Scopes must be a JSON array of strings drawn from the PHA-2201 §3
// vocabulary (lib/scope-display.js). Returns the canonical JSON string
// on success; throws with the same "unmapped scope" messaging a bad
// app manifest would get.
function validateScopes(scopes) {
  const list = scopes == null ? [] : scopes;
  if (!Array.isArray(list) || !list.every(s => typeof s === 'string')) {
    throw new Error('scopes must be an array of scope strings');
  }
  scopeDisplay.describeScopes(list); // throws with unmapped/rejected details
  return JSON.stringify(list);
}

function parseScopes(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function generateSecret() {
  const raw = crypto.randomBytes(SECRET_RANDOM_BYTES).toString('base64url');
  return SECRET_PREFIX_LABEL + raw;
}

function generatePairingCode() {
  const bytes = crypto.randomBytes(PAIRING_CODE_LEN);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LEN; i++) {
    code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

function toPublic(row, { includeSecretPlaintext = false, ownerUserId = null } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    redeemed_at: row.redeemed_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    pairing_pending: row.status === STATUS_PENDING,
    secret_prefix: row.secret ? row.secret.slice(0, 16) + '…' : null,
  };
  // Never surface the pairing code itself past mint time in list/get —
  // callers that need it use mintPairingCode's direct return value.
  if (includeSecretPlaintext && ownerUserId != null && row.user_id === ownerUserId) {
    out.secret_plaintext = row.secret;
  }
  return out;
}

// Mints a pending connection + pairing code for `userId`. The code is
// single-use, expires in PAIRING_TTL_MINUTES, and is bound to `userId` —
// only a redeem call authenticated as that same user can claim it.
function mintPairingCode(db, userId, { provider, label = '', scopes = [] } = {}) {
  const canonicalProvider = validateProvider(provider);
  if (!canonicalProvider) throw new Error('provider must be one of: ' + [...VALID_PROVIDERS].join(', '));
  const cleanLabel = validateLabel(label);
  const scopesJson = validateScopes(scopes);

  const code = generatePairingCode();
  const r = db.prepare(`INSERT INTO agent_connections
      (user_id, provider, label, status, scopes, pairing_code, pairing_code_expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?, datetime('now', '+${PAIRING_TTL_MINUTES} minutes'))`)
    .run(userId, canonicalProvider, cleanLabel, scopesJson, code);
  const row = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(r.lastInsertRowid);
  const pub = toPublic(row, { ownerUserId: userId });
  pub.pairing_code = code;
  pub.pairing_code_expires_at = row.pairing_code_expires_at;
  return pub;
}

// Redeems a pairing code. `userId` is the redeeming session's user —
// must match the user_id the code was minted under. Single-use: the
// code is cleared on redemption whether it succeeds or has already
// expired/been consumed. Returns { connection, secret_plaintext } on
// success, or null if the code is unknown/expired/already
// redeemed/owned by a different user.
function redeemPairingCode(db, code, { userId } = {}) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const clean = code.trim().toUpperCase();
  const row = db.prepare(`SELECT * FROM agent_connections
      WHERE pairing_code = ? AND status = 'pending'`).get(clean);
  if (!row) return null;
  if (row.user_id !== userId) return null;

  const expired = db.prepare(`SELECT 1 AS x FROM agent_connections
      WHERE id = ? AND pairing_code_expires_at < datetime('now')`).get(row.id);
  if (expired) {
    // Expired codes are dead on arrival — clear the code so it can never
    // be retried, but leave the row in place for audit.
    db.prepare(`UPDATE agent_connections SET pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?`).run(row.id);
    return null;
  }

  const secret = generateSecret();
  db.prepare(`UPDATE agent_connections
       SET status = 'active',
           secret = ?,
           pairing_code = NULL,
           pairing_code_expires_at = NULL,
           redeemed_at = datetime('now')
     WHERE id = ?`).run(secret, row.id);
  const updated = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(row.id);
  return toPublic(updated, { includeSecretPlaintext: true, ownerUserId: userId });
}

// Lists connections for a user (or all users, if userId is null —
// admin cross-household view). Never returns plaintext secrets.
function list(db, userId) {
  const rows = userId == null
    ? db.prepare('SELECT * FROM agent_connections ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM agent_connections WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(r => toPublic(r));
}

function get(db, connectionId, { ownerUserId = null, includeSecretPlaintext = false } = {}) {
  const row = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  if (!row) return null;
  if (ownerUserId != null && row.user_id !== ownerUserId) return null;
  return toPublic(row, { ownerUserId, includeSecretPlaintext });
}

// Renames (or re-labels) a connection. Only the label may be changed
// through this path — provider/scopes are fixed at pairing time.
function rename(db, connectionId, label, { ownerUserId = null } = {}) {
  const existing = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  if (!existing) return null;
  if (ownerUserId != null && existing.user_id !== ownerUserId) return null;
  const cleanLabel = validateLabel(label);
  db.prepare('UPDATE agent_connections SET label = ? WHERE id = ?').run(cleanLabel, connectionId);
  const updated = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  return toPublic(updated, { ownerUserId });
}

// Rotates the secret on an active connection. Returns the updated row
// with a fresh one-time plaintext secret, or null if missing/forbidden/
// not active (a pending or revoked connection has nothing to rotate).
function rotateSecret(db, connectionId, { ownerUserId = null } = {}) {
  const existing = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  if (!existing) return null;
  if (ownerUserId != null && existing.user_id !== ownerUserId) return null;
  if (existing.status !== STATUS_ACTIVE) return null;

  const secret = generateSecret();
  db.prepare('UPDATE agent_connections SET secret = ? WHERE id = ?').run(secret, connectionId);
  const updated = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  return toPublic(updated, { includeSecretPlaintext: true, ownerUserId });
}

// Revokes a connection (active or still-pending). Clears the secret
// and any live pairing code so neither can be used again. Returns the
// updated public row, or null if missing/forbidden.
function revoke(db, connectionId, { ownerUserId = null } = {}) {
  const existing = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  if (!existing) return null;
  if (ownerUserId != null && existing.user_id !== ownerUserId) return null;
  db.prepare(`UPDATE agent_connections
       SET status = 'revoked',
           secret = NULL,
           pairing_code = NULL,
           pairing_code_expires_at = NULL,
           revoked_at = datetime('now')
     WHERE id = ?`).run(connectionId);
  const updated = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(connectionId);
  return toPublic(updated, { ownerUserId });
}

// Dispatch-side lookup: active connections for a user (optionally
// scoped to a provider), including the raw secret so a future
// dispatcher can HMAC-sign outbound relay traffic. Mirrors
// agent-endpoints.js's listEnabledForDispatch.
function listActiveForDispatch(db, userId, provider = null) {
  if (provider != null) {
    const canonicalProvider = validateProvider(provider);
    if (!canonicalProvider) return [];
    return db.prepare(`SELECT * FROM agent_connections
        WHERE user_id = ? AND provider = ? AND status = 'active'
        ORDER BY id`).all(userId, canonicalProvider);
  }
  return db.prepare(`SELECT * FROM agent_connections
      WHERE user_id = ? AND status = 'active'
      ORDER BY id`).all(userId);
}

function recordDispatch(db, connectionId, { statusCode = null, error = null } = {}) {
  db.prepare(`UPDATE agent_connections
       SET last_used_at = datetime('now'),
           last_status_code = ?,
           last_error = ?
     WHERE id = ?`).run(statusCode, error || null, connectionId);
}

// Verifies an inbound companion request's HMAC signature against a
// connection's stored secret. Reuses agent-endpoints.js's signPayload()
// verbatim (same header scheme) rather than a parallel implementation.
// Rejects clock skew beyond `toleranceSeconds` (design note: reject
// >5 min) as a replay guard.
function verifySignature(secret, timestamp, rawBody, signatureHeader, { toleranceSeconds = 300 } = {}) {
  if (!secret || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > toleranceSeconds) return false;

  const expected = agentEndpoints.signPayload(secret, timestamp, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  PROVIDER_OPENCLAW,
  PROVIDER_CLAUDE_CODE,
  PROVIDER_CODEX,
  VALID_PROVIDERS,
  STATUS_PENDING,
  STATUS_ACTIVE,
  STATUS_REVOKED,
  PAIRING_TTL_MINUTES,
  migrate,
  validateProvider,
  validateScopes,
  generateSecret,
  generatePairingCode,
  mintPairingCode,
  redeemPairingCode,
  list,
  get,
  rename,
  rotateSecret,
  revoke,
  listActiveForDispatch,
  recordDispatch,
  verifySignature,
  toPublic,
};
