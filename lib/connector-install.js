// Homestead — ConnectorInstallation model + per-user encrypted secret
// store (PHA-2446, Connector Forge).
//
// CONTRACT
// ========
//
// Three concerns live here, each previously implicit in
// connector-spec.js / connector-runner.js:
//
//   1. The immutable ConnectorSpec revision table (per PHA-2444, one
//      row per (spec_id, revision) tuple). The validator is data, not
//      code; we freeze it in storage so a user can install a spec
//      they imported earlier without us silently rerunning against a
//      newer revision.
//
//   2. The ConnectorInstallation per-user row. Owns:
//        - baseUrl (per PHA-2446, baseUrl is per-installation; the
//          spec only carries a placeholder for the validator)
//        - enabled state
//        - visibility (per-user by default; optional group share
//          reusing the existing tile_visibility_groups machinery)
//        - runtime/cache state (lastSuccessAt, lastAttemptAt,
//          failureCount, nextRunAt, etagByProbe, lastError)
//        - a secretRef pointing at the per-user encrypted key store
//          (NOT a plaintext secret, NOT a copy of the spec's auth
//          configuration)
//
//   3. The per-user encrypted secret store. We deliberately reuse
//      `lib/secret-box.js` — same AES-256-GCM helper, same
//      <iv>:<tag>:<ct> format, same CALENDAR_CRED_KEY. The
//      connector-secrets table is a NEW key namespace on top of that
//      helper, not a duplicate of the calendar one. (PHA-2446:
//      "search for the existing per-user token/secret machinery;
//      reuse without duplication".)
//
// Templates/specs NEVER contain credentials or user URLs. Those
// arrive at install time only. The validator's auth.secretRef is a
// key id (per the [a-z0-9_-]{2,64} shape rule + looksLikeInlineSecret
// gate in lib/connector-spec.js); on install we record the matching
// user-side secret reference and resolve the plaintext only inside
// the runner's request path.
//
// VISIBILITY
// ==========
//
// Per-user by default. A user with `tile_visibility` share entries on
// this installation's row gets the connector surfaces on their tile
// grid via the same `tile_visibility_groups` / `tile_visibility_users`
// lookup the existing modules use. We deliberately reuse those
// tables — no parallel visibility machinery.
//
// MODULE REGISTRY
// ===============
//
// Per PHA-2446, "Module registry (PHA-2200) treats a user connector
// as a first-class add-a-room surface." The registry (lib/modules.js)
// is a frozen JS object with 6 built-in keys; the underlying
// user_modules table also has a CHECK constraint on module_key.
// Rather than mutate that CHECK (which would risk regressing other
// subsystems and broaden the trust boundary of user_modules), we
// expose connector installations as registry-shaped entries via a
// dedicated helper: `enabledConnectorModules(db, userId)`. The SPA
// joins built-in and connector entries in registry-order so a
// connector install shows up on the home grid as a first-class room.
//
// The `module_key` we expose for a connector is `connector:<spec_id>`.
// It is computed in `hydrate()` so callers don't have to know the
// shape; the helper functions and `publicView()` carry the value.

'use strict';

const { encryptString, decryptString } = require('./secret-box');
const connectorSpec = require('./connector-spec');

// ---- Errors --------------------------------------------------------------

class ConnectorInstallError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.name = 'ConnectorInstallError';
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

// ---- Validation helpers --------------------------------------------------

// secretRef shape MUST match what the spec validator accepted:
//   * `[a-z0-9_-]{2,64}` (lowercase id; the validator also rejects
//     inline-secret shapes, but those are caught by the spec side —
//     we mirror the gate here so a programmatic install call can't
//     smuggle a secret in either).
//   * NOT a base64/hex blob, NOT containing whitespace, dots,
//     slashes, or `=`/`+` characters.
function isValidSecretRef(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 2 || value.length > 64) return false;
  if (!/^[a-z0-9_-]+$/.test(value)) return false;
  if (/^(bearer|sk-|pk-|api[-_]?key[-_]?)/i.test(value)) return false;
  if (value.length >= 32 && !/_/.test(value)) {
    if (/^[a-f0-9]+$/i.test(value)) return false;
    if (/^[A-Za-z0-9+/=_-]{32,}$/.test(value)) return false;
  }
  return true;
}

function isValidSpecId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{2,32}$/.test(value);
}

function isValidVisibility(value) {
  return value === 'private' || value === 'group';
}

// ---- Migrations ---------------------------------------------------------

