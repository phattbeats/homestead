// jobs/gazette-daily.js
//
// PHA-2853 — the cron half of the Gazette rework. Composes and persists
// a `gazette_issues` row for every user who has the `gazette` module
// enabled, once per user per LOCAL day, at ~04:00 in that user's own
// timezone (not one global cron time — a household spans timezones).
//
// Wiring pattern: this repo has no node-cron dependency and no jobs/
// directory before this file. The existing "cron" surfaces (see
// server.js's boot scheduler, ~line 4801: `schedulerHandle =
// setInterval(tick, SCHED_TICK_MS)`) are all independent `setInterval`
// ticks that self-check "has enough time passed / is it the right
// moment" on each tick, rather than using a real cron library. This
// file follows that exact convention: `startGazetteDaily(db)` runs a
// tick every `TICK_MS`, and each tick asks "for this user, is it past
// their local 04:00 today, and do they not have today's issue yet?"
//
// Per-user timezone: this repo does not persist a per-user IANA tz
// anywhere (grepped lib/user-model.js — no `tz`/`timezone` column).
// The only tz ever recorded is whatever `X-Homestead-Tz` a request
// carried, which lib/gazette.js already stashes on each `gazette_issues`
// / `gazette_editions` row it writes. This job reuses the most recent
// tz on record for the user (falling back to `DEFAULT_TZ`) as the best
// available per-user schedule offset without inventing new storage.
// Flagged explicitly in the PHA-2853 report as a real limitation, not
// a silent guess.

'use strict';

const gazette = require('./../lib/gazette');
const agentRuntime = require('./../lib/agent-runtime');

const TICK_MS = 15 * 60 * 1000; // 15 min — fine-grained enough to hit a 04:00 local window
const RUN_HOUR_LOCAL = 4; // 04:00
const DEFAULT_TZ = 'UTC';

function isoDateInTz(now, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(now); // en-CA gives YYYY-MM-DD directly
  } catch (_) {
    return now.toISOString().slice(0, 10);
  }
}

function hourInTz(now, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
    return parseInt(fmt.format(now), 10) % 24;
  } catch (_) {
    return now.getUTCHours();
  }
}

// Best-known tz for a user: most recent `gazette_issues` row, else
// `gazette_editions`, else the default. See file header re: no
// dedicated per-user tz column existing anywhere in this repo.
function tzForUser(db, userId) {
  try {
    const fromIssues = db.prepare(
      "SELECT date FROM gazette_issues WHERE user_id = ? ORDER BY date DESC LIMIT 1"
    ).get(userId);
    if (fromIssues) {
      const row = db.prepare(
        "SELECT tz FROM gazette_editions WHERE user_id = ? ORDER BY edition_date DESC LIMIT 1"
      ).get(userId);
      if (row && row.tz) return row.tz;
    }
    const ed = db.prepare(
      "SELECT tz FROM gazette_editions WHERE user_id = ? ORDER BY edition_date DESC LIMIT 1"
    ).get(userId);
    if (ed && ed.tz) return ed.tz;
  } catch (_) { /* fall through */ }
  return DEFAULT_TZ;
}

function usersWithGazetteEnabled(db) {
  return db.prepare(`
    SELECT u.id AS id, u.username AS username
      FROM users u
      JOIN user_modules m ON m.user_id = u.id AND m.module_key = 'gazette' AND m.enabled_at IS NOT NULL
  `).all();
}

// Compose + persist today's typed issue for one user, including
// best-effort agent-authored prose (skipped gracefully if the harness
// has no key configured — the typed payload never depends on it).
async function runForUser(db, user, now) {
  const tz = tzForUser(db, user.id);
  const localDate = isoDateInTz(now, tz);

  if (gazette.getIssue(db, user.id, localDate)) return { username: user.username, skipped: 'already_generated' };

  const ctx = gazette.assembleContext(db, user.username, { tz, now });
  let prose = null;

  const sections = gazette.availableSections(ctx);
  if (sections.length > 0) {
    try {
      const { system, user: userPrompt } = gazette.buildPrompt(ctx);
      const result = await agentRuntime.composeGazette({ system, user: userPrompt });
      if (result && result.ok) {
        prose = gazette.parseEdition(result.text, sections);
      }
    } catch (err) {
      // Typed payload still gets written below — prose is additive.
      console.error(`[gazette-daily] prose composition failed for ${user.username}:`, err.message);
    }
  }

  const payload = gazette.composeTypedPayload(ctx, { prose });
  gazette.putIssue(db, user.id, localDate, { payload, weatherEntry: payload.weather });
  return { username: user.username, date: localDate, thin: payload.thin };
}

async function tick(db, now = new Date()) {
  const users = usersWithGazetteEnabled(db);
  const results = [];
  for (const user of users) {
    const tz = tzForUser(db, user.id);
    if (hourInTz(now, tz) !== RUN_HOUR_LOCAL) continue;
    try {
      results.push(await runForUser(db, user, now));
    } catch (err) {
      console.error(`[gazette-daily] failed for ${user.username}:`, err.message);
    }
  }
  return results;
}

function startGazetteDaily(db) {
  let handle = null;
  if (handle) return handle;
  handle = setInterval(() => {
    tick(db).catch(err => console.error('[gazette-daily] tick failed:', err.message));
  }, TICK_MS);
  console.log('[gazette-daily] started; per-user local 04:00 typed-issue generation, tick=15min');
  return handle;
}

module.exports = { startGazetteDaily, tick, runForUser, usersWithGazetteEnabled, tzForUser };
