// Homestead — at-rest encryption for calendar provider credentials.
//
// #1620: "No provider credentials ever reach the browser."
// CalDAV app-passwords and Graph/Google OAuth refresh tokens are stored
// as AES-256-GCM ciphertexts keyed on process.env.CALENDAR_CRED_KEY
// (32 bytes, hex). The same key is required for decrypt, so rotating
// it requires a re-encryption pass over the calendar_sources table —
// that's a known operational footgun, documented in the issue.
//
// Format on disk: <iv_b64>:<tag_b64>:<ciphertext_b64>, all standard
// base64, separated by ':'. We keep the format trivially parseable so
// a future rotation helper can re-encrypt in place without changing
// the on-disk layout.
//
// Fail-closed: if CALENDAR_CRED_KEY is missing or the wrong length, any
// encrypt/decrypt call throws. There is no "auto-generate and persist"
// path on purpose — we'd rather refuse to start than silently ship
// unencrypted credentials.

// #3205: the same envelope now covers the agent HMAC secrets —
// `agent_connections.secret` (companion signing key) and
// `agent_endpoints.secret` (drawer / events-webhook HMAC). Those two are
// symmetric-HMAC shared secrets, so the process still recomputes the
// digest in memory to verify a signature; what changes is that a stolen
// `life.db` is no longer the keyring. Same AES-256-GCM construction,
// same on-disk format, same fail-closed posture — see `sealSecret` /
// `openSecret` / `encryptSecretColumn` below.
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;       // GCM standard
const TAG_BYTES = 16;
const KEY_BYTES = 32;      // AES-256

// #3200: SESSION_SECRET must be a real random string. The previous
// behaviour (`process.env.SESSION_SECRET || 'life-app-secret-change-me'`)
// meant a misconfigured box signed cookies with a public, repo-readable
// string — anyone could forge a session for `admin`. Fail-closed is the
// same posture we take for CALENDAR_CRED_KEY: refuse to start, tell the
// operator exactly what to do (`openssl rand -hex 32`), do not silently
// fall back to a placeholder. Tests and CI inject a valid secret via
// `scripts/_test-bootstrap.js` (loaded with `node --require` in npm test).
const SESSION_SECRET_MIN = 32;
const SESSION_SECRET_PLACEHOLDERS = new Set([
  'life-app-secret-change-me',
  'change-this-to-something-long-and-random',
  'changeme',
  'CHANGEME',
  'REPLACE_ME',
  'replace-me',
]);

// Every refusal names where the value lives, not just how to generate one.
// A crash-looping container on first boot (or after an upgrade that kept an
// old template value) otherwise leaves the operator guessing which knob to turn.
const SESSION_SECRET_WHERE =
  ' Set SESSION_SECRET in the Unraid container template (Docker tab → ' +
  'homestead → Edit) or in docker-compose.yml, then restart the container.';

function loadSessionSecret() {
  const raw = process.env.SESSION_SECRET;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      'SESSION_SECRET is not set. Homestead refuses to sign session cookies ' +
      'without one. Generate one with: `openssl rand -hex 32`.' +
      SESSION_SECRET_WHERE
    );
  }
  if (SESSION_SECRET_PLACEHOLDERS.has(raw)) {
    throw new Error(
      `SESSION_SECRET is set to a known placeholder ("${raw}"). This is the ` +
      'public default from a README; anyone can forge sessions with it. ' +
      'Replace it with a real random string: `openssl rand -hex 32`.' +
      SESSION_SECRET_WHERE
    );
  }
  if (raw.length < SESSION_SECRET_MIN) {
    throw new Error(
      `SESSION_SECRET is too short (${raw.length} chars; minimum ` +
      `${SESSION_SECRET_MIN}). A short secret is brute-forceable. Generate ` +
      'a real one with: `openssl rand -hex 32`.' +
      SESSION_SECRET_WHERE
    );
  }
  return raw;
}

function sessionSecretReady() {
  try { loadSessionSecret(); return true; } catch (_) { return false; }
}

// Loads a 32-byte hex key from `envName`, with the same fail-closed
// voice for every caller. Extracted from the original `loadKey()` so
// #3205's HMAC key path reuses one implementation instead of
// growing a near-copy.
function loadKeyFromEnv(envName) {
  const hex = process.env[envName];
  if (!hex) {
    throw new Error(
      `${envName} is not set. Homestead refuses to encrypt or ` +
      'decrypt calendar credentials without a 32-byte hex key. Generate one ' +
      'with: `openssl rand -hex 32` and inject it via your secret manager.'
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `${envName} must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes). ` +
      `Got ${hex.length} characters.`
    );
  }
  return Buffer.from(hex, 'hex');
}

// The calendar path is the original one; #3205 reuses it via
// `loadHmacKey()` rather than growing a near-copy.
function loadKey() {
  return loadKeyFromEnv('CALENDAR_CRED_KEY');
}

// encryptString(plaintext) -> string in <iv>:<tag>:<ciphertext> base64 form.
function encryptString(plaintext) {
  return encryptWithKey(loadKey(), plaintext);
}

// decryptString(stored) -> plaintext string.
// Throws on any tampering (GCM auth tag mismatch) or malformed input.
function decryptString(stored) {
  // Fail-closed: check the key BEFORE we look at the stored value so
  // a missing env var surfaces as the actual cause, not a "bad IV
  // length" downstream noise.
  const key = loadKey();
  return decryptWithKey(key, stored, 'decryptString');
}