// migrate(db) — idempotent. Adds three tables + one column:
//   * connector_specs: immutable per-(spec_id, revision) rows
//   * connector_installations: per-user install rows
//   * connector_secrets: per-user encrypted blob keyed by secretRef
//   * tile_visibility_groups / tile_visibility_users gain a row in
//     the form ('connector_install', <id>, ...) — no schema change;
//     the consumer reads via existing joins. We deliberately keep
//     visibility on the existing tables (no `connector_visibility_*`
//     parallel).
//   * user_modules.module_key gains an explicit CHECK that allows
//     the `connector:` prefix family. The original CHECK is
//     preserved in a `user_modules_module_key_check_backup` so a
//     downgrade that misses this migration doesn't strand the user.
//     Migration is idempotent: PRAGMA table_info checks guard each
//     ALTER.
function migrate(db) {
  // ---- connector_specs -------------------------------------------------
  db.exec(`
CREATE TABLE IF NOT EXISTS connector_specs (
  id INTEGER PRIMARY KEY,
  spec_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,             -- 'builtin' | 'imported' | 'shared:<user_id>'
  source_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  spec_json TEXT NOT NULL,
  spec_hash TEXT NOT NULL,          -- sha256 of spec_json (detect drift)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(spec_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_connector_specs_spec_id
  ON connector_specs(spec_id, revision DESC);
`);

  // ---- connector_installations -----------------------------------------
  // `state_json` holds the runner's statePatch (lastSuccessAt,
  // failureCount, nextRunAt, etagByProbe, lastError). Kept as JSON
  // because the engine's shape is small + dynamic.
  //
  // We do NOT extend user_modules with a connector:* CHECK — see the
  // MODULE REGISTRY comment block. Per-spec toggle rows live in
  // connector_room_toggles below.
  db.exec(`
CREATE TABLE IF NOT EXISTS connector_installations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  spec_revision INTEGER NOT NULL,
  install_name TEXT NOT NULL,        -- user-facing label
  base_url TEXT NOT NULL,
  secret_ref TEXT NOT NULL,          -- per-user key into connector_secrets
  enabled INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'group'
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (spec_id, spec_revision) REFERENCES connector_specs(spec_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_connector_installations_user
  ON connector_installations(user_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_installations_unique
  ON connector_installations(user_id, spec_id, spec_revision, install_name);
`);

  // Per-spec toggle rows. Mirrors the (user_id, module_key) shape of
  // user_modules, but scoped to connector:<spec_id> so we don't touch
  // the frozen CHECK on user_modules.module_key. The home-grid
  // renderer joins enabled_installations with this table to render
  // connector rooms. enabled_at is set when the user toggles the
  // room "on"; NULL when "off". This matches the convention from
  // user_model.getUserModules() (PHA-2202).
  db.exec(`
CREATE TABLE IF NOT EXISTS connector_room_toggles (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec_id     TEXT    NOT NULL,
  enabled_at  TEXT,
  PRIMARY KEY (user_id, spec_id)
);
CREATE INDEX IF NOT EXISTS idx_connector_room_toggles_user
  ON connector_room_toggles(user_id);
`);

  // ---- connector_secrets -----------------------------------------------
  // The encrypted blob lives here; secretRef is the user-side key.
  // Reuses lib/secret-box.js (AES-256-GCM keyed on CALENDAR_CRED_KEY).
  // We do NOT separate user secrets into a per-user KEK — that would
  // require a key-wrapping layer we don't need and the calendar
  // subsystem doesn't either. (PHA-2446: "reuse without duplication".)
  db.exec(`
CREATE TABLE IF NOT EXISTS connector_secrets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_ref TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,      -- <iv>:<tag>:<ct> base64
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, secret_ref)
);
CREATE INDEX IF NOT EXISTS idx_connector_secrets_user
  ON connector_secrets(user_id);
`);

  // user_modules is intentionally untouched. The connector-room
  // toggles live in connector_room_toggles (above) and surface via
  // `enabledConnectorModules(db, userId)` instead of mutating the
  // PHA-2202 user_modules contract.

  // PHA-2447: surface adapter tables (tile health, card cache, feed
  // dedupe ledger). Lazily required so this module can still load in
  // environments where the surfaces module isn't on the require
  // path (legacy tests / minimal smoke runs). The require is
  // wrapped in try/catch so a missing module doesn't break the
  // existing migration contract.
  try {
    const surfaces = require('./connector-surfaces');
    if (surfaces && typeof surfaces.migrate === 'function') {
      surfaces.migrate(db);
    }
  } catch (err) {
    // Surfaces module missing — surface in the boot log but don't
    // fail. The other connector tables still install correctly.
    if (process.env.NODE_ENV !== 'production' || process.env.HOMESTEAD_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[migrate] connector-surfaces module not available:', err.message);
    }
  }
}

