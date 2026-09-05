// Registry validator (PHA-2203 / PHA-2200.2, v0.3.0).
//
// Runtime sanity check that the `lib/modules.js` registry cannot drift
// away from:
//   1. The SQLite CHECK constraint on `user_modules.module_key`.
//   2. The PHA-2201 manifest contract (field names + types that
//      third-party apps also conform to).
//   3. Its own internal consistency (every `requires[]` ref points
//      to a registered key; DEFAULT_ENABLED references are valid;
//      no duplicate keys; required fields all present).
//
// Call from boot (server.js) or from the test suite. Throws an
// `Error` with a single human-readable message on the first
// failure — fail-fast because a drifted registry silently breaking
// runtime module toggles is exactly the class of bug this check
// exists to prevent.

'use strict';

const modules = require('./modules');

// Manifest contract (PHA-2201). These are the 16 fields every
// registry entry MUST have. Types are strict — the `default_enabled`
// boolean and `requires`/`scopes`/`webhooks`/`entity_kinds` arrays
// each have a canonical element shape and we reject anything else.
//
// `requires` elements are strings (registered keys).
// `scopes` / `webhooks` / `entity_kinds` elements are strings.
// `room` is string|null. `url` is string|null.
const REQUIRED_FIELDS = Object.freeze([
  'key', 'name', 'description', 'icon', 'room', 'requires', 'tier',
  'version', 'author', 'url', 'open_mode', 'scopes', 'mcp',
  'webhooks', 'entity_kinds', 'default_enabled',
]);

// Optional fields (PHA-2852). NOT part of REQUIRED_FIELDS — the
// 16-field manifest contract is a published promise third-party apps
// already ship against, so new capabilities are declared additively:
// absent means "this module has none of that", never "invalid entry".
// When present, the type rules are as strict as the required ones.
//
// `room_kinds` declares that records owned by this module can be keyed
// to a location in the house (lib/house-rooms.js). Distinct from the
// required `room` field, which is the in-SPA nav discriminator.
const VALID_ROOM_KINDS = Object.freeze(['house_room']);
const OPTIONAL_ARRAY_OF_STRING_FIELDS = Object.freeze(['room_kinds']);

const STRING_FIELDS = Object.freeze([
  'key', 'name', 'description', 'icon', 'tier', 'version', 'author', 'open_mode',
]);
const NULLABLE_STRING_FIELDS = Object.freeze(['room', 'url']);
const ARRAY_OF_STRING_FIELDS = Object.freeze(['requires', 'scopes', 'webhooks', 'entity_kinds']);
const BOOLEAN_FIELDS = Object.freeze(['mcp', 'default_enabled']);

// PHA-2659 added 'sheet': a full-screen, non-nav surface opened on
// demand from a launcher (the Gazette). Unlike 'frame' it has no `url`
// and claims no nav room; unlike 'drawer' it isn't the chat harness;
// unlike 'tab' it isn't an external window.
const VALID_OPEN_MODES = Object.freeze(['frame', 'drawer', 'tab', 'sheet']);
const VALID_TIERS = Object.freeze(['core', 'advanced']);

// Semver-ish: digits.digits.digits. Loose on purpose — Homestead
// doesn't enforce strict semver at the registry layer, but rejects
// obvious garbage (empty / non-numeric).
const SEMVER_LIKE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;

