// Homestead — Hearth character seed + lookup (PHA-2827.B / PHA-2829).
//
// One row per (user, character). The default character is `hearth` —
// sourced from the canonical personality file at `agents/hearth/SOUL.md`
// and `agents/hearth/IDENTITY.md` (PHA-2828). When a user enables the
// Agent module for the first time and has no character row, this
// module seeds a `hearth` row from those files and records the source
// SHA so future edits can be reconciled.
//
// Per-user edits are allowed (a household can tune Hearth); the repo
// canon stays the default. There is no global table of register
// weights — the participation contract (lib/porch/participation-
// contract.js) reads register weights from the per-user row directly.
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (migrate(db) at boot; enableModule hook on
//     'agent' first-enable)
//   * lib/drawer-dispatch.js (first-open path: when a user with a
//     `hearth` character has no external endpoint URL configured,
//     return the intro text directly instead of POSTing)
//   * scripts/test-2829-first-enable.js (acceptance tests)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHARACTER_KEY_HEARTH = 'hearth';

const VALID_CHARACTER_KEYS = new Set([CHARACTER_KEY_HEARTH]);

const AGENTS_DIR = path.join(__dirname, '..', 'agents', 'hearth');

const SOUL_FILENAME = 'SOUL.md';
const IDENTITY_FILENAME = 'IDENTITY.md';

const SEED_DEFAULT_REGISTERS = Object.freeze({
  // PHA-2827.D will read these into lib/porch/participation-contract.js's
  // register-weights draw. Defaults come from Hearth's voice — warm,
  // specific, never engagement-slop. Numeric weights are relative;
  // zero disables a register.
  roast: 0,
  riff: 2,
  callback: 3,
  sincere_question: 4,
  lore_reference: 1,
  plain_emoji: 2,
});

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS characters (
  id                    INTEGER PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_key         TEXT NOT NULL CHECK(character_key IN ('hearth')),
  is_default            INTEGER NOT NULL DEFAULT 0,
  intro_source_sha      TEXT NOT NULL DEFAULT '',
  soul_source_sha       TEXT NOT NULL DEFAULT '',
  identity_source_sha   TEXT NOT NULL DEFAULT '',
  register_weights_json TEXT NOT NULL DEFAULT '{}',
  intro_text            TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, character_key)
);
CREATE INDEX IF NOT EXISTS idx_characters_user_default
  ON characters(user_id, is_default);
`);
}

// Cheap file SHA (no streaming — these files are < 10 KB and read once
// per first-enable; not a hot path). Returns the hex digest.
function shaFile(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

// Reads the SOUL.md / IDENTITY.md source-of-truth files from disk and
// returns the seed payload. Pure data — caller decides what to write
// to the DB.
function loadHearthCanon() {
  const soulPath = path.join(AGENTS_DIR, SOUL_FILENAME);
  const identityPath = path.join(AGENTS_DIR, IDENTITY_FILENAME);
  return {
    soul_path: soulPath,
    identity_path: identityPath,
    soul_sha: shaFile(soulPath),
    identity_sha: shaFile(identityPath),
    register_weights: { ...SEED_DEFAULT_REGISTERS },
  };
}

// Stable intro text. Sourced from IDENTITY.md's "How I Do" section.
// Kept here (not generated dynamically) so the same string ships in
// tests and runtime — easier to assert on.
const HEARTH_INTRO_TEXT =
  "Hi — I'm Hearth. I'm the lamp by the door of this house. " +
  "When you have a question that crosses rooms (calendar plus chores, " +
  "lists plus the porch), ask me. When you want quiet, you'll get quiet. " +
  "Ask me anything to get started.";

// `seedDefaultHearthCharacter(db, userId)` — idempotent. If the user
// already has a `hearth` row, leave it alone (per-user edits win over
// repo canon — the source SHAs are recorded so a future "resync from
// repo" pass could diff and merge). If not, create one.
function seedDefaultHearthCharacter(db, userId, opts = {}) {
  if (!Number.isInteger(userId)) {
    throw new Error(`seedDefaultHearthCharacter: userId must be integer, got ${userId}`);
  }
  const existing = getCharacter(db, userId, CHARACTER_KEY_HEARTH);
  if (existing) return existing;
  const canon = loadHearthCanon();
  const introText = opts.introText || HEARTH_INTRO_TEXT;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    `INSERT INTO characters
       (user_id, character_key, is_default,
        intro_source_sha, soul_source_sha, identity_source_sha,
        register_weights_json, intro_text, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    CHARACTER_KEY_HEARTH,
    canon.identity_sha, // intro source — derived from IDENTITY.md
    canon.soul_sha,
    canon.identity_sha,
    JSON.stringify(canon.register_weights),
    introText,
    now,
    now
  );
  return getCharacter(db, userId, CHARACTER_KEY_HEARTH);
}

function getCharacter(db, userId, characterKey) {
  if (!VALID_CHARACTER_KEYS.has(characterKey)) return null;
  return db.prepare(
    `SELECT id, user_id, character_key, is_default,
            intro_source_sha, soul_source_sha, identity_source_sha,
            register_weights_json, intro_text, created_at, updated_at
       FROM characters
      WHERE user_id = ? AND character_key = ?`
  ).get(userId, characterKey) || null;
}

function getDefaultCharacter(db, userId) {
  return db.prepare(
    `SELECT id, user_id, character_key, is_default,
            intro_source_sha, soul_source_sha, identity_source_sha,
            register_weights_json, intro_text, created_at, updated_at
       FROM characters
      WHERE user_id = ? AND is_default = 1
      ORDER BY id ASC LIMIT 1`
  ).get(userId) || null;
}

function listCharacters(db, userId) {
  return db.prepare(
    `SELECT id, user_id, character_key, is_default,
            intro_source_sha, soul_source_sha, identity_source_sha,
            register_weights_json, intro_text, created_at, updated_at
       FROM characters
      WHERE user_id = ?
      ORDER BY is_default DESC, id ASC`
  ).all(userId);
}

function parseRegisterWeights(row) {
  if (!row || !row.register_weights_json) return null;
  try {
    return JSON.parse(row.register_weights_json);
  } catch (err) {
    return null;
  }
}

module.exports = {
  CHARACTER_KEY_HEARTH,
  VALID_CHARACTER_KEYS,
  HEARTH_INTRO_TEXT,
  SEED_DEFAULT_REGISTERS,
  migrate,
  loadHearthCanon,
  seedDefaultHearthCharacter,
  getCharacter,
  getDefaultCharacter,
  listCharacters,
  parseRegisterWeights,
};