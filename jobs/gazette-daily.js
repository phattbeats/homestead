// jobs/gazette-daily.js
//
// the cron half of the Gazette rework. Composes and persists
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
// Flagged explicitly as a real limitation, not
// a silent guess.
//
// PHA-4891 — the catch-up window.
//
// The compose tick fires at 04:00 local, but the wire artifact the
// issue is built around is produced by a SEPARATE upstream job (the
// daily-newspaper build), and that job can finish hours after 04:00 —
// it is late whenever the producer was down or slow at that hour. When
// that happens the 04:00 tick composes an issue with NO wire in it:
// `external.status` comes back 'unavailable' and the paper carries only
// the household sections.
//
// That is not a permanent state — the artifact usually shows up later the
// same day — but the original implementation made it permanent, because
// `runForUser` returned early for ANY existing issue row. A wire-less
// issue could therefore never be replaced by a wired one.
// (Observed 2026-11-03: the compose tick ran at 04:21 ET, the build
// finished at 08:54 ET, and the issue stayed wire-less all day.)
//
// Two independent failures, one fix:
//
//   1. A MISSED 04:00 produced NO issue at all — the old tick only
//      acted when the local hour was exactly 4, so a container that
//      booted at 09:00 never composed a paper that day. A silent day.
//   2. A LATE ARTIFACT produced an issue that could never be repaired.
//
// So the tick now works a WINDOW, not an instant: 04:00 through 16:00
// local. Inside the window the job composes if there is no issue, and
// RECOMPOSES if the issue exists without a usable wire and a usable
// artifact has since appeared. Outside the window nothing is composed
// — and when the window closes on a day that still has no wire, the
// job says so out loud instead of letting the silence stand.
//
// An issue that already has a usable wire is never touched. One issue
// per user per local day stays one issue.

'use strict';

const gazette = require('./../lib/gazette');
const agentRuntime = require('./../lib/agent-runtime');
const shoutbox = require('./../lib/shoutbox');
const { EXTERNAL_SECTION_KEYS } = require('./../lib/external-edition');

const TICK_MS = 15 * 60 * 1000; // 15 min — fine-grained enough to hit a 04:00 local window
const RUN_HOUR_LOCAL = 4;        // 04:00 local — the window opens
const CATCHUP_END_HOUR_LOCAL = 16; // 16:00 local — the window closes
const DEFAULT_TZ = 'UTC';

// Age ceiling for an artifact this job is willing to build a paper on.
// The reader enforces a per-section budget (default 48h) against the
// artifact's own `generated_at` and moves expired sections to
// `stale_sections`; this is the matching ceiling for the artifact as a
// whole. It can only ever reject MORE than the reader already did, so
// the two can never disagree.
const MAX_ARTIFACT_AGE_HOURS = 48;

// Marker on the end-of-window alert, so the alert is recognisable in
// the shoutbox and so the "did we already say this?" check has
// something stable to look for.
const ALERT_TAG = '[gazette]';

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

