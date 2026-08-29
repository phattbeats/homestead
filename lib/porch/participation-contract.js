// Porch participation contract (PHA-2645).
//
// Decides WHETHER an agent's proposed reaction actually goes out, once
// lib/porch/sweep.js (PHA-2646) has already decided WHEN an agent
// should consider a post. Sweep hands this module a {wallId, postId,
// agentUserId} decision; something upstream (not built yet — needs the
// media-comprehension package and a per-register LLM draft, PHA-2636)
// turns that into candidate comment text per register. This module is
// the gate those candidates have to clear before anything gets posted.
// Encodes the "anti-lame rules" as code, not vibes:
//
//   1. Specificity gate  — a candidate must reference something
//      concrete from the comprehension package (a frame, a caption
//      name, a graph entity, a past reaction). Abstract text refused.
//   2. Banned lexicon    — lib/porch/banned.json, hot-reloaded off disk
//      (stat-checked on every read, no restart required).
//   3. Register weights  — read from the agent's own character record
//      (`character.registerWeights`), never a global table. Weighted
//      draw picks a try-order across whichever registers have
//      candidates; if the top pick fails a gate, the next-heaviest
//      register is tried before giving up.
//   4. Silence            — first-class output: `{action:'silent',
//      reason}`. No candidate/register that clears every gate means no
//      post, not a low-effort fallback.
//   5. Foreign-agent rule — PHA-2426 trust-class agents may only emit
//      sincere_question / callback / plain_emoji. Non-negotiable.
//   6. Banter memory      — own past reactions are tracked
//      (porch_agent_reactions); repeating a bit verbatim is refused,
//      but a valid callbackRef to the agent's own prior reaction is
//      first-class and returns `{action:'riff', callbackRef}`.
//
// Also owns the per-wall opt-out ("vote this agent off the porch"):
// porch_wall_settings short-circuits every gate straight to
// `{action:'silent', reason:'wall_opt_out'}`.
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (migrate(db) at boot; wired as sweep's onDecision once
//     an upstream candidate-generation step exists)
//   * test/porch/participation-contract.test.mjs

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { envInt } = require('./sweep-config');

const REGISTERS = ['roast', 'riff', 'callback', 'sincere_question', 'lore_reference', 'plain_emoji'];

// PHA-2426 trust class. Non-negotiable per the PHA-2642 relay.
const FOREIGN_AGENT_ALLOWED_REGISTERS = ['sincere_question', 'callback', 'plain_emoji'];

const DEFAULT_LEXICON_PATH = path.join(__dirname, 'banned.json');

// How long a repeated bit (same normalized text, same agent) stays
// refused before it's fair game again.
const REPEAT_LOOKBACK_DAYS = envInt('PORCH_REPEAT_LOOKBACK_DAYS', 30);

function toSqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function asDate(now) {
  return now instanceof Date ? now : new Date();
}

function normalize(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function normalizeForDedupe(text) {
  return normalize(text).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS porch_wall_settings (
      wall_id       TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      agent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned_until  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wall_id, agent_user_id)
    );

    CREATE TABLE IF NOT EXISTS porch_agent_reactions (
      id              TEXT PRIMARY KEY,
      wall_id         TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      post_id         TEXT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
      agent_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      register        TEXT NOT NULL,
      text            TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      callback_ref    TEXT REFERENCES porch_agent_reactions(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_porch_reactions_dedupe ON porch_agent_reactions(agent_user_id, normalized_text, created_at);
  `);
}

// ---- Banned lexicon (hot-reloadable) ----

let lexiconCache = { filePath: null, mtimeMs: 0, phrases: [] };

function readLexiconFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const phrases = Array.isArray(data.phrases) ? data.phrases : [];
  return phrases.map((p) => normalize(p).trim()).filter(Boolean);
}

// Stat-checked on every call so an edit to banned.json (PR merge, or
// the future Ledger-proposes/Brandon-signs-off flow) takes effect on
// the very next decide() without a restart — no polling interval to
// tune, no stale cache window.
function getLexicon(opts = {}) {
  const filePath = opts.filePath || DEFAULT_LEXICON_PATH;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return lexiconCache.filePath === filePath ? lexiconCache.phrases : [];
  }
  if (lexiconCache.filePath !== filePath || lexiconCache.mtimeMs !== stat.mtimeMs) {
    lexiconCache = { filePath, mtimeMs: stat.mtimeMs, phrases: readLexiconFile(filePath) };
  }
  return lexiconCache.phrases;
}

// Optional fs.watch sugar for a boot-time log line ("lexicon changed,
// N phrases now"). Not required for hot-reload to work — getLexicon()
// already reloads lazily — this just gives ops visibility.
function watchLexicon(opts = {}) {
  const filePath = opts.filePath || DEFAULT_LEXICON_PATH;
  const log = opts.log || (() => {});
  getLexicon({ filePath });
  const watcher = fs.watch(filePath, { persistent: false }, () => {
    try {
      const phrases = getLexicon({ filePath });
      log(`banned lexicon reloaded (${phrases.length} phrases)`);
    } catch (e) {
      log(`banned lexicon reload failed: ${e.message}`);
    }
  });
  if (watcher.unref) watcher.unref();
  return { stop: () => watcher.close() };
}

function containsBannedPhrase(text, lexicon) {
  const haystack = normalize(text).replace(/[!?.,]+/g, '');
  for (const phrase of lexicon) {
    if (phrase && haystack.includes(phrase)) return phrase;
  }
  return null;
}

// ---- Specificity gate ----

function collectConcreteRefs(comprehension) {
  const c = comprehension || {};
  const buckets = [c.frames, c.captionNames, c.graphEntities, c.pastReactionRefs];
  const refs = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      const s = normalize(item).trim();
      if (s.length >= 2) refs.push(s);
    }
  }
  return refs;
}

// plain_emoji is exempt — an emoji reaction has no text to "reference"
// something concrete with, and is the documented abstract-content
// fallback in the first place.
function hasSpecificity(text, comprehension) {
  const haystack = normalize(text);
  if (!haystack.trim()) return false;
  return collectConcreteRefs(comprehension).some((ref) => haystack.includes(ref));
}

// ---- Register weighting ----

function allowedRegisters(character, isForeign) {
  const weights = (character && character.registerWeights) || {};
  const known = Object.keys(weights).filter((r) => REGISTERS.includes(r) && weights[r] > 0);
  const base = known.length ? known : REGISTERS.slice();
  return isForeign ? base.filter((r) => FOREIGN_AGENT_ALLOWED_REGISTERS.includes(r)) : base;
}

// Weighted draw for the register to try first; remaining available
// registers become the fallback order (heaviest-first) so a gate
// failure on the top pick doesn't fall straight to silence.
function weightedRegisterOrder(weights, available, rng) {
  const w = weights || {};
  if (!available.length) return [];
  const total = available.reduce((sum, r) => sum + Math.max(0, w[r] || 0), 0);
  const draw = (typeof rng === 'function' ? rng() : Math.random());
  let chosen = available[0];
  if (total > 0) {
    let acc = 0;
    const target = draw * total;
    for (const r of available) {
      acc += Math.max(0, w[r] || 0);
      if (target < acc) { chosen = r; break; }
    }
  } else {
    chosen = available[Math.min(available.length - 1, Math.floor(draw * available.length))];
  }
  const rest = available.filter((r) => r !== chosen).sort((a, b) => (w[b] || 0) - (w[a] || 0));
  return [chosen, ...rest];
}

// ---- Banter memory (provenance pattern) ----

function isDuplicateBit(db, agentUserId, text, now, opts = {}) {
  const norm = normalizeForDedupe(text);
  if (!norm) return false;
  const lookbackDays = opts.repeatLookbackDays || REPEAT_LOOKBACK_DAYS;
  const cutoff = toSqliteTimestamp(new Date(asDate(now).getTime() - lookbackDays * 86400000));
  const row = db.prepare(`
    SELECT 1 FROM porch_agent_reactions
    WHERE agent_user_id = ? AND normalized_text = ? AND created_at > ?
    LIMIT 1
  `).get(agentUserId, norm, cutoff);
  return !!row;
}

function findCallbackCandidate(db, agentUserId, callbackRef) {
  if (!callbackRef) return null;
  return db.prepare(`
    SELECT * FROM porch_agent_reactions WHERE id = ? AND agent_user_id = ?
  `).get(callbackRef, agentUserId) || null;
}

function recordBanterMemory(db, { agentUserId, wallId, postId, register, text, callbackRef }, now) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO porch_agent_reactions
      (id, wall_id, post_id, agent_user_id, register, text, normalized_text, callback_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, wallId, postId, agentUserId, register, text, normalizeForDedupe(text), callbackRef || null, toSqliteTimestamp(asDate(now)));
  return id;
}

// ---- Wall opt-out ("vote this agent off the porch") ----

// bannedUntil: null = indefinite (the one-click button's default);
// an ISO string = banned until that instant, then auto-clears itself
// (no row deletion needed — isWallOptedOut just starts returning
// false once `now` passes it).
function setWallOptOut(db, wallId, agentUserId, bannedUntil, now) {
  db.prepare(`
    INSERT INTO porch_wall_settings (wall_id, agent_user_id, banned_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wall_id, agent_user_id) DO UPDATE SET banned_until = excluded.banned_until, updated_at = excluded.updated_at
  `).run(wallId, agentUserId, bannedUntil || null, toSqliteTimestamp(asDate(now)));
}

function clearWallOptOut(db, wallId, agentUserId) {
  db.prepare(`DELETE FROM porch_wall_settings WHERE wall_id = ? AND agent_user_id = ?`).run(wallId, agentUserId);
}

function isWallOptedOut(db, wallId, agentUserId, now) {
  const row = db.prepare(`
    SELECT banned_until FROM porch_wall_settings WHERE wall_id = ? AND agent_user_id = ?
  `).get(wallId, agentUserId);
  if (!row) return false;
  if (row.banned_until === null) return true;
  return row.banned_until > toSqliteTimestamp(asDate(now));
}

// ---- Orchestrator ----

// Evaluates one candidate against every gate except register
// eligibility/weighting (already applied by the caller). Returns
// {pass:true, isCallback, callbackRef} or {pass:false, reason}.
function evaluateCandidate(db, { agentUserId, register, candidate, comprehension, lexicon, now }, opts) {
  const text = candidate.text || '';

  const bannedHit = containsBannedPhrase(text, lexicon);
  if (bannedHit) return { pass: false, reason: 'banned_lexicon' };

  if (register !== 'plain_emoji' && !hasSpecificity(text, comprehension)) {
    return { pass: false, reason: 'not_specific' };
  }

  if (register === 'callback' || candidate.callbackRef) {
    const ref = candidate.callbackRef;
    const prior = findCallbackCandidate(db, agentUserId, ref);
    if (!prior) return { pass: false, reason: 'invalid_callback' };
    return { pass: true, isCallback: true, callbackRef: ref };
  }

  if (isDuplicateBit(db, agentUserId, text, now, opts)) {
    return { pass: false, reason: 'repeated_bit' };
  }

  return { pass: true, isCallback: false };
}

// input: {
//   wallId, postId, agentUserId,
//   now,             // Date, defaults to new Date()
//   character,       // required: { registerWeights: {...}, isForeignAgent }
//   comprehension,   // { frames, captionNames, graphEntities, pastReactionRefs }
//   candidates,      // [{ register, text, callbackRef? }, ...]
// }
// opts: { rng, lexicon, repeatLookbackDays } — all optional test hooks.
//
// Returns exactly one of:
//   { action: 'silent', reason }
//   { action: 'post', register, text }
//   { action: 'riff', register, text, callbackRef }
function decide(db, input, opts = {}) {
  const { wallId, postId, agentUserId, character, comprehension, candidates = [] } = input;
  if (!character) throw new Error('participation-contract: character record is required');
  const now = asDate(input.now);

  if (isWallOptedOut(db, wallId, agentUserId, now)) {
    return { action: 'silent', reason: 'wall_opt_out' };
  }

  const isForeign = !!character.isForeignAgent;
  const allowed = allowedRegisters(character, isForeign);
  if (!allowed.length) {
    return { action: 'silent', reason: 'no_allowed_registers' };
  }

  const byRegister = new Map();
  for (const c of candidates) {
    if (!c || !allowed.includes(c.register)) continue;
    if (!byRegister.has(c.register)) byRegister.set(c.register, []);
    byRegister.get(c.register).push(c);
  }
  if (!byRegister.size) {
    return { action: 'silent', reason: 'no_candidates' };
  }

  const lexicon = opts.lexicon || getLexicon();
  const order = weightedRegisterOrder(character.registerWeights, [...byRegister.keys()], opts.rng);

  let lastReason = 'no_pass';
  for (const register of order) {
    for (const candidate of byRegister.get(register)) {
      const gate = evaluateCandidate(db, { agentUserId, register, candidate, comprehension, lexicon, now }, opts);
      if (gate.pass) {
        recordBanterMemory(db, {
          agentUserId, wallId, postId, register,
          text: candidate.text,
          callbackRef: gate.callbackRef || null,
        }, now);
        return gate.isCallback
          ? { action: 'riff', register, text: candidate.text, callbackRef: gate.callbackRef }
          : { action: 'post', register, text: candidate.text };
      }
      lastReason = gate.reason;
    }
  }
  return { action: 'silent', reason: lastReason };
}

module.exports = {
  REGISTERS,
  FOREIGN_AGENT_ALLOWED_REGISTERS,
  migrate,
  decide,
  getLexicon,
  watchLexicon,
  containsBannedPhrase,
  hasSpecificity,
  allowedRegisters,
  weightedRegisterOrder,
  isDuplicateBit,
  findCallbackCandidate,
  recordBanterMemory,
  setWallOptOut,
  clearWallOptOut,
  isWallOptedOut,
  toSqliteTimestamp,
};
