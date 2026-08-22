// Homestead agent PAT (personal access token) model (PHA-1617.1/.2).
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (runs `migrate(db)` at boot, mounts /api/agent-tokens
//     routes, and calls `authenticateToken` from the auth middleware)
//   * scripts/test-agent-tokens.js (acceptance tests)
//
// Contract:
//   * `agent_tokens` holds one row per issued token. The plaintext token
//     is NEVER stored — only a bcrypt hash (`token_hash`) plus a
//     non-secret 16-char lookup prefix (`token_prefix`) used to find the
//     candidate row before doing the (expensive) bcrypt compare.
//   * Token format: `homestead_pat_` + 43-char base64url (no padding)
//     encoding of 32 random bytes. 56 chars total.
//   * Revocation is soft-delete (`revoked_at` set); revoked tokens are
//     excluded from prefix lookups via the partial unique index, so a
//     revoked prefix can be reissued without collision headaches.

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const TOKEN_PREFIX_LABEL = 'homestead_pat_';
const LOOKUP_PREFIX_LEN = 16;

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  created_by_run_id TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by_run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tokens_prefix ON agent_tokens(token_prefix) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS installed_apps (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manifest_url TEXT,
  manifest_json TEXT,
  installed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  installed_at TEXT DEFAULT (datetime('now')),
  revoked_at TEXT
);
`);

  // PHA-2228 (PHA-2201.6): app-scoped PATs, additive on top of the
  // PHA-1617 user-level PAT model above. `app_id IS NULL` = existing
  // user-level PAT (untouched); `app_id = '<key>'` = one app-scoped PAT
  // per (user, app), minted by the future install/consent endpoints
  // (PHA-2201 design note §5).
  const cols = db.prepare('PRAGMA table_info(agent_tokens)').all().map((c) => c.name);
  if (!cols.includes('app_id')) {
    db.exec('ALTER TABLE agent_tokens ADD COLUMN app_id TEXT REFERENCES installed_apps(key) ON DELETE CASCADE');
  }
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_agent_tokens_app ON agent_tokens(user_id, app_id)
  WHERE revoked_at IS NULL AND app_id IS NOT NULL;
`);
}

// Generates a fresh plaintext token + its lookup prefix. Does NOT touch
// the DB — callers persist the bcrypt hash via `issue()`.
function generateToken() {
  const raw = crypto.randomBytes(32).toString('base64url'); // 43 chars, no padding
  const plaintext = TOKEN_PREFIX_LABEL + raw;
  const prefix = plaintext.slice(0, LOOKUP_PREFIX_LEN);
  return { plaintext, prefix };
}

// Issues a new token for `userId`. Returns the public-safe row PLUS the
// one-time plaintext. `createdByRunId` is optional (set when an agent
// run itself provisions a token, e.g. self-service escalation).
function issue(db, userId, { label, expiresAt = null, scopes = 'user', createdByRunId = null, appId = null } = {}) {
  const clean = (label || '').trim();
  if (!clean) throw new Error('label required');

  // Retry on the astronomically unlikely prefix collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { plaintext, prefix } = generateToken();
    const existing = db.prepare('SELECT id FROM agent_tokens WHERE token_prefix = ? AND revoked_at IS NULL').get(prefix);
    if (existing) continue;
    const hash = bcrypt.hashSync(plaintext, 10);
    const r = db.prepare(`INSERT INTO agent_tokens
        (user_id, label, token_hash, token_prefix, scopes, expires_at, created_by_run_id, app_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, clean, hash, prefix, scopes, expiresAt || null, createdByRunId, appId);
    const row = db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(r.lastInsertRowid);
    return { ...toPublic(row), token_plaintext: plaintext };
  }
  throw new Error('failed to allocate a unique token prefix after 5 attempts');
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    token_prefix: row.token_prefix,
    scopes: row.scopes,
    created_at: row.created_at,
    created_by_run_id: row.created_by_run_id,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_by_run_id: row.revoked_by_run_id,
    app_id: row.app_id,
  };
}

// Lists non-secret token metadata for a user (or all users, if userId is
// null — admin cross-user view).
function list(db, userId) {
  const rows = userId == null
    ? db.prepare('SELECT * FROM agent_tokens ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM agent_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(toPublic);
}

// Revokes a token by id. `ownerUserId`, if given, restricts revocation
// to tokens owned by that user (self-service path); pass null for the
// admin path. Returns true if a row was revoked.
function revoke(db, tokenId, { ownerUserId = null, revokedByRunId = null } = {}) {
  const row = db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(tokenId);
  if (!row) return false;
  if (ownerUserId != null && row.user_id !== ownerUserId) return false;
  if (row.revoked_at) return true; // already revoked, idempotent
  db.prepare(`UPDATE agent_tokens SET revoked_at = datetime('now'), revoked_by_run_id = ? WHERE id = ?`)
    .run(revokedByRunId, tokenId);
  return true;
}

// Verifies a Bearer PAT. Returns the matching agent_tokens row (with
// user_id) on success, or null on any failure (unknown prefix, hash
// mismatch, expired, revoked). Updates last_used_at on success.
function verify(db, plaintext) {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX_LABEL)) return null;
  const prefix = plaintext.slice(0, LOOKUP_PREFIX_LEN);
  const row = db.prepare('SELECT * FROM agent_tokens WHERE token_prefix = ? AND revoked_at IS NULL').get(prefix);
  if (!row) return null;
  if (!bcrypt.compareSync(plaintext, row.token_hash)) return null;
  if (row.expires_at && Date.now() >= new Date(row.expires_at).getTime()) return null;
  db.prepare(`UPDATE agent_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  return row;
}

module.exports = {
  TOKEN_PREFIX_LABEL,
  LOOKUP_PREFIX_LEN,
  migrate,
  generateToken,
  issue,
  list,
  revoke,
  verify,
  toPublic,
};
