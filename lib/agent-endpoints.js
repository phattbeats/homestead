// Homestead BYO-harness agent endpoint config (PHA-1617.4).
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (runs `migrate(db)` at boot, mounts /api/agent-endpoints
//     routes — the drawer POST + events webhook dispatcher in PHA-1617.6/.7
//     will share the dispatch helpers below)
//   * scripts/test-agent-endpoints.js (acceptance tests)
//
// Contract (design doc §6.1):
//   * One row per (user, kind, harness). `kind` is one of 'drawer' |
//     'events'. A user may own multiple harnesses of the same kind (e.g.
//     laptop OpenClaw + phone automation) — each gets its own URL + secret.
//   * `secret` is an HMAC-SHA256 shared secret. Generated server-side on
//     insert (never caller-supplied). Format: `homestead_aes_` + 43-char
//     base64url encoding of 32 random bytes → 57 chars total. The secret
//     is the only piece the user harness needs to recompute and verify
//     the `X-Homestead-Signature: sha256=<hex>` header on outbound POSTs.
//   * Plaintext secret is returned exactly once, at insert time. The DB
//     stores the secret in plaintext (see `secret-box` for migration to
//     envelope encryption if PHA-1620's `encrypted_calendar_credentials`
//     pattern later extends to this column). For v0 the secret is the
//     trust boundary — it's the only way the user harness can verify the
//     HMAC signature on Homestead outbound POSTs. Envelope encryption
//     can be added in a follow-up without breaking the API contract.
//   * `event_filter` is a JSON string (default `'{}'`). For `kind='events'`
//     rows it scopes which event categories Homestead should dispatch to
//     that endpoint (e.g. `{task_created: true, chore_rotated: true}`).
//     For `kind='drawer'` rows it is ignored (drawer POSTs are not
//     category-gated).
//   * `last_used_at`, `last_status_code`, `last_error` are dispatch-side
//     bookkeeping — written by the future PHA-1617.6/.7 dispatchers.
//     Indexed for ops dashboards.

'use strict';

const crypto = require('crypto');

const KIND_DRAWER = 'drawer';
const KIND_EVENTS = 'events';
const VALID_KINDS = new Set([KIND_DRAWER, KIND_EVENTS]);

const SECRET_PREFIX_LABEL = 'homestead_aes_';
const SECRET_RANDOM_BYTES = 32; // → 43 chars base64url, no padding
const SECRET_PLAINTEXT_LEN = SECRET_PREFIX_LABEL.length + 43;

const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_endpoints (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  harness_label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('drawer','events')),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  event_filter TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  last_status_code INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_user ON agent_endpoints(user_id, kind, enabled);
`);
}

// Generates a fresh secret. Does NOT touch the DB — caller's `create()`
// is responsible for the actual INSERT.
function generateSecret() {
  const raw = crypto.randomBytes(SECRET_RANDOM_BYTES).toString('base64url');
  return { plaintext: SECRET_PREFIX_LABEL + raw };
}

// Loose URL validation: scheme must be http or https, the rest is whatever
// the user wants. We deliberately accept http:// for LAN harnesses (Brandon's
// OpenClaw on phattvip.lan); the trust boundary is the HMAC signature, not
// the transport. The caller MUST be authenticated; the URL is user-supplied.
function validateUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return false;
  return URL_PATTERN.test(url);
}

// Validates a kind string. Returns the canonical form on success, null on
// failure.
function validateKind(kind) {
  if (typeof kind !== 'string') return null;
  const k = kind.trim().toLowerCase();
  return VALID_KINDS.has(k) ? k : null;
}

// Validates an event_filter payload. Stored as JSON. Accepts objects only
// (no arrays, no primitives). Returns the canonical JSON string on success
// or null on failure. Used by the create/update paths.
function validateEventFilter(value) {
  if (value == null) return '{}';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return JSON.stringify(parsed);
    } catch (_) {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function toPublic(row, { includeSecretPlaintext = false, ownerUserId = null } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    user_id: row.user_id,
    harness_label: row.harness_label,
    kind: row.kind,
    url: row.url,
    enabled: !!row.enabled,
    event_filter: parseEventFilter(row.event_filter),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    // The non-secret first-4 + last-4 chip is the same UX pattern as
    // agent-tokens. Helps the user remember which secret is which without
    // shouting the full secret onto the screen.
    secret_prefix: row.secret ? row.secret.slice(0, 16) + '…' : null,
  };
  // Plaintext is exposed ONLY when caller is the owner. An admin calling
  // get() without ownerUserId (the cross-household read path) never sees
  // the secret — that matches the "user owns their endpoint" trust model.
  if (includeSecretPlaintext && ownerUserId != null && row.user_id === ownerUserId) {
    out.secret_plaintext = row.secret;
  }
  return out;
}

function parseEventFilter(json) {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { /* malformed → return empty */ }
  return {};
}

// Creates a new endpoint for `userId`. Auto-generates the HMAC secret on
// insert — the plaintext is returned exactly once. `eventFilter` is
// optional (defaults to `{}`). Returns the public-safe row plus the
// one-time plaintext.
function create(db, userId, { harnessLabel, kind, url, enabled = 1, eventFilter = {} } = {}) {
  const label = (harnessLabel || '').trim();
  if (!label) throw new Error('harness_label required');
  if (label.length > 128) throw new Error('harness_label too long (max 128 chars)');

  const canonicalKind = validateKind(kind);
  if (!canonicalKind) throw new Error('kind must be "drawer" or "events"');

  if (!validateUrl(url)) throw new Error('url must be a valid http(s) URL');

  const filterJson = validateEventFilter(eventFilter);
  if (filterJson === null) throw new Error('event_filter must be a JSON object');

  const { plaintext } = generateSecret();
  const r = db.prepare(`INSERT INTO agent_endpoints
      (user_id, harness_label, kind, url, secret, enabled, event_filter)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, label, canonicalKind, url.trim(), plaintext, enabled ? 1 : 0, filterJson);
  const row = db.prepare('SELECT * FROM agent_endpoints WHERE id = ?').get(r.lastInsertRowid);
  return toPublic(row, { includeSecretPlaintext: true, ownerUserId: userId });
}