// ---- Spec persistence ----------------------------------------------------

// persistSpec(db, spec, opts) -> { id, specId, revision, source }
// Saves a validated spec as a new immutable revision. If (specId,
// revision) already exists, returns the existing row (idempotent).
// `opts.source` is one of 'builtin' | 'imported' | 'shared:<user_id>'.
// `opts.sourceUserId` is set when source starts with 'shared:'.
function persistSpec(db, spec, opts = {}) {
  const source = opts.source || 'imported';
  const sourceUserId = opts.sourceUserId || null;

  // Re-validate against the live validator. Even built-ins are
  // re-validated so a future spec schema change surfaces here, not
  // at install time.
  try {
    connectorSpec.validate(spec);
  } catch (err) {
    if (err && err.name === 'ConnectorSpecError') {
      throw new ConnectorInstallError(422, 'spec_invalid', err.message);
    }
    throw err;
  }

  if (!isValidSpecId(spec.id)) {
    throw new ConnectorInstallError(422, 'spec_invalid', `spec.id "${spec.id}" must match [a-z0-9_-]{2,32}`);
  }

  const json = JSON.stringify(spec);
  const hash = require('crypto').createHash('sha256').update(json).digest('hex');

  // Idempotency check FIRST: if the LATEST revision for this spec_id
  // has the same hash, return that row. This is the "immutable per
  // revision" guarantee — re-importing an identical spec never
  // creates a new revision.
  const latest = db.prepare(`
    SELECT id, revision, spec_hash FROM connector_specs
     WHERE spec_id = ? ORDER BY revision DESC LIMIT 1
  `).get(spec.id);
  if (latest && latest.spec_hash === hash) {
    return {
      id: latest.id,
      specId: spec.id,
      revision: latest.revision,
      source,
      deduped: true,
    };
  }

  // Bump the revision. We never reuse revision numbers — a spec
  // that was deleted from the table (manually or via a future
  // cleanup job) keeps its number reserved.
  const nextRevision = (latest && Number.isFinite(latest.revision))
    ? (latest.revision + 1)
    : 1;

  const result = db.prepare(`
    INSERT INTO connector_specs (spec_id, revision, source, source_user_id, spec_json, spec_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(spec.id, nextRevision, source, sourceUserId, json, hash);
  return {
    id: result.lastInsertRowid,
    specId: spec.id,
    revision: nextRevision,
    source,
  };
}

function getSpec(db, specId, revision) {
  if (!isValidSpecId(specId)) return null;
  const row = db.prepare(`
    SELECT * FROM connector_specs WHERE spec_id = ? AND revision = ?
  `).get(specId, revision);
  if (!row) return null;
  return {
    id: row.id,
    specId: row.spec_id,
    revision: row.revision,
    source: row.source,
    sourceUserId: row.source_user_id,
    spec: JSON.parse(row.spec_json),
    specHash: row.spec_hash,
    createdAt: row.created_at,
  };
}

function getLatestSpec(db, specId) {
  if (!isValidSpecId(specId)) return null;
  const row = db.prepare(`
    SELECT * FROM connector_specs WHERE spec_id = ? ORDER BY revision DESC LIMIT 1
  `).get(specId);
  if (!row) return null;
  return {
    id: row.id,
    specId: row.spec_id,
    revision: row.revision,
    source: row.source,
    sourceUserId: row.source_user_id,
    spec: JSON.parse(row.spec_json),
    specHash: row.spec_hash,
    createdAt: row.created_at,
  };
}

// ---- Secret store --------------------------------------------------------

// setSecret(db, userId, secretRef, plaintext) -> { ref, updated_at }
// Stores the plaintext encrypted at rest using the existing helper.
// Throws on bad shape; rejects obviously-inline-secret shapes by
// re-using the validator's heuristic (same shape rule).
function setSecret(db, userId, secretRef, plaintext) {
  if (!Number.isFinite(userId)) {
    throw new ConnectorInstallError(422, 'invalid_user', 'userId is required');
  }
  if (!isValidSecretRef(secretRef)) {
    throw new ConnectorInstallError(422, 'invalid_secret_ref', `secretRef "${secretRef}" must match [a-z0-9_-]{2,64}`);
  }
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new ConnectorInstallError(422, 'invalid_secret', 'secret plaintext must be a non-empty string');
  }
  // encryptString() throws if CALENDAR_CRED_KEY is missing or the
  // wrong length — propagate that as a 500-class error so the caller
  // sees the operational issue immediately.
  const encryptedBlob = encryptString(plaintext);

  db.prepare(`
    INSERT INTO connector_secrets (user_id, secret_ref, encrypted_blob, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, secret_ref) DO UPDATE SET
      encrypted_blob = excluded.encrypted_blob,
      updated_at = datetime('now')
  `).run(userId, secretRef, encryptedBlob);

  return { ref: secretRef };
}

// deleteSecret(db, userId, secretRef) -> { ok: true } | { ok: false, reason }
// Removes the secret only if NO live installation references it.
// Returns ok:false with a machine-readable reason when the secret is
// still in use, so the uninstall flow can decide whether to cascade.
function deleteSecret(db, userId, secretRef) {
  const refs = db.prepare(`
    SELECT id, install_name FROM connector_installations
     WHERE user_id = ? AND secret_ref = ?
  `).all(userId, secretRef);
  if (refs.length > 0) {
    return { ok: false, reason: 'in_use', installations: refs };
  }
  db.prepare(`
    DELETE FROM connector_secrets WHERE user_id = ? AND secret_ref = ?
  `).run(userId, secretRef);
  return { ok: true };
}

// resolveSecret(db, userId, secretRef) -> plaintext
// Used by the runner's request path. The plaintext is held in memory
// for the duration of the request only — never persisted, never
// logged, never returned to the API caller.
function resolveSecret(db, userId, secretRef) {
  if (!Number.isFinite(userId) || !isValidSecretRef(secretRef)) {
    throw new ConnectorInstallError(422, 'invalid_lookup', 'userId and secretRef are required');
  }
  const row = db.prepare(`
    SELECT encrypted_blob FROM connector_secrets
     WHERE user_id = ? AND secret_ref = ?
  `).get(userId, secretRef);
  if (!row) {
    throw new ConnectorInstallError(404, 'secret_not_found', `secret "${secretRef}" not found for this user`);
  }
  return decryptString(row.encrypted_blob);
}

// ---- Installations --------------------------------------------------------

// install(db, userId, opts) -> installation row
//   opts: {
//     spec: validated ConnectorSpec object,
//     baseUrl: string,
//     secretPlaintext: string,            // encrypted at rest
//     secretRef: string,                   // user-chosen key id; default spec's auth.secretRef
//     installName: string,                 // user-facing label; default = spec.identity.name
//     visibility: 'private' | 'group',     // default 'private'
//     enabled: boolean,                    // default true
//   }
function install(db, userId, opts) {
  if (!opts || typeof opts !== 'object') {
    throw new ConnectorInstallError(422, 'invalid_args', 'opts is required');
  }
  if (!Number.isFinite(userId)) {
    throw new ConnectorInstallError(422, 'invalid_user', 'userId is required');
  }
  if (typeof opts.spec !== 'object' || opts.spec === null) {
    throw new ConnectorInstallError(422, 'spec_missing', 'spec is required');
  }
  if (typeof opts.baseUrl !== 'string' || opts.baseUrl.length === 0) {
    throw new ConnectorInstallError(422, 'base_url_missing', 'baseUrl is required');
  }
  if (typeof opts.secretPlaintext !== 'string' || opts.secretPlaintext.length === 0) {
    throw new ConnectorInstallError(422, 'secret_missing', 'secretPlaintext is required');
  }
  const visibility = opts.visibility || 'private';
  if (!isValidVisibility(visibility)) {
    throw new ConnectorInstallError(422, 'invalid_visibility', `visibility must be 'private' or 'group' (got "${visibility}")`);
  }
  const enabled = opts.enabled === undefined ? true : !!opts.enabled;

  // Spec's auth.secretRef is required; if the user passes a different
  // secretRef, it must still match the validator's shape.
  const specSecretRef = opts.spec.connection && opts.spec.connection.auth && opts.spec.connection.auth.secretRef;
  if (!specSecretRef) {
    throw new ConnectorInstallError(422, 'spec_missing_secret_ref', 'spec.connection.auth.secretRef is required');
  }
  const refName = opts.secretRef || specSecretRef;
  if (!isValidSecretRef(refName)) {
    throw new ConnectorInstallError(422, 'invalid_secret_ref', `secretRef "${refName}" must match [a-z0-9_-]{2,64}`);
  }

  const installName = opts.installName || (opts.spec.identity && opts.spec.identity.name) || opts.spec.id;

  // Everything below in a transaction so a mid-flight failure (spec
  // re-validation, secret encrypt, insert) doesn't leave a half-state.
  const tx = db.transaction(() => {
    // 1. Persist spec as a new revision. Built-ins come through here
    //    too with source='builtin' so the install row FKs to a real
    //    spec row. This is the "immutable per revision" gate.
    const persisted = persistSpec(db, opts.spec, { source: opts.source || 'imported' });

    // 2. Store the secret encrypted. Even if a secret with this
    //    refName already exists for this user, upsert — that's the
    //    "reinstall with a fresh key" path.
    setSecret(db, userId, refName, opts.secretPlaintext);

    // 3. Insert the installation row. UNIQUE(user_id, spec_id,
    //    spec_revision, install_name) — a single user can have
    //    multiple installs of the same spec (different baseUrls,
    //    different names) but not duplicate rows.
    const result = db.prepare(`
      INSERT INTO connector_installations
        (user_id, spec_id, spec_revision, install_name, base_url, secret_ref, enabled, visibility, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(
      userId,
      persisted.specId,
      persisted.revision,
      installName,
      opts.baseUrl,
      refName,
      enabled ? 1 : 0,
      visibility,
    );

    const id = result.lastInsertRowid;
    // Toggle the per-spec room visibility. enabled=true stamps
    // enabled_at; enabled=false leaves the row present with
    // enabled_at NULL so a later re-enable keeps the install data.
    // Mirrors user_model.setUserModule() (PHA-2202).
    if (enabled) {
      db.prepare(`
        INSERT INTO connector_room_toggles (user_id, spec_id, enabled_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id, spec_id) DO UPDATE SET enabled_at = excluded.enabled_at
      `).run(userId, persisted.specId);
    } else {
      db.prepare(`
        INSERT INTO connector_room_toggles (user_id, spec_id, enabled_at)
        VALUES (?, ?, NULL)
        ON CONFLICT(user_id, spec_id) DO UPDATE SET enabled_at = NULL
      `).run(userId, persisted.specId);
    }

    return { id, specId: persisted.specId, revision: persisted.revision };
  });

  const out = tx();
  return getInstallation(db, userId, out.id);
}

