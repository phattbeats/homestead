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
//     owner_recovery_token_hash TEXT,          -- added by PHA-2708 (ported as PHA-2719)
//     owner_recovery_token_expires_at TEXT,     -- added by PHA-2708 (ported as PHA-2719)
//     created_at   TEXT DEFAULT (datetime('now')),
//     updated_at   TEXT DEFAULT (datetime('now'))
//   )
//
// `recovery_token_hash` / `recovery_token_expires_at` are owned
// exclusively by the general-purpose PHA-2711 invite/password-reset
// flow (lib/invites.js createResetToken/consumeResetToken, consumed
// via POST /api/public/invites/reset). `owner_recovery_token_hash` /
// `owner_recovery_token_expires_at` are owned exclusively by the
// owner-only break-glass flow below (mintOwnerRecoveryToken /
// consumeOwnerRecoveryToken, consumed via POST
// /api/admin/owner/recover). The two mechanisms are deliberately
// non-colliding — minting one must never clobber the other for the
// same user.
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

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// `OWNER_USERNAME` — the canonical owner of this Homestead install.
//
// Today Homestead has exactly one household owner (the CLAIM-first
// `admin` profile). The owner is the break-glass target: their login
// path is the last line of defense when Authentik is unreachable, and
// their recovery is the only path back when all external identities
// fail. PHA-2708 (ported forward as part of PHA-2719) hard-codes the
// owner concept to `is_admin = 1` (which the user-model reconcile
// keeps in sync with the `admins` Authentik group). If a future PHA
// introduces multi-admin, this constant + `findOwnerUserId` below are
// the two places to revisit.
const OWNER_USERNAME = 'admin';

// `findOwnerUserId` — resolve the owner user_id. Returns the first
// `is_admin = 1` row by id ASC. This is the canonical owner for
// every owner-protection decision in PHA-2708.
function findOwnerUserId(db) {
  const row = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get();
  return row ? row.id : null;
}