// The date the HOST considers today — the same calculation
// lib/snapshot.js makes when it builds the context, so the wire we
// read lines up with the date the composed payload will carry.
function hostLocalDate(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

// Does this issue row already carry a usable wire?
//
// The wire sections are MERGED INTO THE TOP-LEVEL `sections` array of
// the stored payload — they are not nested under `payload.external`.
// `payload.external` carries only the wire's STATUS (plus the audience
// scope, the degraded sources and the stale section names). A guard
// that looks for `payload.external.sections` finds nothing on a
// perfectly wired paper and decides, wrongly, that every issue needs
// recomposing.
//
// So: the status says the wire was readable, and the merged section
// list says it actually landed. Both have to be true.
//
// `published` and `partial` are both wired — a partial edition still
// carries the sections that DID make it. `unavailable` and `stale` are
// not: they are the states where the artifact was missing, unreadable,
// or too old to use, and those are exactly the states a later artifact
// can repair.
function issueHasWire(issue) {
  if (!issue || !issue.payload) return false;
  const ext = issue.payload.external;
  if (!ext) return false;
  if (ext.status !== 'published' && ext.status !== 'partial') return false;
  const sections = issue.payload.sections;
  if (!Array.isArray(sections)) return false;
  return sections.some(s => (
    s && typeof s.key === 'string' &&
    EXTERNAL_SECTION_KEYS.includes(s.key) &&
    Array.isArray(s.items) && s.items.length > 0
  ));
}

// A block shaped like "no wire", for the case where the reader itself
// blew up. A read failure must read as "unavailable", never as a
// crash that takes the whole compose down with it.
function unavailableBlock(reason) {
  return {
    status: 'unavailable',
    edition_date: null,
    generated_at: null,
    age_hours: null,
    audience_scope: 'household',
    degraded_sources: [],
    stale_sections: [],
    sections: [],
    reason,
  };
}

// Read the wire for one date, right now.
function readWire(user, date, now) {
  try {
    const block = gazette.readExternalEdition({
      date,
      now,
      userId: user.username,
    });
    return block || unavailableBlock('no_block');
  } catch (err) {
    console.error(`[gazette-daily] wire read failed for ${user.username}:`, err.message);
    return unavailableBlock('read_failed');
  }
}

// Is a usable artifact available for this date RIGHT NOW?
//
// This is the gate for a recompose. It asks the wire reader directly
// rather than trusting the stored row, because the whole point is that
// the artifact appears AFTER the first compose.
function wireUsable(block) {
  if (!block) return false;
  if (block.status !== 'published' && block.status !== 'partial') return false;
  if (!Array.isArray(block.sections) || !block.sections.length) return false;
  // Freshness gate on a REAL signal. `age_hours` is the artifact's own
  // age, published by the reader; null means "no artifact to age",
  // which is not fresh.
  if (typeof block.age_hours !== 'number' || !Number.isFinite(block.age_hours)) return false;
  if (block.age_hours >= MAX_ARTIFACT_AGE_HOURS) return false;
  return true;
}

// Compose + persist today's typed issue for one user, including
// best-effort agent-authored prose (skipped gracefully if the harness
// has no key configured — the typed payload never depends on it).
//
// Recompose policy (PHA-4891):
//   - No issue row yet            -> compose (the original behaviour).
//   - Issue row WITH a usable wire -> leave it alone. One issue per
//     user per local day stays one issue; nothing is rewritten.
//   - Issue row WITHOUT a usable wire (external.status unavailable or
//     stale) AND a usable artifact exists now -> RECOMPOSE, so a late
//     wire can repair a wire-less issue.
//   - Issue row WITHOUT a usable wire and no artifact -> leave it
//     alone. Recomposing onto nothing would just rewrite the same
//     empty state, burn a model call, and reset generated_at.
async function runForUser(db, user, now) {
  const tz = tzForUser(db, user.id);
  const localDate = isoDateInTz(now, tz);
  const wireDate = hostLocalDate(now);

  const existing = gazette.getIssue(db, user.id, localDate);
  if (existing && issueHasWire(existing)) {
    return { username: user.username, skipped: 'already_generated' };
  }

  const block = readWire(user, wireDate, now);

  if (existing && !wireUsable(block)) {
    // No artifact yet: leave the issue exactly as it is. No model call,
    // no rewrite, no generated_at bump. The tick will come back.
    return { username: user.username, skipped: 'wire_missing', date: localDate };
  }

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

  // The block we gated on is the block that lands in the payload. Reading
  // it twice would let the artifact disappear between the gate and the
  // compose, and the paper would claim a wire it does not have.
  const payload = gazette.composeTypedPayload(ctx, { prose, external: block });
  gazette.putIssue(db, user.id, localDate, { payload, weatherEntry: payload.weather });
  const outcome = {
    username: user.username,
    date: localDate,
    thin: payload.thin,
    recomposed: Boolean(existing),
    wire: block.status,
  };
  // A recompose is the repair this whole path exists for — a late
  // artifact turning a wire-less issue into a wired one. It is rare, and
  // it is worth a line in the container log: the failure it repairs used
  // to be completely invisible.
  if (outcome.recomposed) {
    console.log(`[gazette-daily] recomposed ${user.username} ${localDate} — wire=${block.status}`);
  }
  return outcome;
}

// Has today's end-of-window alert already been said?
//
// The close-out runs on every tick after the window closes, so this has
// to be idempotent. The shoutbox itself is the record — a dated marker
// in the body — rather than a new table.
function alertAlreadySent(db, userId, date) {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) c FROM shouts WHERE user_id = ? AND body LIKE ?"
    ).get(userId, `%${ALERT_TAG}%${date}%`);
    return Boolean(row && row.c);
  } catch (_) {
    return false; // no shouts table yet — nothing has been said
  }
}