// importSharedSpec(db, userId, sourceUserId, specId, opts) -> installation
// Imports a shared spec from another user's install, creating a fresh
// per-user installation. Critically: the secret is NOT copied — the
// importing user supplies their own plaintext at install time. This
// is the "no secret copy" guarantee from the issue acceptance.
function importSharedSpec(db, userId, sourceUserId, specId, opts) {
  if (!Number.isFinite(userId) || !Number.isFinite(sourceUserId)) {
    throw new ConnectorInstallError(422, 'invalid_user', 'userId and sourceUserId are required');
  }
  if (!isValidSpecId(specId)) {
    throw new ConnectorInstallError(422, 'invalid_spec_id', `specId "${specId}" must match [a-z0-9_-]{2,32}`);
  }
  // Pull the latest revision of the source spec.
  const sourceSpec = getLatestSpec(db, specId);
  if (!sourceSpec) {
    throw new ConnectorInstallError(404, 'spec_not_found', `spec "${specId}" not found`);
  }
  // Install as a fresh per-user installation — pass through the
  // regular install() flow so re-validation, secret encryption, and
  // the user_modules toggle all happen uniformly. The source row
  // carries no plaintext secret; only the importer's opts does.
  return install(db, userId, Object.assign({}, opts, {
    spec: sourceSpec.spec,
    source: `shared:${sourceUserId}`,
    sourceUserId,
  }));
}