function encryptWithKey(key, plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptString expects a string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error('unexpected GCM tag length: ' + tag.length);
  }
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decryptWithKey(key, stored, label = 'decryptString') {
  if (typeof stored !== 'string' || !stored.includes(':')) {
    throw new Error(`${label}: stored value is not in <iv>:<tag>:<ciphertext> form`);
  }
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error(`${label}: expected exactly 3 colon-separated parts`);
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error(`${label}: bad IV length`);
  if (tag.length !== TAG_BYTES) throw new Error(`${label}: bad tag length`);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// #3205 — agent HMAC secrets at rest
// ---------------------------------------------------------------------------

// `HMAC_CRED_KEY` when set, otherwise `CALENDAR_CRED_KEY`. Falling back
// is deliberate: a single-key install must keep working without an
// Unraid template edit, and the calendar path already carries this exact
// key in the same process. Operators who want the two domains on
// different keys set HMAC_CRED_KEY and get them.
//
// A *malformed* HMAC_CRED_KEY never falls through — it throws. Failing
// back to a working key would silently keep writing under the old key
// after a typo, which is exactly the "it looked configured" bug class
// this module exists to prevent.
function loadHmacKey() {
  if (process.env.HMAC_CRED_KEY) return loadKeyFromEnv('HMAC_CRED_KEY');
  if (process.env.CALENDAR_CRED_KEY) return loadKeyFromEnv('CALENDAR_CRED_KEY');
  throw new Error(
    'HMAC_CRED_KEY is not set (and CALENDAR_CRED_KEY is not set either). ' +
    'Homestead refuses to store agent HMAC secrets in plaintext. Generate ' +
    'one with: `openssl rand -hex 32` and inject it via your secret manager.'
  );
}

function hmacKeyReady() {
  try { loadHmacKey(); return true; } catch (_) { return false; }
}

// True only for a well-formed `<iv>:<tag>:<ciphertext>` envelope. The
// decoded byte lengths are part of the test on purpose: it keeps a
// plaintext secret from ever being misread as ciphertext (and vice
// versa) if someone ever changes the secret format. Plaintext HMAC
// secrets are `homestead_aes_<43>` / `homestead_conn_<43>` — base64url,
// no colons — so they cannot collide.
function isEnvelope(stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  if (parts.some(p => p.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p))) return false;
  return Buffer.from(parts[0], 'base64').length === IV_BYTES
      && Buffer.from(parts[1], 'base64').length === TAG_BYTES
      && Buffer.from(parts[2], 'base64').length >= 1;
}

// sealSecret(plaintext) -> envelope string. Fail-closed on a missing key.
function sealSecret(plaintext) {
  return encryptWithKey(loadHmacKey(), plaintext);
}

// openSecret(stored) -> plaintext, from an envelope OR from a legacy
// plaintext row. The dual-read is the one-release rollback window the
// issue asks for: a container rolled back to the previous image must
// still be able to verify signatures against rows this release wrote.
//
// After that window closes, flip LEGACY_PLAINTEXT_READ to false and
// `openSecret` becomes envelope-only.
const LEGACY_PLAINTEXT_READ = true;

function openSecret(stored) {
  // Fail-closed first, same reason as decryptString: a missing key must
  // surface as the actual cause, not as a downstream parse error.
  const key = loadHmacKey();
  if (!isEnvelope(stored)) {
    if (!LEGACY_PLAINTEXT_READ) {
      throw new Error('openSecret: stored value is not an encrypted envelope');
    }
    return stored;
  }
  return decryptWithKey(key, stored, 'openSecret');
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Boot migration: encrypt every plaintext `column` in `table` in place,
// inside one transaction, idempotently. Rows already in envelope form
// are left alone, so running it on every boot costs one SELECT.
//
// If the key is missing we skip rather than throw: a box that has never
// had a cred key would otherwise be unable to boot at all, and the
// read/write paths already fail closed on their own. Health reports
// `hmacSecretsEncrypted: false` so the gap is visible.
//
// `table` / `column` / `idColumn` are code-controlled constants, but
// they're interpolated into SQL, so they're identifier-checked anyway.
function encryptSecretColumn(db, { table, column = 'secret', idColumn = 'id' } = {}) {
  for (const [label, name] of [['table', table], ['column', column], ['idColumn', idColumn]]) {
    if (!IDENTIFIER_PATTERN.test(String(name || ''))) {
      throw new TypeError(`encryptSecretColumn: ${label} is not a plain SQL identifier`);
    }
  }
  if (!hmacKeyReady()) {
    return { scanned: 0, migrated: 0, skipped: 'no-hmac-key' };
  }
  const rows = db
    .prepare(`SELECT ${idColumn} AS id, ${column} AS secret FROM ${table}
        WHERE ${column} IS NOT NULL AND ${column} <> ''`)
    .all();
  const pending = rows.filter(r => !isEnvelope(r.secret));
  if (pending.length === 0) {
    return { scanned: rows.length, migrated: 0, skipped: null };
  }
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`);
  const sealAll = db.transaction((list) => {
    for (const row of list) update.run(sealSecret(row.secret), row.id);
    return list.length;
  });
  return { scanned: rows.length, migrated: sealAll(pending), skipped: null };
}

// keyReady() is a startup-time probe so server boot can fail loudly if
// the env var is missing. Called from server.js before opening the
// calendar-sources routes — those routes are useless without a key.
function keyReady() {
  try { loadKey(); return true; } catch (_) { return false; }
}

module.exports = {
  encryptString,
  decryptString,
  keyReady,
  // #3205
  loadHmacKey,
  hmacKeyReady,
  isEnvelope,
  sealSecret,
  openSecret,
  encryptSecretColumn,
  LEGACY_PLAINTEXT_READ,
  KEY_BYTES,
  IV_BYTES,
  TAG_BYTES,
  // #3200
  loadSessionSecret,
  sessionSecretReady,
  SESSION_SECRET_MIN,
  SESSION_SECRET_PLACEHOLDERS,
};
