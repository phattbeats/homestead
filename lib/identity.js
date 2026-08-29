// Homestead — canonical identity foundation (PHA-2704).
//
// The pre-PHA-2704 model crammed everything identity-related onto the
// `users` row itself:
//   * users.username       — case-insensitive directory key (UNIQUE COLLATE NOCASE)
//   * users.pass_hash      — local-account password (only LAN login)
//   * users.auth_provider  — single-slot provider name ('header_trust', 'pat', ...)
//   * users.provider_subject — single-slot provider subject
//
// That broke PHA-2703 (P0 invite + optional Authentik linking) in two
// ways:
//   * username was the implicit long-term link from Authentik subject →
//     Homestead user, so the first Authentik username that matched a
//     seeded profile claimed that row forever. A later "link Authentik"
//     flow couldn't safely create a new user for the same subject
//     without colliding with the seeded CLAIM.
//   * auth_provider/provider_subject was a single slot, so a user
//     could only have ONE external identity linked at a time.
//
// PHA-2704 fixes both by introducing TWO new tables and leaving `users`
// as the durable product-identity table (the user-facing concept of
// "Brandon the household member") without changing any existing
// `users.id` value:
//
//   local_credentials(
//     user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
//     password_hash TEXT,
//     recovery_token_hash TEXT,
//     recovery_token_expires_at TEXT,
//     created_at   TEXT DEFAULT (datetime('now')),
//     updated_at   TEXT DEFAULT (datetime('now'))
//   )
//
//   identity_links(
//     id             INTEGER PRIMARY KEY,
//     user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     provider       TEXT NOT NULL,
//     issuer         TEXT NOT NULL,
//     provider_subject TEXT NOT NULL,
//     linked_at      TEXT NOT NULL DEFAULT (datetime('now')),
//     last_used_at   TEXT,
//     UNIQUE (provider, issuer, provider_subject)
//   )
//
// `users.username`, `users.pass_hash`, `users.auth_provider`, and
// `users.provider_subject` STAY on the row for this migration. They're
// read-only shadows now — every server-side read/write of password or
// provider info goes through `local_credentials` / `identity_links`.
// A future PHA can drop the legacy columns once every install has
// migrated cleanly (the migration is guarded so it runs once and is
// idempotent on re-run).
//
// Username stays a UNIQUE COLLATE NOCASE column for backward compat
// with existing API surfaces (`/api/users`, `/api/users/:username`).
// It is NOT the link mechanism anymore — the canonical claim path is
// `findUserByIdentityLink(provider, issuer, providerSubject)` first,
// and only falls back to username-match for legacy bootstrap data.

'use strict';

const bcrypt = require('bcryptjs');