// getInstallation(db, userId, id) -> installation row | null
// Hydrates the spec from connector_specs by FK lookup so the runner
// receives a self-contained object. State is parsed from state_json.
function getInstallation(db, userId, id) {
  if (!Number.isFinite(userId) || !Number.isFinite(id)) return null;
  const row = db.prepare(`
    SELECT * FROM connector_installations WHERE id = ? AND user_id = ?
  `).get(id, userId);
  if (!row) return null;
  return hydrate(row, db);
}

function getInstallationsForUser(db, userId, { enabledOnly = false, visibility = null } = {}) {
  if (!Number.isFinite(userId)) return [];
  let sql = `SELECT * FROM connector_installations WHERE user_id = ?`;
  const params = [userId];
  if (enabledOnly) sql += ` AND enabled = 1`;
  if (visibility) {
    if (!isValidVisibility(visibility)) return [];
    sql += ` AND visibility = ?`;
    params.push(visibility);
  }
  sql += ` ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => hydrate(r, db));
}

function hydrate(row, db) {
  const spec = getSpec(db, row.spec_id, row.spec_revision);
  let state = {};
  try { state = JSON.parse(row.state_json || '{}'); } catch (_) { state = {}; }
  return {
    id: row.id,
    userId: row.user_id,
    specId: row.spec_id,
    specRevision: row.spec_revision,
    installName: row.install_name,
    baseUrl: row.base_url,
    secretRef: row.secret_ref,
    enabled: !!row.enabled,
    visibility: row.visibility,
    state,
    spec: spec ? spec.spec : null,
    specHash: spec ? spec.specHash : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    moduleKey: `connector:${row.spec_id}`,
  };
}

// uninstall(db, userId, id, opts) -> { ok: true } | { ok: false, reason }
// Hard-removes the installation. By default also removes the secret
// and the user_modules entry. Pass { keepSecret: true } to leave the
// secret in place (user may reinstall later without re-typing it).
function uninstall(db, userId, id, opts = {}) {
  if (!Number.isFinite(userId) || !Number.isFinite(id)) {
    throw new ConnectorInstallError(422, 'invalid_args', 'userId and id are required');
  }
  const keepSecret = !!opts.keepSecret;
  const row = db.prepare(`
    SELECT * FROM connector_installations WHERE id = ? AND user_id = ?
  `).get(id, userId);
  if (!row) {
    throw new ConnectorInstallError(404, 'not_found', `installation ${id} not found for this user`);
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM connector_installations WHERE id = ? AND user_id = ?`).run(id, userId);
    // Remove the per-spec toggle ONLY if no other installation for
    // this user still references this spec. Two Komga installs
    // pointing at different servers share the same toggle — the
    // user opted into the room once, the data is what changes.
    const stillForSpec = db.prepare(`
      SELECT id FROM connector_installations
       WHERE user_id = ? AND spec_id = ?
    `).get(userId, row.spec_id);
    if (!stillForSpec) {
      db.prepare(`DELETE FROM connector_room_toggles WHERE user_id = ? AND spec_id = ?`)
        .run(userId, row.spec_id);
    }
    if (!keepSecret) {
      // Cascade-delete the secret only if nothing else references it.
      const stillRefs = db.prepare(`
        SELECT id FROM connector_installations
         WHERE user_id = ? AND secret_ref = ?
      `).get(userId, row.secret_ref);
      if (!stillRefs) {
        db.prepare(`DELETE FROM connector_secrets WHERE user_id = ? AND secret_ref = ?`)
          .run(userId, row.secret_ref);
      }
    }
  });
  tx();
  return { ok: true };
}