// Say it out loud: the wire never arrived, so today's paper is thin.
function postWindowAlert(db, user, date, detail) {
  const body = `${ALERT_TAG} ${date} — ${detail}`;
  if (body.length > shoutbox.MAX_BODY_LEN) {
    console.error(`[gazette-daily] alert too long (${body.length}) for ${user.username}`);
    return { sent: false, reason: 'body_too_long' };
  }
  try {
    if (alertAlreadySent(db, user.id, date)) {
      return { sent: false, reason: 'already_sent' };
    }
    // The shouts table is created by the server at boot; migrate() is
    // idempotent and makes this path safe to call from a test or a
    // job that runs before the server's own migration.
    shoutbox.migrate(db);
    shoutbox.post(user.id, body, { now: new Date() });
    // The log line the issue asked for: a missed window has to be visible
    // in the container logs, not only in the shoutbox. The shoutbox is
    // the operational signal; this is the operator's copy.
    console.log(`[gazette-daily] ALERT ${user.username} ${date} — ${detail}`);
    return { sent: true };
  } catch (err) {
    console.error(`[gazette-daily] alert failed for ${user.username}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

// End of the catch-up window. The day is over; either the paper has a
// wire or it does not, and a paper without one is worth saying so.
function closeOutWindow(db, user, tz, now) {
  const localDate = isoDateInTz(now, tz);
  const existing = gazette.getIssue(db, user.id, localDate);
  if (existing && issueHasWire(existing)) {
    return { username: user.username, skipped: 'already_generated', date: localDate };
  }
  const detail = existing
    ? "the wire never arrived, so today's paper has no headlines. The build produced no usable artifact for this date."
    : "today's paper was never composed. The 04:00 window was missed and nothing was written.";
  const alert = postWindowAlert(db, user, localDate, detail);
  return {
    username: user.username,
    date: localDate,
    alert: alert.sent ? 'sent' : (alert.reason || 'skipped'),
  };
}

async function tick(db, now = new Date()) {
  const users = usersWithGazetteEnabled(db);
  const results = [];
  for (const user of users) {
    const tz = tzForUser(db, user.id);
    const hour = hourInTz(now, tz);
    // Before the window: nothing to do. Not late yet.
    if (hour < RUN_HOUR_LOCAL) continue;
    // After the window: nothing new to compose. Close the day out
    // instead, and say something if the wire never showed up.
    if (hour >= CATCHUP_END_HOUR_LOCAL) {
      try {
        results.push(closeOutWindow(db, user, tz, now));
      } catch (err) {
        console.error(`[gazette-daily] close-out failed for ${user.username}:`, err.message);
      }
      continue;
    }
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

module.exports = {
  startGazetteDaily,
  tick,
  runForUser,
  closeOutWindow,
  usersWithGazetteEnabled,
  tzForUser,
  issueHasWire,
  wireUsable,
};