// Lists endpoints for a user (or all users, if userId is null — admin
// cross-household view). The plaintext secret is NEVER returned from
// list; callers must read it back through `get` with `includeSecretPlaintext`
// (and only the issuing user, not admins, should have that path — see
// server.js routes).
function list(db, userId) {
  const rows = userId == null
    ? db.prepare('SELECT * FROM agent_endpoints ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM agent_endpoints WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(r => toPublic(r));
}

// Looks up a single endpoint by id. `ownerUserId`, if supplied, scopes
// the lookup to that owner (self-service path). Returns the public row on
// success or null on missing/forbidden.
function get(db, endpointId, { ownerUserId = null, includeSecretPlaintext = false } = {}) {
  const row = db.prepare('SELECT * FROM agent_endpoints WHERE id = ?').get(endpointId);
  if (!row) return null;
  if (ownerUserId != null && row.user_id !== ownerUserId) return null;
  return toPublic(row, { includeSecretPlaintext, ownerUserId });
}

// Mutates a subset of fields on an endpoint. `ownerUserId` (when supplied)
// restricts the mutation to that owner. Returns the updated public row on
// success, null on missing/forbidden. Fields not in `patch` are preserved.
// If `rotateSecret` is true, a fresh HMAC secret is generated and the
// plaintext is returned alongside the row (copy-once reveal).
function update(db, endpointId, patch, { ownerUserId = null, rotateSecret = false } = {}) {
  const existing = db.prepare('SELECT * FROM agent_endpoints WHERE id = ?').get(endpointId);
  if (!existing) return null;
  if (ownerUserId != null && existing.user_id !== ownerUserId) return null;

  const fields = [];
  const values = [];

  // Each `if` here checks the key is present AND non-undefined. The caller
  // controls what "present" means by passing the key (or omitting it).
  // `undefined` is treated as "leave the field alone" so the route layer
  // can forward a destructured `{harness_label, kind, url, ...}` body
  // without conditional gymnastics.
  if (patch.harnessLabel !== undefined) {
    const label = (patch.harnessLabel || '').trim();
    if (!label) throw new Error('harness_label required');
    if (label.length > 128) throw new Error('harness_label too long (max 128 chars)');
    fields.push('harness_label = ?');
    values.push(label);
  }

  if (patch.kind !== undefined) {
    const canonicalKind = validateKind(patch.kind);
    if (!canonicalKind) throw new Error('kind must be "drawer" or "events"');
    fields.push('kind = ?');
    values.push(canonicalKind);
  }

  if (patch.url !== undefined) {
    if (!validateUrl(patch.url)) throw new Error('url must be a valid http(s) URL');
    fields.push('url = ?');
    values.push(patch.url.trim());
  }

  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }

  if (patch.eventFilter !== undefined) {
    const filterJson = validateEventFilter(patch.eventFilter);
    if (filterJson === null) throw new Error('event_filter must be a JSON object');
    fields.push('event_filter = ?');
    values.push(filterJson);
  }

  let newSecretPlaintext = null;
  if (rotateSecret) {
    const { plaintext } = generateSecret();
    newSecretPlaintext = plaintext;
    fields.push('secret = ?');
    values.push(plaintext);
  }

  if (fields.length === 0 && !rotateSecret) {
    return toPublic(existing, { ownerUserId });
  }

  values.push(endpointId);
  db.prepare(`UPDATE agent_endpoints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM agent_endpoints WHERE id = ?').get(endpointId);
  return toPublic(updated, { includeSecretPlaintext: !!newSecretPlaintext, ownerUserId });
}

// Deletes an endpoint. `ownerUserId`, if supplied, restricts the deletion
// to that owner. Returns true if a row was removed.
function remove(db, endpointId, { ownerUserId = null } = {}) {
  const existing = db.prepare('SELECT * FROM agent_endpoints WHERE id = ?').get(endpointId);
  if (!existing) return false;
  if (ownerUserId != null && existing.user_id !== ownerUserId) return false;
  db.prepare('DELETE FROM agent_endpoints WHERE id = ?').run(endpointId);
  return true;
}

// Looks up enabled endpoints for a user + kind — the dispatch-side entry
// point used by the future PHA-1617.6 drawer POST and PHA-1617.7 events
// webhook outbound dispatcher. Returns the full rows (including the
// secret) so the dispatcher can HMAC-sign the outbound POST. Bookkeeping
// fields (`last_used_at`, `last_status_code`, `last_error`) are NOT
// updated here — that's the dispatcher's job via `recordDispatch`.
function listEnabledForDispatch(db, userId, kind) {
  const canonicalKind = validateKind(kind);
  if (!canonicalKind) return [];
  return db.prepare(`SELECT * FROM agent_endpoints
      WHERE user_id = ? AND kind = ? AND enabled = 1
      ORDER BY id`).all(userId, canonicalKind);
}

// Bookkeeping for the dispatch side: updates last_used_at, last_status_code,
// and last_error. Both failed and successful dispatches should call this.
function recordDispatch(db, endpointId, { statusCode = null, error = null } = {}) {
  db.prepare(`UPDATE agent_endpoints
       SET last_used_at = datetime('now'),
           last_status_code = ?,
           last_error = ?
     WHERE id = ?`).run(statusCode, error || null, endpointId);
}

// Computes the HMAC-SHA256 signature for an outbound POST, per design
// doc §6.4: `X-Homestead-Signature: sha256=<hex>` where
// `<hex> = HMAC_SHA256(secret, timestamp + "." + raw_body)`.
//
// Returns the value suitable for the header (including the `sha256=` prefix).
function signPayload(secret, timestamp, rawBody) {
  const h = crypto.createHmac('sha256', secret);
  h.update(String(timestamp));
  h.update('.');
  h.update(rawBody == null ? '' : String(rawBody));
  return 'sha256=' + h.digest('hex');
}

module.exports = {
  KIND_DRAWER,
  KIND_EVENTS,
  VALID_KINDS,
  SECRET_PREFIX_LABEL,
  SECRET_PLAINTEXT_LEN,
  migrate,
  generateSecret,
  validateUrl,
  validateKind,
  validateEventFilter,
  create,
  list,
  get,
  update,
  remove,
  listEnabledForDispatch,
  recordDispatch,
  signPayload,
  toPublic,
};