// setEnabled(db, userId, id, enabled) -> updated installation
function setEnabled(db, userId, id, enabled) {
  const row = db.prepare(`
    UPDATE connector_installations SET enabled = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?
  `).run(enabled ? 1 : 0, id, userId);
  if (row.changes === 0) {
    throw new ConnectorInstallError(404, 'not_found', `installation ${id} not found for this user`);
  }
  // Toggle the per-spec room visibility. Mirrors user_model.setUserModule.
  const inst = getInstallation(db, userId, id);
  if (inst) {
    if (enabled) {
      db.prepare(`
        INSERT INTO connector_room_toggles (user_id, spec_id, enabled_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id, spec_id) DO UPDATE SET enabled_at = excluded.enabled_at
      `).run(userId, inst.specId);
    } else {
      db.prepare(`
        INSERT INTO connector_room_toggles (user_id, spec_id, enabled_at)
        VALUES (?, ?, NULL)
        ON CONFLICT(user_id, spec_id) DO UPDATE SET enabled_at = NULL
      `).run(userId, inst.specId);
    }
  }
  return inst;
}

// setVisibility(db, userId, id, visibility) -> updated installation
// 'private' removes any group shares; 'group' honors existing
// tile_visibility_groups rows for this installation.
function setVisibility(db, userId, id, visibility) {
  if (!isValidVisibility(visibility)) {
    throw new ConnectorInstallError(422, 'invalid_visibility', `visibility must be 'private' or 'group' (got "${visibility}")`);
  }
  const row = db.prepare(`
    UPDATE connector_installations SET visibility = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?
  `).run(visibility, id, userId);
  if (row.changes === 0) {
    throw new ConnectorInstallError(404, 'not_found', `installation ${id} not found for this user`);
  }
  return getInstallation(db, userId, id);
}

