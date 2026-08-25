// lib/snapshot.js
//
// PHA-1902 (PHA-1617.9): the `homestead_get_user_context` snapshot endpoint.
//
// One-call morning-brief context builder. Wires the existing tasks +
// events (native + provider cache) + groups into the shape described
// in the BYO-harness Meta-Agent Socket design doc (§7). The same
// builder backs:
//   * `GET /api/me/snapshot` — the HTTP endpoint.
//   * `homestead_get_user_context` — the future MCP tool (PHA-1617.8).
//   * Drawer POST `snapshot` field — outbound §6.2 payload
//     (PHA-1617.5/.6).
//
// Server-side assembly only. No LLM in the loop. No data truncation
// at the data layer; size caps are an HTTP/transport concern.
//
// Activity-recent (`activity_recent`) is sourced from `notification_log`
// as the v0 fallback. PHA-1622 (activity feed) will replace this with a
// richer audit trail once that lands; the shape here is forward-compatible
// because the consumer is just rendering titles + URLs.
//
// Lists (`lists`) — PHA-2586: the `lists` + `list_items` tables land
// in lib/lists.js (migrated + seeded by server.js on boot). The §7
// snapshot contract carries the list summary shape as a stable
// envelope category so PHA-1617 / PHA-1622 future MCP wrappers and the
// drawer outbound POST (PHA-1617.5/.6) can consume the same payload
// without re-querying. Defensive: the snapshot builder runs against
// fresh test databases that may NOT have called lists.migrate yet
// (e.g. snapshot-only unit tests that don't need the lists surface);
// in that case `lists: {}` is still the right answer — no lists
// table, no lists in the snapshot.

'use strict';