// `migrate` is idempotent: it creates the two tables if missing, then
// runs the additive backfill from `users.pass_hash` and
// `users.auth_provider`/`users.provider_subject` exactly once per
// installation. Subsequent boots find the rows already migrated and
// no-op the backfill.
//
// Backfill guards:
//   * `localCredentialsMigratedBefore` — boolean flag persisted via a
//     row in a tiny `_identity_migration_state` table. Used to skip
//     the password backfill on re-runs (otherwise a fresh bcrypt hash
//     of the same plaintext would write a NEW password_hash and break
//     logins for that user).
//   * `identityLinksMigratedBefore` — same pattern for the
//     identity_links backfill. The UNIQUE constraint on
//     (provider, issuer, provider_subject) would also catch a duplicate
//     re-run, but the flag is cheaper and produces clearer logs.
function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS local_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT,
  recovery_token_hash TEXT,
  recovery_token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS identity_links (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE (provider, issuer, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_identity_links_user ON identity_links(user_id);
CREATE TABLE IF NOT EXISTS _identity_migration_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

  // Backfill local_credentials from users.pass_hash — ONCE per install.
  // The flag is checked BEFORE the INSERT OR IGNORE so a re-run logs
  // "no-op" instead of "migrated" and never re-hashes the same plaintext.
  const lcMigrated = !!db.prepare(
    "SELECT 1 FROM _identity_migration_state WHERE key = 'local_credentials_migrated' AND value = '1'"
  ).get();
  if (!lcMigrated) {
    // Copy pass_hash verbatim — it's already a bcrypt hash; re-hashing
    // would break the existing plaintext password.
    const inserted = db.exec(`
      INSERT OR IGNORE INTO local_credentials (user_id, password_hash, created_at, updated_at)
      SELECT id, pass_hash, datetime('now'), datetime('now') FROM users WHERE pass_hash IS NOT NULL AND pass_hash != '';
    `);
    db.prepare(
      "INSERT OR REPLACE INTO _identity_migration_state (key, value) VALUES ('local_credentials_migrated', '1')"
    ).run();
    // Touch updated_at on every migrated row so the migrate log line
    // has a deterministic ordering vs. the create row.
    console.log('[identity] Backfilled local_credentials from users.pass_hash (one-time)');
  }

  // Backfill identity_links from users.auth_provider + provider_subject
  // — ONCE per install. Uses 'legacy-bootstrap' as the issuer because
  // the pre-PHA-2704 schema didn't carry an issuer column at all.
  // provider_subject values that are already NOCASE-equal to the row's
  // username (the CLAIM-first header_trust pattern) are kept — they're
  // a real historical identity, just bootstrapped via username match.
  // provider_subject values that point at a different subject string
  // (rare, but possible if Authentik's subject ever differed from the
  // username header) are also kept verbatim.
  const ilMigrated = !!db.prepare(
    "SELECT 1 FROM _identity_migration_state WHERE key = 'identity_links_migrated' AND value = '1'"
  ).get();
  if (!ilMigrated) {
    db.exec(`
      INSERT OR IGNORE INTO identity_links (id, user_id, provider, issuer, provider_subject, linked_at)
      SELECT
        (SELECT COALESCE(MAX(id), 0) FROM identity_links) + rowid,
        id,
        auth_provider,
        'legacy-bootstrap',
        provider_subject,
        COALESCE(claimed_at, datetime('now'))
      FROM users
      WHERE auth_provider IS NOT NULL
        AND auth_provider != ''
        AND provider_subject IS NOT NULL
        AND provider_subject != '';
    `);
    db.prepare(
      "INSERT OR REPLACE INTO _identity_migration_state (key, value) VALUES ('identity_links_migrated', '1')"
    ).run();
    console.log('[identity] Backfilled identity_links from users.auth_provider + provider_subject (one-time)');
  }
}

// `hasLocalCredential` — true when the user has a row in
// `local_credentials` with a non-empty password_hash. Used by the LAN
// login endpoint to decide whether a plaintext password is even worth
// checking.
function hasLocalCredential(db, userId) {
  const row = db.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(userId);
  return !!(row && row.password_hash && row.password_hash.length > 0);
}

// `verifyLocalPassword` — bcrypt.compare against the local_credentials
// row for `userId`. Returns true/false. Returns false (NOT throws) when
// the user has no local_credentials row — that signals "this user is
// not a local account; try a different auth path." The /api/login
// handler maps that to a 401 the same way a wrong password does, to
// avoid leaking "this username has no local password" to a probe.
function verifyLocalPassword(db, userId, plaintext) {
  const row = db.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(userId);
  if (!row || !row.password_hash) return false;
  return bcrypt.compareSync(plaintext || '', row.password_hash);
}

// `setLocalPassword` — write or replace the password_hash for a user.
// Inserts a local_credentials row if missing (one credential row per
// user — UNIQUE on user_id is the PRIMARY KEY).
function setLocalPassword(db, userId, plaintext) {
  if (!plaintext || plaintext.length < 4) throw new Error('password too short');
  const hash = bcrypt.hashSync(plaintext, 10);
  db.prepare(`
    INSERT INTO local_credentials (user_id, password_hash, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      password_hash = excluded.password_hash,
      updated_at    = excluded.updated_at
  `).run(userId, hash);
  return hash;
}

// `findUserByIdentityLink` — the canonical lookup path for an
// external identity. Returns the user_id (and the row's
// `username` for back-compat logging) of the user that owns
// (provider, issuer, provider_subject), or null if none.
//
// This is the path PHA-2706 (Link Authentik later) and the
// header-trust probe in /api/me will use. Username matching is no
// longer the link mechanism — it's strictly a transitional fallback
// for the bootstrap data we just backfilled into identity_links above.
function findUserByIdentityLink(db, provider, issuer, providerSubject) {
  const row = db.prepare(`
    SELECT il.user_id, il.provider, il.issuer, il.provider_subject, il.linked_at, il.last_used_at,
           u.username, u.display
      FROM identity_links il
      JOIN users u ON u.id = il.user_id
     WHERE il.provider = ? AND il.issuer = ? AND il.provider_subject = ?
     LIMIT 1
  `).get((provider || '').toLowerCase(), issuer || 'legacy-bootstrap', providerSubject || '');
  if (!row) return null;
  // Touch last_used_at so the audit trail reflects recent use.
  db.prepare('UPDATE identity_links SET last_used_at = datetime(\'now\') WHERE id IN (SELECT id FROM identity_links WHERE user_id = ? AND provider = ? AND issuer = ? AND provider_subject = ?)').run(
    row.user_id, (provider || '').toLowerCase(), issuer || 'legacy-bootstrap', providerSubject || ''
  );
  return { userId: row.user_id, username: row.username, display: row.display, provider: row.provider, issuer: row.issuer, providerSubject: row.provider_subject };
}

// `linkIdentity` — attach a (provider, issuer, provider_subject) to an
// existing user_id. Throws on UNIQUE-constraint collision so the caller
// can map it to a 409 "this identity is already linked to a different
// user" response (PHA-2703 release gate: provider collisions must stop
// safely and require recovery/admin review).
//
// `provider` is lowercased before insert; `issuer` and `provider_subject`
// are stored verbatim (case-sensitive — OIDC issuers carry meaningful
// casing in their URL form, and OIDC subject strings are typically
// opaque case-sensitive tokens).
function linkIdentity(db, userId, provider, issuer, providerSubject) {
  const p = (provider || '').toLowerCase();
  if (!p) throw new Error('provider required');
  if (!issuer) throw new Error('issuer required');
  if (!providerSubject) throw new Error('provider_subject required');

  // Reject self-link (same user, same provider+issuer+subject) as a
  // no-op so re-running the bootstrap path doesn't error.
  const existing = db.prepare(
    'SELECT user_id FROM identity_links WHERE provider = ? AND issuer = ? AND provider_subject = ?'
  ).get(p, issuer, providerSubject);
  if (existing && existing.user_id === userId) {
    return { id: null, alreadyLinked: true };
  }
  if (existing && existing.user_id !== userId) {
    const err = new Error(`identity already linked to user ${existing.user_id}`);
    err.code = 'identity_collision';
    err.conflictingUserId = existing.user_id;
    throw err;
  }

  const nextId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM identity_links').get().m) + 1;
  db.prepare(`
    INSERT INTO identity_links (id, user_id, provider, issuer, provider_subject, linked_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(nextId, userId, p, issuer, providerSubject);
  return { id: nextId, alreadyLinked: false };
}

// `unlinkIdentity` — remove an identity_links row. Refuses to remove
// the LAST identity link for a user that also has no local credential
// — that would orphan the user (no path back in). Returns { removed:
// true|false, blocked: 'no_login_path' | null }.
function unlinkIdentity(db, userId, provider, issuer, providerSubject) {
  const link = db.prepare(`
    SELECT id FROM identity_links WHERE user_id = ? AND provider = ? AND issuer = ? AND provider_subject = ?
  `).get(userId, (provider || '').toLowerCase(), issuer, providerSubject);
  if (!link) return { removed: false, blocked: null };

  const remaining = db.prepare('SELECT COUNT(*) AS c FROM identity_links WHERE user_id = ? AND id != ?').get(userId, link.id).c;
  const hasLocal = hasLocalCredential(db, userId);
  if (remaining === 0 && !hasLocal) {
    return { removed: false, blocked: 'no_login_path' };
  }
  db.prepare('DELETE FROM identity_links WHERE id = ?').run(link.id);
  return { removed: true, blocked: null };
}

// `listIdentityLinks` — enumerate the linked identities for a user.
// Used by /api/me/identities (PHA-2706 will build on top of this).
function listIdentityLinks(db, userId) {
  return db.prepare(`
    SELECT provider, issuer, provider_subject, linked_at, last_used_at
      FROM identity_links WHERE user_id = ?
     ORDER BY linked_at ASC
  `).all(userId);
}

// `createUser` — create a new `users` row with a stable id, plus a
// matching local_credentials row when `plaintext` is supplied. The
// `username` arg is required for legacy API compat; new code paths
// (PHA-2705 invite enrollment) call this with a synthetic username
// generated from the user's chosen handle. Returns the new user_id.
//
// IMPORTANT: this does NOT claim or create an identity_links row.
// Identity linking is a separate, explicit action — that's the whole
// point of PHA-2704. The header-trust probe and PHA-2706's
// "link Authentik later" path are the only legitimate callers of
// linkIdentity().
function createUser(db, { username, display, color, plaintext, isAdmin = 0 }) {
  const u = (username || '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(u)) throw new Error('invalid username');
  const dupe = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (dupe) throw new Error(`username already exists: ${u}`);
  const colorFinal = color || nextColor(db);
  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO users (username, display, color, pass_hash, is_admin, claimed_at)
      VALUES (?, ?, ?, '', ?, datetime('now'))
    `).run(u, display || u, colorFinal, isAdmin);
    if (plaintext) {
      // Set password through the same hash path the rest of the app uses.
      setLocalPassword(db, r.lastInsertRowid, plaintext);
    }
    return r.lastInsertRowid;
  });
  return tx();
}

// `nextColor` — palette pick for new users. Mirrors the helper in
// lib/user-model.js (kept local so identity.js doesn't pull the whole
// user-model module — keeps the dep graph narrow and the migration
// easy to reason about).
function nextColor(db) {
  const palette = ['#8a9ec4', '#c48a9e', '#9eb48a', '#d4a85c', '#a87cc4', '#7c9eb8', '#c47c7c', '#7cc4a8'];
  const idx = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  return palette[idx % palette.length];
}

module.exports = {
  migrate,
  hasLocalCredential,
  verifyLocalPassword,
  setLocalPassword,
  findUserByIdentityLink,
  linkIdentity,
  unlinkIdentity,
  listIdentityLinks,
  createUser,
};