// `isOwner` — true when `userId` is the household owner. The owner
// is the single is_admin=1 user seeded at install and kept in sync
// with the admins group via reconcileGroups.
function isOwner(db, userId) {
  if (!userId) return false;
  const ownerId = findOwnerUserId(db);
  return ownerId !== null && ownerId === userId;
}

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

  // PHA-2708 owner-recovery cascade (ported forward as PHA-2719): add
  // two columns to local_credentials dedicated to the OWNER
  // break-glass flow — `owner_recovery_token_hash` and
  // `owner_recovery_token_expires_at`. These are intentionally
  // SEPARATE from the `recovery_token_hash` / `recovery_token_expires_at`
  // pair above, which stay exclusively owned by the general-purpose
  // PHA-2711 invite/password-reset flow (lib/invites.js
  // createResetToken/consumeResetToken). Sharing one pair of columns
  // between the two mechanisms would let minting one kind of token
  // silently clobber (or be clobbered by) the other kind for the same
  // user — a real bug, not just a naming collision. Dedicated columns
  // make the two flows non-colliding.
  //
  // `ALTER TABLE ... ADD COLUMN` errors if the column already exists,
  // so guard with a PRAGMA table_info check (belt) AND the same
  // _identity_migration_state flag pattern used above (suspenders) —
  // either guard alone is sufficient; both keep re-run logs accurate.
  const ownerRecoveryColsAdded = !!db.prepare(
    "SELECT 1 FROM _identity_migration_state WHERE key = 'owner_recovery_columns_added' AND value = '1'"
  ).get();
  if (!ownerRecoveryColsAdded) {
    const lcCols = db.prepare('PRAGMA table_info(local_credentials)').all().map((c) => c.name);
    if (!lcCols.includes('owner_recovery_token_hash')) {
      db.exec('ALTER TABLE local_credentials ADD COLUMN owner_recovery_token_hash TEXT');
    }
    if (!lcCols.includes('owner_recovery_token_expires_at')) {
      db.exec('ALTER TABLE local_credentials ADD COLUMN owner_recovery_token_expires_at TEXT');
    }
    db.prepare(
      "INSERT OR REPLACE INTO _identity_migration_state (key, value) VALUES ('owner_recovery_columns_added', '1')"
    ).run();
    console.log('[identity] Added owner_recovery_token_hash / owner_recovery_token_expires_at columns to local_credentials (one-time)');
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
// — that would orphan the user (no path back in).
//
// PHA-2708 strengthening (ported forward as PHA-2719): for the
// household owner, refuses the unlink when this removal would leave
// the owner with no path back into Homestead (no local credential AND
// this was the last identity_link). The block reason
// `would_lock_out_owner` is distinct from `no_login_path` so callers
// can surface a clear "this is the owner" error. Returns { removed:
// true|false, blocked: 'no_login_path' | 'would_lock_out_owner' | null }.
function unlinkIdentity(db, userId, provider, issuer, providerSubject) {
  const link = db.prepare(`
    SELECT id FROM identity_links WHERE user_id = ? AND provider = ? AND issuer = ? AND provider_subject = ?
  `).get(userId, (provider || '').toLowerCase(), issuer, providerSubject);
  if (!link) return { removed: false, blocked: null };

  const remaining = db.prepare('SELECT COUNT(*) AS c FROM identity_links WHERE user_id = ? AND id != ?').get(userId, link.id).c;
  const hasLocal = hasLocalCredential(db, userId);
  if (remaining === 0 && !hasLocal) {
    // PHA-2708: if this is the owner, refuse even harder — the owner
    // is the canonical break-glass target and losing their last login
    // path is the lockout we're trying to prevent. The owner recovery
    // path is the ONLY sanctioned way to remove the owner's local
    // credential, and it goes through a fresh host-side mint, not
    // this API.
    if (isOwner(db, userId)) {
      return { removed: false, blocked: 'would_lock_out_owner' };
    }
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

// `resolveAgentHandle` — collision avoidance for agent provisioning
// (PHA-2647 honest-identity clause: "the human handle wins, the agent
// gets a suffix or numeric disambiguation"). `users.username` is
// already UNIQUE COLLATE NOCASE, so createUser() would just throw on a
// collision — this picks a free variant instead, deterministically,
// so an agent's preferred handle never bumps an existing (human or
// agent) user off their own name.
function resolveAgentHandle(db, desiredUsername) {
  const base = (desiredUsername || '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(base)) throw new Error('invalid username');
  const taken = (u) => !!db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (!taken(base)) return base;
  const firstSuffix = '-agent';
  const firstCandidate = `${base.slice(0, 32 - firstSuffix.length)}${firstSuffix}`;
  if (!taken(firstCandidate)) return firstCandidate;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-agent-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`could not find a free handle for '${base}'`);
}

// `createAgentUser` — createUser() wrapper for agent provisioning that
// never throws on a name collision; see resolveAgentHandle above.
// Returns { id, username } — `username` may differ from the requested
// one if disambiguation kicked in.
function createAgentUser(db, { username, display, color } = {}) {
  const handle = resolveAgentHandle(db, username);
  const id = createUser(db, { username: handle, display: display || username, color });
  return { id, username: handle };
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

// ---- PHA-2708 owner recovery primitives (ported forward as PHA-2719) ----
//
// Goal: a clean, audited, non-destructive password-reset path for the
// household owner that does NOT require Authentik and does NOT require
// the owner's existing password. The whole point is to be the LAST
// line of defense when Authentik is down AND the owner has forgotten
// the LAN password.
//
// `parseIsoUtc` — robust ISO-8601 → epoch-ms parser. Kept for values
// that might be stored in the SQLite-default `datetime('now')` shape
// (`YYYY-MM-DD HH:MM:SS`, no timezone). Naive concatenation
// (`new Date(s + 'Z')`) returns NaN on that shape AND double-Zs an
// already-`Z`-suffixed ISO value. Treat the value as UTC no matter
// what: append `Z` if missing, trim a trailing `Z` if it's already
// there, then parse.
//
// Returns NaN on garbage (callers must check).
function parseIsoUtc(s) {
  if (!s) return NaN;
  const t = String(s).trim();
  const withZ = /Z$/.test(t) ? t : (t + 'Z');
  return new Date(withZ).getTime();
}

// `parseExpiresAt` — accept either an ISO-8601 string OR a
// millisecond-integer string (the latter is what
// `mintOwnerRecoveryToken` writes since we switched to ms-precision
// storage to keep the second-stripping round-trip from collapsing
// short TTLs). Returns NaN on garbage.
function parseExpiresAt(s) {
  if (!s) return NaN;
  // Pure digits → millisecond epoch.
  if (/^\d+$/.test(String(s).trim())) {
    return Number(String(s).trim());
  }
  return parseIsoUtc(s);
}

// Storage: `local_credentials.owner_recovery_token_hash` /
// `owner_recovery_token_expires_at` are dedicated columns added by
// the `migrate()` step above, specifically for this mechanism. They
// are DISTINCT from `recovery_token_hash` / `recovery_token_expires_at`,
// which stay exclusively owned by the general-purpose PHA-2711
// invite/password-reset flow (lib/invites.js). This section adds the
// mint + consume primitives on top of the dedicated owner columns,
// plus an `auditOwnerRecovery` helper that records every event into
// the analytics_events table so the operator has a recoverable trail
// without any new table.
//
// Threat model:
//   * The token is 32 random bytes (hex-encoded for transport).
//     256 bits of entropy. A leaked token is valid for `ttlMs` and
//     can reset the owner's password exactly once.
//   * The token never leaves the host machine in plaintext form
//     besides the one-shot mint-to-operator output. It is hashed
//     (sha256, hex) before persisting to `owner_recovery_token_hash`.
//   * The `mintOwnerRecoveryToken` API refuses to mint a NEW token
//     while a non-expired token sits in the row. Token stacking
//     would let a prior leaked token race a fresh one; one active
//     token at a time is the simpler invariant.
//   * `consumeOwnerRecoveryToken` clears the hash + expiry on a
//     successful consume, so the SAME token cannot be replayed even
//     within the TTL window.

// `mintOwnerRecoveryToken` — generate a one-shot reset token for the
// household owner. Returns `{ token, userId, username, expiresAt,
// alreadyActive }`. `token` is the plaintext token to hand to the
// operator (printed by the CLI; delivered to the recovery consumer
// via header/body). The DB only ever sees the sha256(token).
//
// `ttlMs` defaults to 60 minutes. Operators are expected to use the
// token within that window. The token is bound to the owner row —
// if the owner is replaced (future PHA), old tokens do not migrate.
function mintOwnerRecoveryToken(db, { ttlMs = 60 * 60 * 1000 } = {}) {
  const ownerId = findOwnerUserId(db);
  if (ownerId == null) {
    const err = new Error('no owner user found');
    err.code = 'no_owner';
    throw err;
  }
  const owner = db.prepare('SELECT id, username, display FROM users WHERE id = ?').get(ownerId);
  if (!owner) {
    const err = new Error('owner row vanished');
    err.code = 'no_owner';
    throw err;
  }
  // Refuse to mint when an unexpired token is already active. This
  // is the simplest invariant: one active token at a time. The
  // operator can wait for expiry OR call clearOwnerRecoveryToken
  // explicitly (which audits the reason).
  const existing = db.prepare(`
    SELECT owner_recovery_token_hash AS h, owner_recovery_token_expires_at AS exp
      FROM local_credentials WHERE user_id = ?
  `).get(ownerId);
  if (existing && existing.h && existing.exp && parseExpiresAt(existing.exp) > Date.now()) {
    return {
      token: null,
      userId: ownerId,
      username: owner.username,
      display: owner.display,
      expiresAt: existing.exp,
      alreadyActive: true,
    };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  // Store the expiry as a millisecond integer string — keeps the
  // comparison exact at second-stripping boundaries, which ISO
  // strings can't guarantee.
  const expiresAtMs = Date.now() + ttlMs;
  const expiresAt = String(expiresAtMs);

  db.prepare(`
    INSERT INTO local_credentials (user_id, owner_recovery_token_hash, owner_recovery_token_expires_at, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      owner_recovery_token_hash        = excluded.owner_recovery_token_hash,
      owner_recovery_token_expires_at  = excluded.owner_recovery_token_expires_at,
      updated_at                       = excluded.updated_at
  `).run(ownerId, tokenHash, expiresAt);

  return {
    token,
    userId: ownerId,
    username: owner.username,
    display: owner.display,
    expiresAt,
    alreadyActive: false,
  };
}

// `clearOwnerRecoveryToken` — drop any active recovery token for the
// owner (admin-initiated revocation). Returns `{ cleared: boolean }`.
// Used by the operator when an active token is leaked: kill the
// active token and force a fresh mint.
function clearOwnerRecoveryToken(db) {
  const ownerId = findOwnerUserId(db);
  if (ownerId == null) return { cleared: false };
  const r = db.prepare(`
    UPDATE local_credentials
       SET owner_recovery_token_hash = NULL,
           owner_recovery_token_expires_at = NULL,
           updated_at = datetime('now')
     WHERE user_id = ?
  `).run(ownerId);
  return { cleared: r.changes > 0 };
}

// `consumeOwnerRecoveryToken` — verify the token, set the new
// password, clear the hash on success. Returns:
//   * { ok: true,  userId, username } on success
//   * { ok: false, code: 'invalid_or_expired_token' } on bad token
//
// The function refuses to operate on anything other than the owner.
// A non-owner consumer cannot ride this path because `findOwnerUserId`
// is the only userId looked up here. Audit is written by the caller
// (server.js), which also captures the request context (IP, route).
function consumeOwnerRecoveryToken(db, token, newPassword) {
  if (!token || typeof token !== 'string') {
    return { ok: false, code: 'invalid_or_expired_token' };
  }
  const ownerId = findOwnerUserId(db);
  if (ownerId == null) {
    return { ok: false, code: 'invalid_or_expired_token' };
  }
  const row = db.prepare(`
    SELECT owner_recovery_token_hash AS h, owner_recovery_token_expires_at AS exp, password_hash AS pw
      FROM local_credentials WHERE user_id = ?
  `).get(ownerId);
  if (!row || !row.h || !row.exp) {
    return { ok: false, code: 'invalid_or_expired_token' };
  }
  if (parseExpiresAt(row.exp) <= Date.now()) {
    // Expired — clean up the hash so a stale token cannot sit in
    // the row forever (it's also what the operator-issued rotation
    // expects when an expired token is presented).
    db.prepare('UPDATE local_credentials SET owner_recovery_token_hash = NULL, owner_recovery_token_expires_at = NULL, updated_at = datetime(\'now\') WHERE user_id = ?').run(ownerId);
    return { ok: false, code: 'invalid_or_expired_token' };
  }
  const presentedHash = crypto.createHash('sha256').update(token).digest('hex');
  // constant-time compare via timingSafeEqual — the DB lookup
  // already short-circuits on missing rows, but a present-but-wrong
  // token must not leak via timing.
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(row.h, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 'invalid_or_expired_token' };
  }
  // Token matches and is fresh — rotate the password and CLEAR the
  // recovery columns. Replay within TTL is impossible because the
  // hash is gone.
  setLocalPassword(db, ownerId, newPassword);
  db.prepare(`
    UPDATE local_credentials
       SET owner_recovery_token_hash = NULL,
           owner_recovery_token_expires_at = NULL,
           updated_at = datetime('now')
     WHERE user_id = ?
  `).run(ownerId);
  // Sync the legacy users.pass_hash shadow so any legacy code path
  // still sees the right hash (admin tools, /api/users, etc.).
  db.prepare('UPDATE users SET pass_hash = (SELECT password_hash FROM local_credentials WHERE user_id = ?) WHERE id = ?').run(ownerId, ownerId);
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId);
  return { ok: true, userId: ownerId, username: u ? u.username : null };
}

// `auditOwnerRecovery` — write an `owner_recovery` analytics event.
// The analytics_events table is the existing audit log; we reuse it
// so we don't grow a parallel audit-log table for one feature.
//
// `meta` is persisted as JSON. Callers MUST NOT pass plaintext
// tokens, password hashes, or plaintext passwords. The `kind` enum
// stays narrow so it's filterable in the analytics feed:
//   * 'owner_recovery_minted'  — token issued (operator ran the CLI).
//   * 'owner_recovery_consumed'— token used, password rotated.
//   * 'owner_recovery_revoked' — operator cleared an active token.
//   * 'owner_recovery_rejected'— consumer presented bad/expired token.
//   * 'owner_password_reset_by_admin'  — admin used the normal password
//     reset path (not the recovery path) to rotate the owner's password.
//   * 'password_reset_by_admin' — admin reset a non-owner's password.
//
// `actor` is the caller's username (operator who ran the CLI, or
// session user for the admin route). For the CLI mint this is the
// OS user; for the admin route this is the session username.
function auditOwnerRecovery(db, { kind, actor, userId, meta }) {
  if (!KINDS.has(kind)) {
    throw new Error(`auditOwnerRecovery: unknown kind ${kind}`);
  }
  db.prepare(`
    INSERT INTO analytics_events (user_id, kind, subject_type, subject_id, meta)
    VALUES (?, ?, 'owner_recovery', ?, ?)
  `).run(userId || null, kind, userId || null, JSON.stringify(meta || {}));
  return true;
}

const KINDS = new Set([
  'owner_recovery_minted',
  'owner_recovery_consumed',
  'owner_recovery_revoked',
  'owner_recovery_rejected',
  'owner_password_reset_by_admin',
  'password_reset_by_admin',
]);

module.exports = {
  OWNER_USERNAME,
  migrate,
  hasLocalCredential,
  verifyLocalPassword,
  setLocalPassword,
  findUserByIdentityLink,
  linkIdentity,
  unlinkIdentity,
  listIdentityLinks,
  createUser,
  findOwnerUserId,
  isOwner,
  mintOwnerRecoveryToken,
  clearOwnerRecoveryToken,
  consumeOwnerRecoveryToken,
  auditOwnerRecovery,
  parseIsoUtc,
  parseExpiresAt,
  RECOVERY_KINDS: KINDS,
  resolveAgentHandle,
  createAgentUser,
};
