// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead analytics capture (PHA-2210 / PHA-2200 capture layer, v0.1.23).
//
// "Capture broadly. Surface narrowly. Never rank users to each other in the
// product." — PHA-2210 constitutional line. This file is the WRITE path
// only. Read paths live in follow-up PRs (dashboard behind admins-group,
// Hearth-facing read API behind PAT).
//
// Design: schema review comment `b627c024-…` on PHA-2210, approved by
// Brandon ("review, make sure its good to merge"). Three rules govern
// this code:
//
// 1. **Best-effort.** A failed INSERT into `analytics_events` never throws
//    into the caller's request path. Same fire-and-forget contract as
//    `notification_log` (server.js logNotification) and PHA-1622's
//    `logActivity()`. Capture is supposed to be invisible to users; a
//    failed row is a console.error line, never a 500.
//
// 2. **Closed enum.** `KINDS` is a frozen Set; `logEvent` validates against
//    it. Matches the polymorphic-TEXT pattern used by `notification_log
//    .category` / `wall_posts.kind` / `wall_posts.media_id` (and
//    matches the registry-driven FILTER rather than FK pattern of the
//    v0.3.0 module registry per PHA-2203 Amendment 1).
//
// 3. **`logMutation` dual-write for wall actions.** Wall mutations already
//    write to `notification_log` (the user-facing activity feed); PHA-2210
//    does NOT want a parallel raw INSERT in every call site (drift risk,
//    two prune schedules). `logMutation` is the single helper that writes
//    both `notification_log` (notification shape) AND `analytics_events`
//    (analytics shape) from one call. For non-wall mutations, callers use
//    `logEvent` directly.

'use strict';

// -----------------------------------------------------------------------------
// Kind taxonomy (23 kinds total — matches the schema-review comment).
//
// Module lifecycle: gated on PHA-2200 (lib/modules.js) landing on main.
// Capture layer is structural and stable; if a kind is added before the
// registry is live, the row just won't join to anything yet (rollups +
// dashboard wait for the registry). No FK on subject_type/subject_id.

const KINDS = Object.freeze(new Set([
  // Module lifecycle (3) — wired when PHA-2200 lands on main
  'module_enabled',
  'module_disabled',
  'module_first_enable',

  // Onboarding funnel (5) — wired when invite_issued/accepted land
  'invite_issued',
  'invite_accepted',
  'first_login',
  'first_post',
  'first_reaction',

  // Wall activity (5) — wired this PR
  'wall_post_created',
  'wall_reaction_added',
  'wall_comment_added',
  'wall_post_shared',        // no such endpoint yet; reserved
  'media_uploaded',          // shared with media-storage primitive

  // Retention (3) — wired this PR (login/logout only; page_viewed deferred)
  'session_started',
  'session_ended',
  'page_viewed',             // client-side; reserved

  // App/tile usage (1) — wired when tile metrics land
  'tile_opened',             // reserved

  // Ops health (6) — wired this PR for the two that exist
  'tile_health_transition',
  'push_delivered',
  'push_failed',
  'drawer_call_started',
  'drawer_call_completed',
  'drawer_call_failed',

  // Hearth house-actions (2) — PHA-2851. One row per tool_call the
  // runtime actually executed, separate from the drawer_call_* pair
  // that measures the conversation around it: an action can succeed
  // inside a dispatch that later fails, and a refused permission check
  // is the thing you most want to be able to count.
  'hearth_action_invoked',
  'hearth_action_failed',
]));

let _db = null;