// writeState(db, userId, id, statePatch) -> updated installation
// Persists the runner's statePatch back to the row. The runner
// already redacted its own error fields; we just JSON-encode and
// update.
function writeState(db, userId, id, statePatch) {
  if (!statePatch || typeof statePatch !== 'object') {
    throw new ConnectorInstallError(422, 'invalid_state', 'statePatch is required');
  }
  // Read-modify-write: we keep the merge simple and overwrite the
  // shape the runner produces (etags, lastSuccess, etc.).
  const current = db.prepare(`
    SELECT state_json FROM connector_installations WHERE id = ? AND user_id = ?
  `).get(id, userId);
  if (!current) {
    throw new ConnectorInstallError(404, 'not_found', `installation ${id} not found for this user`);
  }
  let existing = {};
  try { existing = JSON.parse(current.state_json || '{}'); } catch (_) { existing = {}; }
  const merged = Object.assign({}, existing, statePatch);
  db.prepare(`
    UPDATE connector_installations
       SET state_json = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?
  `).run(JSON.stringify(merged), id, userId);
  return getInstallation(db, userId, id);
}

// ---- Public DTO -----------------------------------------------------------

// publicView(installation) -> JSON-safe shape
// Strips the spec (which the API returns separately via getSpec
// + the specId/specRevision fields) and never carries the secretRef
// plaintext. The runner receives the full object internally; the API
// returns this shape.
function publicView(installation) {
  if (!installation) return null;
  return {
    id: installation.id,
    user_id: installation.userId,
    spec_id: installation.specId,
    spec_revision: installation.specRevision,
    install_name: installation.installName,
    base_url: installation.baseUrl,
    secret_ref: installation.secretRef,           // ref id only, never plaintext
    enabled: !!installation.enabled,
    visibility: installation.visibility,
    state: {
      last_success_at: installation.state && installation.state.lastSuccessAt || null,
      last_attempt_at: installation.state && installation.state.lastAttemptAt || null,
      failure_count: installation.state && Number.isFinite(installation.state.failureCount) ? installation.state.failureCount : 0,
      next_run_at: installation.state && installation.state.nextRunAt || null,
      etag_by_probe: installation.state && installation.state.etagByProbe || {},
      last_error: installation.state && installation.state.lastError || null,
    },
    module_key: installation.moduleKey,
    created_at: installation.createdAt,
    updated_at: installation.updatedAt,
  };
}

// ---- Visibility machinery reuse ------------------------------------------

// shareWithGroup(db, userId, installId, groupId) -> { ok: true }
// Reuses tile_visibility_groups — same shape the existing modules
// use, no parallel table. The renderer joins on
// tile_kind='connector_install'.
function shareWithGroup(db, userId, installId, groupId) {
  if (!Number.isFinite(userId) || !Number.isFinite(installId) || !Number.isFinite(groupId)) {
    throw new ConnectorInstallError(422, 'invalid_args', 'userId, installId, and groupId are required');
  }
  const inst = db.prepare(`
    SELECT id FROM connector_installations WHERE id = ? AND user_id = ?
  `).get(installId, userId);
  if (!inst) {
    throw new ConnectorInstallError(404, 'not_found', `installation ${installId} not found for this user`);
  }
  db.prepare(`
    INSERT OR IGNORE INTO tile_visibility_groups (tile_kind, tile_id, group_id)
    VALUES ('connector_install', ?, ?)
  `).run(installId, groupId);
  // Ensure visibility='group' so renderers honor the share.
  db.prepare(`
    UPDATE connector_installations SET visibility = 'group', updated_at = datetime('now')
     WHERE id = ? AND user_id = ?
  `).run(installId, userId);
  return { ok: true };
}

function unshareFromGroup(db, userId, installId, groupId) {
  db.prepare(`
    DELETE FROM tile_visibility_groups
     WHERE tile_kind = 'connector_install' AND tile_id = ? AND group_id = ?
  `).run(installId, groupId);
  return { ok: true };
}

