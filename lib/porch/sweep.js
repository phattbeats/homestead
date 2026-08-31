// Porch sweep scheduler (PHA-2646).
//
// Decides WHEN an agent considers reacting to a wall post. Whether it
// actually reacts — the specificity gate, banned lexicon, register
// choice — is the participation contract's job (sibling PHA-2645, not
// built yet). This module only ever proposes a `{wallId, postId,
// agentUserId, scheduledAt}` decision; the caller (server.js's
// start() wrapper, or a test) is responsible for calling recordAction()
// after a decision actually resulted in a reaction/comment. That keeps
// the daily budget and cooldown ledger honest: a post the contract
// declined (silence is a first-class output, per PHA-2636) never
// consumes budget.
//
// "Agent" identification: a user counts as a Porch agent if they hold
// at least one live agent_tokens row (lib/agent-tokens.js, PHA-1617) —
// that PAT *is* the agent's identity per PHA-2636's architecture note
// ("agents are wall members with their own identity... via BYOK key").
// No separate agent registry table; this is derived, not stored.
//
// PHA-2827.D: Hearth is a Porch citizen too, but he's built-in, not
// BYOK — no agent_tokens row. listAgentUserIds() unions in
// lib/hearth-characters.js's porch_builtin_agents table alongside the
// agent_tokens-derived ids, so he's considered "alongside any
// user-installed agent characters" everywhere this list is used
// (candidate-post exclusion, per-wall budget/cooldown, the sweep
// itself). His `characters` row is seeded, and his wall memberships
// are backfilled, by hearthCharacters.ensureBuiltinAgentUser(db) —
// called once at server boot (server.js) and idempotent/self-healing
// on every call, so this stays a pure read.
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (migrate(db) at boot, start(db) alongside the other
//     independent-setInterval workers like lib/health-checker.js)
//   * scripts/test-porch-sweep.js (acceptance tests)

'use strict';

const { DEFAULTS } = require('./sweep-config');
const hearthCharacters = require('../hearth-characters');

function toSqliteTimestamp(date) {
  // Matches SQLite's own `datetime('now')` format (UTC, no 'T'/'Z') so
  // string comparisons against columns using that default stay valid.
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function asDate(now) {
  return now instanceof Date ? now : new Date();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS porch_sweep_state (
      wall_id        TEXT PRIMARY KEY REFERENCES walls(id) ON DELETE CASCADE,
      last_swept_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS porch_agent_actions (
      id              INTEGER PRIMARY KEY,
      wall_id         TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      agent_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id         TEXT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
      author_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_kind     TEXT NOT NULL CHECK(action_kind IN ('reaction','comment')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_porch_actions_budget ON porch_agent_actions(wall_id, agent_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_porch_actions_cooldown ON porch_agent_actions(wall_id, author_user_id, created_at);

    -- Reserved the moment a sweep proposes {wall, post, agent} — never
    -- re-proposed after that, whether the participation contract acted
    -- or stayed silent. Prevents the same candidate from being handed
    -- out again on every tick while a jittered decision is in flight.
    CREATE TABLE IF NOT EXISTS porch_agent_considered (
      wall_id        TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      post_id        TEXT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
      agent_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      considered_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wall_id, post_id, agent_user_id)
    );
  `);
}

function listAgentUserIds(db, now) {
  const ts = toSqliteTimestamp(asDate(now));
  const tokenIds = db.prepare(`
    SELECT DISTINCT user_id FROM agent_tokens
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
  `).all(ts).map((r) => r.user_id);
  const builtinIds = hearthCharacters.listBuiltinAgentUserIds(db);
  return Array.from(new Set([...tokenIds, ...builtinIds]));
}

function dueWalls(db, now, config) {
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - config.SWEEP_INTERVAL_MINUTES * 60000));
  return db.prepare(`
    SELECT w.id, w.slug FROM walls w
    LEFT JOIN porch_sweep_state s ON s.wall_id = w.id
    WHERE s.wall_id IS NULL OR s.last_swept_at <= ?
    ORDER BY w.id
  `).all(cutoff);
}

function markSwept(db, wallId, now) {
  db.prepare(`
    INSERT INTO porch_sweep_state (wall_id, last_swept_at) VALUES (?, ?)
    ON CONFLICT(wall_id) DO UPDATE SET last_swept_at = excluded.last_swept_at
  `).run(wallId, toSqliteTimestamp(now));
}

function markConsidered(db, wallId, postId, agentUserId, now) {
  db.prepare(`
    INSERT OR IGNORE INTO porch_agent_considered (wall_id, post_id, agent_user_id, considered_at)
    VALUES (?, ?, ?, ?)
  `).run(wallId, postId, agentUserId, toSqliteTimestamp(now));
}

// Deterministic per (wall, agent, day) so the budget doesn't read as a
// suspiciously round metronome number, but is stable across ticks
// within the same day. FNV-1a-ish string hash — good enough, not a
// security boundary.
function effectiveDailyBudget(wallId, agentUserId, dateKey, config) {
  const key = `${wallId}:${agentUserId}:${dateKey}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = Math.max(1, config.DAILY_BUDGET_MAX - config.DAILY_BUDGET_MIN + 1);
  return config.DAILY_BUDGET_MIN + (Math.abs(h) % span);
}

function localDateKey(date, tzOffsetMinutes) {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

// [start, end) UTC instants covering the wall-local day `dateKey`.
function localDayRangeUtc(dateKey, tzOffsetMinutes) {
  const startUtc = new Date(Date.parse(`${dateKey}T00:00:00.000Z`) - tzOffsetMinutes * 60000);
  const endUtc = new Date(startUtc.getTime() + 24 * 3600000);
  return { startUtc, endUtc };
}

function countActionsToday(db, wallId, agentUserId, now, config) {
  const dateKey = localDateKey(now, config.TIMEZONE_OFFSET_MINUTES);
  const { startUtc, endUtc } = localDayRangeUtc(dateKey, config.TIMEZONE_OFFSET_MINUTES);
  const row = db.prepare(`
    SELECT COUNT(*) c FROM porch_agent_actions
    WHERE wall_id = ? AND agent_user_id = ? AND created_at >= ? AND created_at < ?
  `).get(wallId, agentUserId, toSqliteTimestamp(startUtc), toSqliteTimestamp(endUtc));
  return { count: row.c, dateKey };
}

function authorCooldownActive(db, wallId, authorUserId, now, cooldownHours) {
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - cooldownHours * 3600000));
  const row = db.prepare(`
    SELECT 1 FROM porch_agent_actions
    WHERE wall_id = ? AND author_user_id = ? AND created_at > ? LIMIT 1
  `).get(wallId, authorUserId, cutoff);
  return !!row;
}

// Candidate posts for one (wall, agent): past the grace window, not
// already considered by this agent, zero-human-engagement posts first
// (oldest first — "no meme left behind"), then engaged posts (oldest
// first). Excludes only the "already considered" and "too young"
// filters; author cooldown is applied by the caller since it can only
// be checked once we know which agent is asking (cheap enough either
// way, but this keeps the SQL agent-agnostic and cacheable per wall).
function candidatePosts(db, wallId, agentUserId, now, config) {
  const graceCutoff = toSqliteTimestamp(new Date(now.getTime() - config.GRACE_WINDOW_HOURS * 3600000));
  const agentIds = listAgentUserIds(db, now);
  const excludeIds = agentIds.length ? agentIds : [-1];
  const placeholders = excludeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.id, p.author_user_id, p.created_at,
      (SELECT COUNT(*) FROM post_reactions r WHERE r.post_id = p.id AND r.user_id NOT IN (${placeholders})) AS human_reactions,
      (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.author_user_id NOT IN (${placeholders})) AS human_comments
    FROM wall_posts p
    WHERE p.wall_id = ? AND p.created_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM porch_agent_considered pc
        WHERE pc.wall_id = p.wall_id AND pc.post_id = p.id AND pc.agent_user_id = ?
      )
    ORDER BY p.created_at ASC
  `).all(...excludeIds, ...excludeIds, wallId, graceCutoff, agentUserId);

  const zero = [];
  const engaged = [];
  for (const row of rows) {
    (row.human_reactions + row.human_comments === 0 ? zero : engaged).push(row);
  }
  return [...zero, ...engaged];
}

// Plans (at most) one decision per agent for one due wall. Reserves
// the chosen {wall, post, agent} in porch_agent_considered before
// returning, so re-running planWallSweep for the same tick never
// double-proposes it.
function planWallSweep(db, wallId, { now, agentUserIds, config, rng }) {
  const members = new Set(
    db.prepare('SELECT user_id FROM wall_memberships WHERE wall_id = ?').all(wallId).map((r) => r.user_id)
  );
  const decisions = [];
  for (const agentUserId of agentUserIds) {
    if (!members.has(agentUserId)) continue;

    const { count, dateKey } = countActionsToday(db, wallId, agentUserId, now, config);
    const budget = effectiveDailyBudget(wallId, agentUserId, dateKey, config);
    if (count >= budget) continue; // daily budget spent — silent for the rest of the day

    const candidates = candidatePosts(db, wallId, agentUserId, now, config);
    let chosen = null;
    for (const post of candidates) {
      if (post.author_user_id === agentUserId) continue; // never react to your own post
      if (authorCooldownActive(db, wallId, post.author_user_id, now, config.AUTHOR_COOLDOWN_HOURS)) continue;
      chosen = post;
      break;
    }
    if (!chosen) continue;

    markConsidered(db, wallId, chosen.id, agentUserId, now);
    const draw = typeof rng === 'function' ? rng() : Math.random();
    const jitterMinutes = Math.round(draw * config.JITTER_MAX_MINUTES * 100) / 100;
    decisions.push({
      wallId,
      postId: chosen.id,
      agentUserId,
      authorUserId: chosen.author_user_id,
      zeroEngagement: chosen.human_reactions + chosen.human_comments === 0,
      postCreatedAt: chosen.created_at,
      sweptAt: toSqliteTimestamp(now),
      jitterMinutes,
      scheduledAt: toSqliteTimestamp(new Date(now.getTime() + jitterMinutes * 60000)),
      dailyBudget: budget,
      dailyCountBefore: count,
    });
  }
  return decisions;
}

// Public entry point. `opts.now` (Date) and `opts.agentUserIds` are
// overridable so tests can run a whole simulated day without real
// timers. Returns every decision made across every wall that was due.
function runSweep(db, opts = {}) {
  const config = { ...DEFAULTS, ...(opts.config || {}) };
  const now = asDate(opts.now);
  const agentUserIds = opts.agentUserIds || listAgentUserIds(db, now);
  const due = dueWalls(db, now, config);

  const sweptWalls = [];
  const decisions = [];
  for (const wall of due) {
    markSwept(db, wall.id, now);
    sweptWalls.push(wall.slug);
    decisions.push(...planWallSweep(db, wall.id, { now, agentUserIds, config, rng: opts.rng }));
  }
  return { now: toSqliteTimestamp(now), sweptWalls, decisions };
}

// Call after a decision actually produced a reaction/comment (i.e. the
// participation contract didn't stay silent). Feeds both the daily
// budget and the per-author cooldown.
function recordAction(db, { wallId, agentUserId, postId, authorUserId, actionKind, now }) {
  db.prepare(`
    INSERT INTO porch_agent_actions (wall_id, agent_user_id, post_id, author_user_id, action_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wallId, agentUserId, postId, authorUserId, actionKind, toSqliteTimestamp(asDate(now)));
}

// Background timer wrapper, same shape as lib/health-checker.js's
// start(): one independent setInterval, returns { stop, tick }.
// `opts.onDecision(decision)` is where the participation contract
// (PHA-2645) plugs in; until that lands, the default just logs so the
// loop is visibly alive without fabricating an action (and therefore
// without ever calling recordAction on its own — a stub must never
// spend real budget).
function start(db, opts = {}) {
  if (!db) throw new Error('porch/sweep: db is required');
  const config = { ...DEFAULTS, ...(opts.config || {}) };
  const log = opts.log || ((...args) => console.log('[porch-sweep]', ...args));
  const getAgentUserIds = opts.getAgentUserIds || (() => listAgentUserIds(db));
  const onDecision = opts.onDecision || ((decision) => {
    log(`decision pending participation contract (PHA-2645): wall=${decision.wallId} post=${decision.postId} agent=${decision.agentUserId} zeroEngagement=${decision.zeroEngagement} in ${decision.jitterMinutes}m`);
  });

  function tick() {
    let result;
    try {
      result = runSweep(db, { agentUserIds: getAgentUserIds(), config });
    } catch (e) {
      log('tick failed:', e.message);
      return;
    }
    for (const decision of result.decisions) {
      const delayMs = Math.max(0, decision.jitterMinutes * 60000);
      const handle = setTimeout(() => {
        Promise.resolve(onDecision(decision)).catch((e) => log('onDecision failed:', e.message));
      }, delayMs);
      if (handle.unref) handle.unref();
    }
    if (result.sweptWalls.length) {
      log(`swept ${result.sweptWalls.length} wall(s) (${result.sweptWalls.join(', ')}), ${result.decisions.length} decision(s) scheduled`);
    }
  }

  const handle = setInterval(tick, config.TICK_INTERVAL_MINUTES * 60000);
  if (handle.unref) handle.unref();
  const kick = setTimeout(tick, 10 * 1000);
  if (kick.unref) kick.unref();
  log(`started; tick=${config.TICK_INTERVAL_MINUTES}m, sweep-interval=${config.SWEEP_INTERVAL_MINUTES}m/wall, grace=${config.GRACE_WINDOW_HOURS}h, budget=${config.DAILY_BUDGET_MIN}-${config.DAILY_BUDGET_MAX}/day, cooldown=${config.AUTHOR_COOLDOWN_HOURS}h, jitter<=${config.JITTER_MAX_MINUTES}m`);

  return {
    stop() { clearInterval(handle); clearTimeout(kick); log('stopped'); },
    tick,
  };
}

module.exports = {
  migrate,
  runSweep,
  recordAction,
  start,
  listAgentUserIds,
  effectiveDailyBudget,
  localDateKey,
  toSqliteTimestamp,
  DEFAULTS,
};