// migrate(db): creates analytics_events + indexes. Idempotent (CREATE
// TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Same boot-migration
// pattern as lib/walls.js / lib/media.js — server.js calls
// analytics.migrate(db) at boot.
function migrate(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id                INTEGER PRIMARY KEY,
      ts                TEXT    NOT NULL DEFAULT (datetime('now')),
      user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind              TEXT    NOT NULL,
      subject_type      TEXT    NOT NULL,
      subject_id        TEXT,
      bytes             INTEGER,                          -- promoted: media_uploaded
      duration_seconds  INTEGER,                          -- promoted: session_ended, drawer_call_*
      meta              TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_ae_ts        ON analytics_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ae_user_ts   ON analytics_events(user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ae_kind_ts   ON analytics_events(kind, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ae_bytes_ts  ON analytics_events(bytes, ts DESC) WHERE bytes IS NOT NULL;
  `);
}

// logEvent(db, entry): INSERT one analytics_events row.
//
// entry shape:
//   {
//     userId:          INTEGER | null,        // null for system-initiated events
//     kind:            string,                // must be in KINDS
//     subjectType:     string,                // e.g. 'wall_post', 'user', 'service'
//     subjectId:       string | null,         // polymorphic (TEXT to carry UUIDs + ints)
//     meta?:           object,                // JSON-serializable; defaults to {}
//     bytes?:          INTEGER | null,        // promoted column for media-uploaded
//     durationSeconds?: INTEGER | null,        // promoted column for session_ended + drawer_call_*
//   }
//
// Returns true on success, false on any failure (best-effort). Never
// throws. Callers do NOT need a try/catch.
function logEvent(db, entry) {
  if (!entry || !KINDS.has(entry.kind)) return false;
  const meta = entry.meta ? JSON.stringify(entry.meta) : '{}';
  try {
    db.prepare(`
      INSERT INTO analytics_events (user_id, kind, subject_type, subject_id, bytes, duration_seconds, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.userId || null,
      entry.kind,
      entry.subjectType,
      entry.subjectId != null ? String(entry.subjectId) : null,
      Number.isFinite(entry.bytes) ? entry.bytes : null,
      Number.isFinite(entry.durationSeconds) ? entry.durationSeconds : null,
      meta
    );
    return true;
  } catch (e) {
    // Best-effort. A failed capture is not a failed request.
    console.error('[analytics] logEvent failed:', e.message, 'kind=', entry.kind);
    return false;
  }
}

// logFirst(db, entry): like logEvent, but only writes if no row of
// (user_id, kind) exists yet. Used for first_login / first_post /
// first_reaction / first_module_added funnel signals.
//
// Same best-effort contract as logEvent — never throws.
//
// Returns true if a new row was inserted, false otherwise (already-fired
// or write-failed).
function logFirst(db, entry) {
  if (!entry || !KINDS.has(entry.kind)) return false;
  try {
    const existing = db.prepare(
      'SELECT 1 FROM analytics_events WHERE user_id = ? AND kind = ? LIMIT 1'
    ).get(entry.userId || null, entry.kind);
    if (existing) return false;
    return logEvent(db, entry);
  } catch (e) {
    console.error('[analytics] logFirst failed:', e.message, 'kind=', entry.kind);
    return false;
  }
}

// logMutation(db, entry): dual-write helper. Writes ONE notification_log
// row (the user-facing activity feed) AND ONE analytics_events row from
// one call. Used for wall mutations where both tables need a row.
//
// entry shape:
//   {
//     userId:        INTEGER,
//     notification:  { category, title, body?, url?, tag? },  // notification_log fields
//     analytics:     { kind, subjectType, subjectId, meta?, ... }  // logEvent fields
//   }
//
// notification_log write is non-fatal (mirrors the existing pattern in
// server.js logNotification — fail-and-continue). analytics write is
// non-fatal (logEvent). Returns { notification: bool, analytics: bool }.
function logMutation(db, entry) {
  const result = { notification: false, analytics: false };
  if (!entry || !entry.userId) return result;
  const n = entry.notification;
  if (n) {
    try {
      db.prepare(`
        INSERT INTO notification_log (user_id, category, title, body, url, tag, delivered, skipped_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.userId,
        n.category || 'system',
        n.title || '',
        n.body || null,
        n.url || null,
        n.tag || null,
        1,                                      // delivered=1; analytics isn't a delivery attempt
        null
      );
      result.notification = true;
    } catch (e) {
      console.error('[analytics] logMutation.notification failed:', e.message);
    }
  }
  if (entry.analytics) {
    result.analytics = logEvent(db, { ...entry.analytics, userId: entry.userId });
  }
  return result;
}

// prune(db, opts): removes rows older than `opts.days` (default 180) OR
// when total count exceeds `opts.maxRows` (default 500000), whichever
// prunes more. Same retention contract as the design.
//
// Idempotent. Safe to call on every scheduler tick. Doesn't return the
// number pruned — call sites don't need it; the scheduler logs the count
// via a follow-up SELECT if interested.
function prune(db, { days = 180, maxRows = 500000 } = {}) {
  try {
    db.prepare('DELETE FROM analytics_events WHERE ts < datetime(\'now\', ?)').run(`-${days} days`);
    const c = db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n;
    if (c > maxRows) {
      const excess = c - maxRows;
      // Delete the OLDEST `excess` rows. SQLite handles this via subquery
      // because DELETE doesn't allow LIMIT on older versions; using
      // `id IN (SELECT id ... ORDER BY ts ASC LIMIT ?)` is the portable
      // pattern.
      db.prepare(`
        DELETE FROM analytics_events
        WHERE id IN (SELECT id FROM analytics_events ORDER BY ts ASC LIMIT ?)
      `).run(excess);
    }
  } catch (e) {
    console.error('[analytics] prune failed:', e.message);
  }
}

module.exports = {
  migrate,
  logEvent,
  logMutation,
  prune,
  logFirst,
  KINDS,
};