function visibleInstallationsForUser(db, userId, groupIds) {
  if (!Number.isFinite(userId)) return [];
  // Per-user private + group-shared. The groupIds array is the
  // union of groups the viewer is in; tile_visibility_groups
  // matches any of those groups. The same shape the existing
  // service-tile renderer uses.
  const safeGroups = Array.isArray(groupIds) ? groupIds.filter(Number.isFinite) : [];
  const placeholders = safeGroups.length > 0 ? safeGroups.map(() => '?').join(',') : 'NULL';
  const rows = db.prepare(`
    SELECT ci.* FROM connector_installations ci
     WHERE ci.user_id = ? AND ci.enabled = 1 AND ci.visibility = 'private'
    UNION
    SELECT ci.* FROM connector_installations ci
     JOIN tile_visibility_groups tvg
       ON tvg.tile_kind = 'connector_install' AND tvg.tile_id = ci.id
     WHERE ci.user_id = ? AND ci.enabled = 1 AND ci.visibility = 'group'
       AND tvg.group_id IN (${placeholders})
  `).all(userId, userId, ...safeGroups);
  return rows.map(r => hydrate(r, db));
}

// ---- Module-registry adapter --------------------------------------------
//
// enabledConnectorModules(db, userId) returns the user's ENABLED
// connector installations as registry-shaped entries in a stable
// order (newest install first). The SPA joins this with
// user_model.getEnabledModules() to render the home grid; a
// connector install shows up as a first-class room surface
// (PHA-2446).
//
// Returned shape mirrors lib/modules.js entries so callers can
// render built-ins and connectors through the same code path:
//   { key, name, description, icon, room, requires, tier, version,
//     author, url, open_mode, scopes, mcp, webhooks, entity_kinds,
//     default_enabled, enabled_at }
function enabledConnectorModules(db, userId) {
  if (!Number.isFinite(userId)) return [];
  const rows = db.prepare(`
    SELECT ci.id, ci.spec_id, ci.install_name, ci.enabled, ci.base_url,
           ci.visibility, ci.created_at, ci.updated_at,
           cs.spec_json, cs.spec_id AS persisted_spec_id,
           crt.enabled_at AS room_enabled_at
      FROM connector_installations ci
      JOIN connector_specs cs
        ON cs.spec_id = ci.spec_id AND cs.revision = ci.spec_revision
      LEFT JOIN connector_room_toggles crt
        ON crt.user_id = ci.user_id AND crt.spec_id = ci.spec_id
     WHERE ci.user_id = ? AND ci.enabled = 1
       AND (crt.enabled_at IS NOT NULL)
     ORDER BY ci.created_at DESC
  `).all(userId);
  return rows.map(r => {
    const spec = JSON.parse(r.spec_json);
    const identity = spec.identity || {};
    return {
      key: `connector:${r.spec_id}`,
      name: identity.name || r.install_name || r.spec_id,
      // The room URL is a deterministic route the SPA resolves;
      // the connector frame draws on it. The specific route lives
      // in the PHA-2448 / PHA-2447 surface code; we don't bind the
      // path here so a future tile/card renderer change doesn't
      // strand an installed connector.
      url: `/connector/${encodeURIComponent(r.spec_id)}`,
      description: identity.category ? `${identity.category} connector` : 'connector',
      icon: identity.icon || '🔌',
      room: 'connector',
      requires: [],
      tier: 'user',
      version: '1.0.0',
      author: 'connector-user',
      open_mode: 'frame',
      scopes: ['read:connectors'],
      mcp: false,
      webhooks: [],
      entity_kinds: [],
      default_enabled: false,
      enabled_at: r.room_enabled_at,
      installation_id: r.id,
      base_url: r.base_url,
      visibility: r.visibility,
    };
  });
}

// ---- Public API -----------------------------------------------------------
module.exports = {
  ConnectorInstallError,
  migrate,
  // Spec persistence
  persistSpec,
  getSpec,
  getLatestSpec,
  // Secret store
  setSecret,
  deleteSecret,
  resolveSecret,
  isValidSecretRef,
  // Installations
  install,
  importSharedSpec,
  getInstallation,
  getInstallationsForUser,
  uninstall,
  setEnabled,
  setVisibility,
  writeState,
  // Visibility machinery
  shareWithGroup,
  unshareFromGroup,
  visibleInstallationsForUser,
  // Module registry adapter (PHA-2200 integration)
  enabledConnectorModules,
  // DTO
  publicView,
};
