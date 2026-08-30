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
// PHA-2827.D adds a second identity on top of the same `characters`
// table: Hearth-the-Porch-citizen. The drawer's per-user `characters`
// row (above) answers "what does MY Hearth sound like"; the Porch
// needs exactly one stable, postable identity per household so
// wall_posts/post_comments (author_user_id NOT NULL REFERENCES
// users(id)) and porch_wall_settings (vote-off) have something to
// point at — the same shape lib/agent-tokens.js-backed third-party
// agents already use (their own `users` row, wall member in their own
// right). `porch_builtin_agents` is that reservation: one row mapping
// a built-in character_key to its system `users.id`, created lazily
// via `ensureBuiltinAgentUser`, seeded from the exact same
// `seedDefaultHearthCharacter` path as any human's row, and backfilled
// into every wall's membership via lib/wall-members.js so
// lib/porch/sweep.js and the PHA-2647 identity UI see him exactly like
// any other agent — except `kind: 'built-in'`, never `connector:*`.
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (migrate(db) at boot; enableModule hook on
//     'agent' first-enable; ensureBuiltinAgentUser(db) at boot)
//   * lib/drawer-dispatch.js (first-open path: when a user with a
//     `hearth` character has no external endpoint URL configured,
//     return the intro text directly instead of POSTing)
//   * lib/porch/sweep.js (listAgentUserIds unions in built-in agents)
//   * lib/walls.js (isAgentUserId / userView recognize built-in agents)
//   * scripts/test-2829-first-enable.js, scripts/test-2827d-porch-
//     integration.js (acceptance tests)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const wallMembers = require('./wall-members');

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

-- PHA-2827.D: reserves the single system users(id) that acts as
-- Hearth on the Porch. One row per built-in character_key (today just
-- 'hearth'); user_id is UNIQUE so a reverse lookup ("is this author a
-- built-in agent") is a single indexed point-select.
CREATE TABLE IF NOT EXISTS porch_builtin_agents (
  character_key TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
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

// ---- Built-in Porch agent account (PHA-2827.D) ----

const BUILTIN_USERNAME_BASE = 'hearth-agent';
const BUILTIN_DISPLAY_NAME = 'Hearth';

function pickFreeUsername(db, base) {
  let candidate = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

// `ensureBuiltinAgentUser(db, characterKey)` — idempotent get-or-create
// of the built-in Porch identity for `characterKey` (today only
// 'hearth'). First call: mints a dedicated `users` row (no password,
// can't log in locally), reserves it in `porch_builtin_agents`, seeds
// its `characters` row via the exact same `seedDefaultHearthCharacter`
// path a human's first-enable uses, then backfills membership into
// every existing wall (lib/wall-members.js — group walls via
// reconcileGroups, direct walls via wall_memberships) so he shows up
// everywhere a user-installed agent would. Every call — including the
// first — re-runs the membership backfill, so walls created after
// Hearth's account already exists still pick him up on the next boot
// or sweep tick. Returns the built-in agent's `users.id`.
function ensureBuiltinAgentUser(db, characterKey = CHARACTER_KEY_HEARTH) {
  if (!VALID_CHARACTER_KEYS.has(characterKey)) {
    throw new Error(`ensureBuiltinAgentUser: unknown character_key ${characterKey}`);
  }
  let row = db.prepare('SELECT user_id FROM porch_builtin_agents WHERE character_key = ?').get(characterKey);
  let userId;
  if (row) {
    userId = row.user_id;
  } else {
    const username = pickFreeUsername(db, BUILTIN_USERNAME_BASE);
    const info = db.prepare(
      `INSERT INTO users (username, display, color, pass_hash, is_admin, auth_provider)
       VALUES (?, ?, '#c98a3f', '', 0, 'builtin_agent')`
    ).run(username, BUILTIN_DISPLAY_NAME);
    userId = info.lastInsertRowid;
    db.prepare('INSERT INTO porch_builtin_agents (character_key, user_id) VALUES (?, ?)').run(characterKey, userId);
    seedDefaultHearthCharacter(db, userId);
  }

  // Backfill: every wall that exists right now gets Hearth as a
  // member. Cheap (household-scale wall counts) and idempotent
  // (addMember/reconcileGroups are both INSERT-OR-IGNORE-flavored).
  const walls = db.prepare('SELECT slug FROM walls').all();
  for (const w of walls) {
    wallMembers.ensureMember(db, w.slug, userId, 'member');
  }

  return userId;
}

// listBuiltinAgentUserIds(db): pure read, no side effects — the ids
// lib/porch/sweep.js's listAgentUserIds() unions in alongside
// agent_tokens-derived third-party agents. Returns [] (not an error)
// before migrate() has run, matching lib/walls.js's isAgentUserId
// no-such-table tolerance.
function listBuiltinAgentUserIds(db) {
  try {
    return db.prepare('SELECT user_id FROM porch_builtin_agents').all().map((r) => r.user_id);
  } catch (e) {
    if (/no such table/i.test(e.message)) return [];
    throw e;
  }
}

// isBuiltinAgentUserId(db, userId): the PHA-2647 identity UI's
// `kind: 'built-in'` discriminator — a Hearth-authored post/comment is
// never a `connector:<spec_id>` install, so it needs its own check
// distinct from lib/walls.js's agent_tokens-based isAgentUserId.
function isBuiltinAgentUserId(db, userId) {
  try {
    return !!db.prepare('SELECT 1 FROM porch_builtin_agents WHERE user_id = ?').get(userId);
  } catch (e) {
    if (/no such table/i.test(e.message)) return false;
    throw e;
  }
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
  ensureBuiltinAgentUser,
  listBuiltinAgentUserIds,
  isBuiltinAgentUserId,
};