const calendarSources = require('./calendar-sources');
const listsLib = require('./lists');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ISO date string (YYYY-MM-DD) for the moment timeMs sits at, in the
 * runtime's local timezone. Homestead is a single-site app, so the
 * server clock is the canonical "today" — the user supplies their
 * explicit `tz` in the user-context payload via the `X-Homestead-Tz`
 * header (or the default of the host's resolved timezone).
 */
function isoDateLocal(timeMs) {
  const d = new Date(timeMs);
  // Use local-time components so "today" matches what the user sees
  // on the dashboard. ISO slice off the time portion.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolve the timezone to publish in the snapshot. Callers MAY send
 * `X-Homestead-Tz` (the SPA picks this up from `Intl.DateTimeFormat`)
 * to make the `today` boundary sticky to the user's wall clock even
 * when the server is in a different TZ. Defaults to the host's
 * resolved timezone.
 */
function resolveTz(req) {
  const header = (req && req.get && req.get('x-homestead-tz')) || '';
  if (header && /^[A-Za-z_]+(?:\/[A-Za-z_+-]+)*$/.test(header)) return header;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

/**
 * Pull the merged feed (native + provider cache) for the given date
 * range. Mirrors the SQL behind `/api/events/merged` — kept inline
 * rather than refactoring that handler so the snapshot endpoint stays
 * independent of the pre-existing merged-feed work (PHA-1867).
 *
 * The downstream raw payload is shaped as the §7 contract expects:
 *   { id, title, date, time, notes, owner, origin, ... }
 * plus the merged-feed discriminator fields. The MCP wrapper tool
 * (PHA-1617.8) will surface this same shape.
 */
function mergedEventsFor(db, fromDay, toDay) {
  const fromIso = fromDay + 'T00:00:00Z';
  const toIso = toDay + 'T23:59:59Z';

  const native = db.prepare(
    'SELECT id, title, date, time, notes, owner FROM events WHERE date >= ? AND date <= ? ORDER BY date, time'
  ).all(fromDay, toDay).map(e => ({
    id: e.id,
    title: e.title,
    notes: e.notes,
    date: e.date,
    time: e.time,
    owner: e.owner,
    origin: 'native',
    source_id: null,
    color: null,
    stale: false,
  }));

  const cached = db.prepare(`
    SELECT cec.id, cec.title, cec.description, cec.start_at, cec.end_at, cec.all_day, cec.location,
           cec.source_id, cs.provider, cs.account_id, cs.color, cs.display_name, cs.last_synced_at, cs.last_error
    FROM calendar_event_cache cec
    JOIN calendar_sources cs ON cs.id = cec.source_id
    WHERE cs.enabled = 1
      AND cec.start_at <= ?
      AND (cec.end_at IS NULL OR cec.end_at >= ?)
  `).all(toIso, fromIso).map(e => ({
    id: `provider-${e.id}`,
    title: e.title,
    notes: e.description,
    start: e.start_at,
    end: e.end_at,
    allDay: !!e.all_day,
    location: e.location,
    owner: null,
    origin: `provider:${e.provider}`,
    source_id: e.source_id,
    color: e.color,
    stale: !e.last_synced_at || (Date.now() - new Date(e.last_synced_at + 'Z').getTime()) > calendarSources.FRESHNESS_MS,
    last_error: e.last_error,
  }));

  return [...native, ...cached];
}

/**
 * Pull the freshest activity entries for the user, sourced from
 * `notification_log` (the v0 fallback). Cap is 25 — the §7 contract
 * calls this "recent activity" and the design doc §6.2 notes the
 * drawer payload is "no truncation at the data layer; size caps are
 * HTTP/transport concern only", but 25 is a reasonable payload bound
 * for the morning brief (well under any reasonable SSE buffer).
 *
 * PHA-1622 (activity feed) will replace this with a richer audit-trail
 * source. The returned shape is `{category, title, body, url, tag,
 * delivered, created_at}` — the same envelope the drawer already
 * renders for push notifications, so PHA-1622 can swap the underlying
 * table without changing the snapshot payload.
 */
function recentActivity(db, userId, limit = 25) {
  // The notification_log table is created inline in server.js (not via a
  // migrate() function). When the snapshot builder is exercised against
  // a fresh test DB that hasn't booted server.js, the table is absent.
  // Defensive: return [] rather than 500 — the §7 contract is
  // "activity_recent is an array", and an empty array is the right
  // answer for users who haven't logged any activity yet.
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='notification_log'"
  ).get();
  if (!exists) return [];
  const rows = db.prepare(`
    SELECT category, title, body, url, tag, delivered, created_at
      FROM notification_log
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(userId, limit);
  return rows.map(r => ({
    category: r.category,
    title: r.title,
    body: r.body,
    url: r.url,
    tag: r.tag,
    delivered: !!r.delivered,
    created_at: r.created_at,
  }));
}

/**
 * Build the §7 snapshot for the given user. Pure data — no HTTP
 * coupling so the same builder can serve the MCP tool wrapper and
 * the outbound drawer POST.
 *
 * Shape (PHA-1902 / design doc §7):
 *   {
 *     user: { id, username, display, groups, isAdmin, tz },
 *     now: <ISO 8601>,
 *     today: <YYYY-MM-DD>,
 *     today_tasks:       [...],
 *     today_events:      [...],
 *     overdue_tasks:     [...],
 *     upcoming: {
 *       events_next_7_days:    [...],
 *       chores_due_next_7_days: [...],
 *     },
 *     lists:   { list_count, open_item_count, active_lists: [...] }, // PHA-2586
 *     activity_recent: [ ... ],  // v0: notification_log fallback
 *   }
 */
function build(db, username, opts) {
  opts = opts || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const tz = opts.tz || 'UTC';
  const today = isoDateLocal(now.getTime());
  const sevenDaysOut = isoDateLocal(now.getTime() + 7 * DAY_MS);

  const me = db.prepare(`SELECT id, username, display, color, is_admin FROM users WHERE username = ?`).get(username);
  if (!me) {
    // Caller would have authenticated already; defensive throw rather
    // than leaking a half-built snapshot.
    throw new Error(`snapshot: user not found: ${username}`);
  }

  // Group membership (denormalized read; the write side is reconciler-driven
  // by PHA-1574 / userModel.reconcileGroups).
  const groups = db.prepare(`
    SELECT g.name FROM user_groups ug
    JOIN groups g ON g.id = ug.group_id
    JOIN users u ON u.id = ug.user_id
   WHERE u.username = ?
   ORDER BY g.name COLLATE NOCASE
  `).all(username).map(r => r.name);

  // Tasks that belong to "today": assignee IN (user, 'all'), not done,
  // due_date exactly today. Cap at 50 so a runaway data set cannot
  // bloat the payload — the second pass (PHA-1617.10) can paginate if
  // it ever matters.
  const todayTasks = db.prepare(`
    SELECT id, title, notes, assignee, alt_assignee, due_date, recur, rotate, done, done_by, done_at, created_at
      FROM tasks
     WHERE done = 0
       AND (assignee = ? OR assignee = 'all')
       AND due_date = ?
     ORDER BY id DESC
     LIMIT 50
  `).all(username, today);

  // Overdue: same scope, due_date < today, not done.
  const overdueTasks = db.prepare(`
    SELECT id, title, notes, assignee, alt_assignee, due_date, recur, rotate, done, done_by, done_at, created_at
      FROM tasks
     WHERE done = 0
       AND (assignee = ? OR assignee = 'all')
       AND due_date IS NOT NULL
       AND due_date < ?
     ORDER BY due_date, id DESC
     LIMIT 50
  `).all(username, today);

  // Chores due in the next 7 days (excluding today — today_tasks is the
  // today slice). Useful for "what's coming up this week".
  const upcomingChores = db.prepare(`
    SELECT id, title, notes, assignee, alt_assignee, due_date, recur, rotate, done, done_by, done_at, created_at
      FROM tasks
     WHERE done = 0
       AND (assignee = ? OR assignee = 'all')
       AND due_date IS NOT NULL
       AND due_date > ? AND due_date <= ?
     ORDER BY due_date, id DESC
     LIMIT 50
  `).all(username, today, sevenDaysOut);

  // Today's events (native + provider cache, merged) — the same shape
  // /api/events/merged returns for the same window.
  const todayEvents = mergedEventsFor(db, today, today);

  // Upcoming events next 7 days: includes today (so the §7 contract
  // matches "events_next_7_days" literally). The merged feed returns
  // overlapping events too; for the morning brief that's the right
  // behavior (any event whose span overlaps the next week).
  const upcomingEvents = mergedEventsFor(db, today, sevenDaysOut);

  return {
    user: {
      id: me.id,
      username: me.username,
      display: me.display,
      color: me.color,
      groups,
      isAdmin: !!me.is_admin,
      tz,
    },
    now: now.toISOString(),
    today,
    today_tasks: todayTasks,
    today_events: todayEvents,
    overdue_tasks: overdueTasks,
    upcoming: {
      events_next_7_days: upcomingEvents,
      chores_due_next_7_days: upcomingChores,
    },
    lists: safeListsStats(db),
    activity_recent: recentActivity(db, me.id, 25),
  };
}

// safeListsStats(db) runs listsLib.publicStats() when the table is
// present, returns the empty envelope when it isn't. Mirrors the
// defensive shape of recentActivity() so snapshot unit tests can
// boot against an in-memory DB that never ran lists.migrate().
//
// The db argument is required — snapshot.js has no module-level db
// handle (build() takes one as a parameter so the same builder can
// serve tests), and the sqlite_master check needs *some* connection
// to detect table presence. Production callers always pass `db`.
function safeListsStats(db) {
  try {
    const hasLists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='lists'"
    ).get();
    if (!hasLists) return { list_count: 0, open_item_count: 0, active_lists: [] };
    return listsLib.publicStats();
  } catch (_) {
    return { list_count: 0, open_item_count: 0, active_lists: [] };
  }
}

module.exports = {
  build,
  // exported for unit tests
  isoDateLocal,
  resolveTz,
  mergedEventsFor,
  recentActivity,
  safeListsStats,
};