// Read the live CHECK constraint from the `user_modules` table. We
// parse the column CHECK clause via sqlite_master; the constraint
// lives as a string like:
//   module_key IN ('wall','lists','calendar','chores','apps','agent')
// …extracted with a permissive regex. Falls back to scanning the
// column with `PRAGMA table_info` if the regex misses (e.g. some
// other constraint style), then complains loudly.
function readCheckKeysFromDb(db) {
  // 1. Try sqlite_master CREATE TABLE text.
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='user_modules'`
  ).get();
  if (!row || !row.sql) {
    throw new Error('user_modules table not found — cannot read CHECK constraint for registry validation');
  }
  const sql = row.sql;
  // Pull the CHECK clause that mentions module_key. The CREATE TABLE
  // for user_modules looks like:
  //   ... module_key TEXT NOT NULL CHECK (module_key IN ('a','b')) ...
  // We grab the longest balanced parens run after `module_key` —
  // good enough for the canonical schema in lib/user-model.js.
  const m = sql.match(/module_key[^()]*\(([^()]*)\)/i);
  if (!m) {
    throw new Error(`could not parse module_key CHECK clause from user_modules CREATE TABLE: ${sql}`);
  }
  const inner = m[1];
  const keys = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = re.exec(inner)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

// Validate a single registry entry against the manifest contract.
// Returns null on success, or an Error describing the first failure.
function validateEntryShape(entry) {
  if (!entry || typeof entry !== 'object') {
    return new Error('registry entry must be an object');
  }
  for (const f of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, f)) {
      return new Error(`entry ${JSON.stringify(entry.key || '<unknown>')} is missing required field "${f}"`);
    }
  }
  for (const f of STRING_FIELDS) {
    if (typeof entry[f] !== 'string' || entry[f].length === 0) {
      return new Error(`entry "${entry.key}" field "${f}" must be a non-empty string (got ${typeof entry[f]})`);
    }
  }
  for (const f of NULLABLE_STRING_FIELDS) {
    if (entry[f] !== null && (typeof entry[f] !== 'string' || entry[f].length === 0)) {
      return new Error(`entry "${entry.key}" field "${f}" must be a string or null (got ${typeof entry[f]})`);
    }
  }
  for (const f of ARRAY_OF_STRING_FIELDS) {
    if (!Array.isArray(entry[f])) {
      return new Error(`entry "${entry.key}" field "${f}" must be an array (got ${typeof entry[f]})`);
    }
    for (const i in entry[f]) {
      if (typeof entry[f][i] !== 'string') {
        return new Error(`entry "${entry.key}" field "${f}"[${i}] must be a string (got ${typeof entry[f][i]})`);
      }
    }
  }
  // Optional arrays: skipped entirely when absent, strictly typed when
  // present. An unrecognized room kind is an error rather than a
  // silent no-op — a typo'd 'house-room' would otherwise make a
  // module's room picker quietly never appear.
  for (const f of OPTIONAL_ARRAY_OF_STRING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, f)) continue;
    if (!Array.isArray(entry[f])) {
      return new Error(`entry "${entry.key}" optional field "${f}" must be an array when present (got ${typeof entry[f]})`);
    }
    for (const i in entry[f]) {
      if (typeof entry[f][i] !== 'string') {
        return new Error(`entry "${entry.key}" field "${f}"[${i}] must be a string (got ${typeof entry[f][i]})`);
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'room_kinds')) {
    for (const kind of entry.room_kinds) {
      if (!VALID_ROOM_KINDS.includes(kind)) {
        return new Error(`entry "${entry.key}" field "room_kinds" has unknown kind "${kind}" — must be one of [${VALID_ROOM_KINDS.join(', ')}]`);
      }
    }
  }
  for (const f of BOOLEAN_FIELDS) {
    if (typeof entry[f] !== 'boolean') {
      return new Error(`entry "${entry.key}" field "${f}" must be a boolean (got ${typeof entry[f]})`);
    }
  }
  if (!VALID_OPEN_MODES.includes(entry.open_mode)) {
    return new Error(`entry "${entry.key}" field "open_mode" must be one of [${VALID_OPEN_MODES.join(', ')}] (got "${entry.open_mode}")`);
  }
  if (!VALID_TIERS.includes(entry.tier)) {
    return new Error(`entry "${entry.key}" field "tier" must be one of [${VALID_TIERS.join(', ')}] (got "${entry.tier}")`);
  }
  if (!SEMVER_LIKE.test(entry.version)) {
    return new Error(`entry "${entry.key}" field "version" must be semver-like (digits.digits.digits) (got "${entry.version}")`);
  }
  if (entry.key !== entry.key.toLowerCase() || !/^[a-z0-9_-]{2,32}$/.test(entry.key)) {
    return new Error(`entry key "${entry.key}" must be lowercase kebab/snake, 2-32 chars matching [a-z0-9_-]`);
  }
  // Cross-field sanity: frame mode modules should have a non-null url.
  if (entry.open_mode === 'frame' && entry.url === null) {
    return new Error(`entry "${entry.key}" open_mode "frame" requires non-null url (got null)`);
  }
  return null;
}

// `validateRegistry` is the public entry point. Returns null on
// success, or an Error describing the first drift detected.
//
// `db` is the live Homestead better-sqlite3 instance (read-only —
// we only inspect sqlite_master). Pass null to skip the CHECK
// constraint verification (useful for testing the manifest shape in
// isolation, e.g. on a registry-only fixture).
function validateRegistry(db) {
  const registry = modules.REGISTRY;

  // 1. No duplicate keys (sanity — JS objects already enforce this,
  //    but a bad merge from PHA-2201 could overwrite silently).
  const keys = Object.keys(registry);
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) {
      return new Error(`duplicate registry key "${k}" — registry merge collision`);
    }
    seen.add(k);
  }

  // 2. Every entry passes the PHA-2201 manifest shape check.
  for (const key of keys) {
    const entry = registry[key];
    const shapeErr = validateEntryShape(entry);
    if (shapeErr) return shapeErr;
    // The entry's `key` field MUST equal its registry key.
    if (entry.key !== key) {
      return new Error(`entry at registry key "${key}" has mismatched key field "${entry.key}"`);
    }
  }

  // 3. Every `requires[]` reference points to a registered key.
  for (const key of keys) {
    for (const req of registry[key].requires) {
      if (!Object.prototype.hasOwnProperty.call(registry, req)) {
        return new Error(`entry "${key}" requires unknown key "${req}" — must point to a registered module`);
      }
    }
  }

  // 4. DEFAULT_ENABLED references are valid registered keys.
  for (const def of modules.DEFAULT_ENABLED) {
    if (!Object.prototype.hasOwnProperty.call(registry, def)) {
      return new Error(`DEFAULT_ENABLED references unknown key "${def}" — must be a registered module`);
    }
  }

  // 5. Registry keys ⊆ user_modules CHECK constraint.
  if (db !== null && db !== undefined) {
    const checkKeys = readCheckKeysFromDb(db);
    const checkSet = new Set(checkKeys);
    for (const key of keys) {
      if (!checkSet.has(key)) {
        return new Error(`registry key "${key}" is missing from user_modules CHECK constraint — DB drift. CHECK allows: [${checkKeys.join(', ')}]`);
      }
    }
    // (Reverse check is informational, not strict: the DB may carry
    // legacy keys we want to allow disabling. But in v0.3.0 we
    // expect parity, so warn — don't error — if CHECK has extras.)
    if (checkKeys.length !== keys.length) {
      // Use a non-throwing warning instead of erroring — see note
      // above. Returned via the warning channel so callers can log
      // it but boot continues.
      const msg = `user_modules CHECK constraint has ${checkKeys.length} keys but registry has ${keys.length} — these may be legacy allow-listed keys (${checkKeys.filter(k => !seen.has(k)).join(', ')})`;
      // Stash a warning on the global so callers can inspect after
      // a successful validation pass. We don't want this to throw
      // — legacy keys are intentional for downgrade safety.
      if (!validateRegistry._warnings) validateRegistry._warnings = [];
      validateRegistry._warnings.push(msg);
    }
  }

  return null;
}

// `validateAndThrow` is the boot-time convenience: validates and
// throws if anything is wrong. Use from server.js after migrate(db).
function validateAndThrow(db) {
  const err = validateRegistry(db);
  if (err) {
    const warnings = validateRegistry._warnings || [];
    const suffix = warnings.length ? `\n  warnings: ${warnings.join('; ')}` : '';
    throw new Error(`registry validation failed: ${err.message}${suffix}`);
  }
}

// `getWarnings` returns any non-fatal warnings from the last
// validateRegistry call (e.g. CHECK has legacy keys).
function getWarnings() {
  return (validateRegistry._warnings || []).slice();
}

module.exports = {
  validateRegistry,
  validateAndThrow,
  getWarnings,
  readCheckKeysFromDb,
  validateEntryShape,
  REQUIRED_FIELDS,
  OPTIONAL_ARRAY_OF_STRING_FIELDS,
  VALID_ROOM_KINDS,
};