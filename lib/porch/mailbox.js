// Agent-to-agent mailbox (PHA-2426): async cross-household messaging
// between this household's own agent and an external household's
// agent, installed exactly like any other PHA-2201 third-party app —
// the "foreign harness" IS an installed_apps row + an app-scoped
// agent_tokens PAT, no separate registry.
//
// Non-negotiable rules (Brandon-set, on PHA-1617 — see PHA-2426):
//   1. Inbound messages are UNTRUSTED DATA, never instructions. This
//      module never parses message bodies for commands and never
//      drives any other module from mailbox content — the only side
//      effect a post can ever have is storage + a Porch mirror post.
//      Any future feature that wants to *act* on a message (PHA-2636)
//      must treat the body as opaque text to summarize/relay, and any
//      mutation it proposes is a separate write path gated by rule 4
//      below, not something this module performs.
//   2. Chatter budgets: MAX_MESSAGES_PER_WINDOW per installed app
//      (approximates "per heartbeat") + MAX_TURNS_PER_THREAD.
//   3. All a2a traffic is mirrored onto a Porch wall at write time —
//      structurally enforced here by creating the wall_posts row
//      BEFORE the mailbox_messages row, so a mailbox message can never
//      exist without its human-visible counterpart. No hidden DM layer.
//   4. Foreign-agent-initiated mutations (calendar holds, chore swaps)
//      are proposals requiring human confirmation, never direct
//      writes. Nothing in this module writes to any other module's
//      tables, so this rule holds by construction until a future
//      proposal-consuming feature is built on top of it.
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (migrate(db) at boot, mounts /api/mailbox/* routes)
//   * scripts/test-mailbox.js (acceptance tests)

'use strict';

const crypto = require('crypto');
const walls = require('../walls');
const { DEFAULTS } = require('./mailbox-config');

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function toSqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function asDate(now) {
  return now instanceof Date ? now : new Date();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_threads (
      id               TEXT PRIMARY KEY,
      app_id           TEXT NOT NULL REFERENCES installed_apps(key) ON DELETE CASCADE,
      local_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wall_slug        TEXT NOT NULL DEFAULT 'household',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at  TEXT NOT NULL DEFAULT (datetime('now')),
      turn_count       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_threads_app ON mailbox_threads(app_id);

    CREATE TABLE IF NOT EXISTS mailbox_messages (
      id             TEXT PRIMARY KEY,
      thread_id      TEXT NOT NULL REFERENCES mailbox_threads(id) ON DELETE CASCADE,
      app_id         TEXT NOT NULL REFERENCES installed_apps(key) ON DELETE CASCADE,
      topic          TEXT NOT NULL,
      from_identity  TEXT NOT NULL,
      direction      TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      body           TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      read_by        TEXT NOT NULL DEFAULT '[]',
      wall_post_id   TEXT REFERENCES wall_posts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_messages_thread ON mailbox_messages(thread_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_mailbox_messages_budget ON mailbox_messages(app_id, created_at);
  `);
}

function threadId(appId, threadKey) {
  return `${appId}::${threadKey}`;
}

function ensureThread(db, { appId, threadKey, localUserId, wallSlug, now }) {
  const id = threadId(appId, threadKey);
  db.prepare(`
    INSERT OR IGNORE INTO mailbox_threads (id, app_id, local_user_id, wall_slug, created_at, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, appId, localUserId, wallSlug || 'household', toSqliteTimestamp(now), toSqliteTimestamp(now));
  return db.prepare('SELECT * FROM mailbox_threads WHERE id = ?').get(id);
}

function countRecent(db, appId, now, windowMinutes) {
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - windowMinutes * 60000));
  const row = db.prepare(`
    SELECT COUNT(*) c FROM mailbox_messages WHERE app_id = ? AND created_at > ?
  `).get(appId, cutoff);
  return row.c;
}

function mirrorText(direction, fromIdentity, topic, body) {
  const header = direction === 'inbound'
    ? `[a2a mailbox · untrusted external message from ${fromIdentity} · thread "${topic}"]`
    : `[a2a mailbox · reply from ${fromIdentity} · thread "${topic}"]`;
  return `${header}\n${body}`;
}

function messageView(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    topic: row.topic,
    fromIdentity: row.from_identity,
    direction: row.direction,
    trust: row.direction === 'inbound' ? 'untrusted_external' : 'household_authored',
    body: row.body,
    createdAt: row.created_at,
    readBy: JSON.parse(row.read_by || '[]'),
    wallPostId: row.wall_post_id,
  };
}

// postMessage: the ONLY write path into the mailbox. `direction` and
// `fromIdentity` are resolved by the caller (server.js) from the
// authenticated token — this function never infers trust from message
// content. Creates the Porch mirror post FIRST (rule 3): if that
// throws (e.g. localUserId isn't actually a member of wallSlug), no
// mailbox_messages row is ever written, so "every message has a Porch
// post" holds even under partial failure.
function postMessage(db, { appId, localUserId, threadKey, topic, direction, fromIdentity, body, wallSlug, now, config } = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const at = asDate(now);

  if (!appId) throw httpError(400, 'app_id_required');
  if (!localUserId) throw httpError(400, 'local_user_id_required');
  if (!threadKey || !String(threadKey).trim()) throw httpError(400, 'thread_key_required');
  if (!topic || !String(topic).trim()) throw httpError(400, 'topic_required');
  if (direction !== 'inbound' && direction !== 'outbound') throw httpError(400, 'invalid_direction');
  if (!fromIdentity || !String(fromIdentity).trim()) throw httpError(400, 'from_identity_required');
  const text = (body || '').trim();
  if (!text) throw httpError(400, 'body_required');

  // Budget check first, before touching mailbox_threads at all: an app
  // that's over budget must not get a phantom empty thread row out of
  // a rejected first message on a brand new threadKey.
  if (countRecent(db, appId, at, cfg.WINDOW_MINUTES) >= cfg.MAX_MESSAGES_PER_WINDOW) {
    throw httpError(429, 'chatter_budget_exceeded');
  }

  const thread = ensureThread(db, { appId, threadKey, localUserId, wallSlug, now: at });

  if (thread.turn_count >= cfg.MAX_TURNS_PER_THREAD) {
    throw httpError(429, 'thread_turn_limit_reached');
  }

  const wallPost = walls.createPost(thread.wall_slug, localUserId, {
    kind: 'text',
    text_body: mirrorText(direction, fromIdentity, topic, text),
  });

  const id = crypto.randomUUID();
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO mailbox_messages (id, thread_id, app_id, topic, from_identity, direction, body, created_at, wall_post_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, thread.id, appId, topic, fromIdentity, direction, text, toSqliteTimestamp(at), wallPost.id);
    db.prepare(`
      UPDATE mailbox_threads SET turn_count = turn_count + 1, last_message_at = ? WHERE id = ?
    `).run(toSqliteTimestamp(at), thread.id);
  });
  insert();

  return messageView(db.prepare('SELECT * FROM mailbox_messages WHERE id = ?').get(id));
}

// listThreads: pass `appId` to scope to one installed app (app-scoped
// token view) or `localUserId` for the household-wide view (full-access
// caller — Hearth's own heartbeat, or a household member's session).
function listThreads(db, { appId, localUserId } = {}) {
  let rows;
  if (appId) {
    rows = db.prepare('SELECT * FROM mailbox_threads WHERE app_id = ? ORDER BY last_message_at DESC').all(appId);
  } else if (localUserId) {
    rows = db.prepare('SELECT * FROM mailbox_threads WHERE local_user_id = ? ORDER BY last_message_at DESC').all(localUserId);
  } else {
    rows = db.prepare('SELECT * FROM mailbox_threads ORDER BY last_message_at DESC').all();
  }
  return rows.map((t) => ({
    id: t.id,
    appId: t.app_id,
    localUserId: t.local_user_id,
    wallSlug: t.wall_slug,
    createdAt: t.created_at,
    lastMessageAt: t.last_message_at,
    turnCount: t.turn_count,
  }));
}

function getThread(db, id) {
  return db.prepare('SELECT * FROM mailbox_threads WHERE id = ?').get(id);
}

// listMessages: `sinceId` (exclusive) supports incremental heartbeat
// polling — callers pass back the last id they saw. Cursors on `rowid`
// rather than `created_at`: the latter is truncated to whole seconds
// (toSqliteTimestamp), so two messages in the same second would tie
// and a `>` comparison could wrongly drop the second one.
function listMessages(db, threadIdValue, { sinceId, limit } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  let rows;
  if (sinceId) {
    const since = db.prepare('SELECT rowid FROM mailbox_messages WHERE id = ?').get(sinceId);
    if (since) {
      rows = db.prepare(`
        SELECT * FROM mailbox_messages WHERE thread_id = ? AND rowid > ?
        ORDER BY rowid ASC LIMIT ?
      `).all(threadIdValue, since.rowid, cap);
    } else {
      rows = [];
    }
  } else {
    rows = db.prepare(`
      SELECT * FROM mailbox_messages WHERE thread_id = ? ORDER BY rowid ASC LIMIT ?
    `).all(threadIdValue, cap);
  }
  return rows.map(messageView);
}

// markRead: `readerKey` is an opaque caller-supplied string (server.js
// uses `user:<id>` for local callers, `app:<appId>` for app-scoped
// tokens) appended to each message's read_by set exactly once.
function markRead(db, messageIds, readerKey) {
  const rows = db.prepare(`SELECT id, read_by FROM mailbox_messages WHERE id IN (${messageIds.map(() => '?').join(',')})`).all(...messageIds);
  const update = db.prepare('UPDATE mailbox_messages SET read_by = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const row of rows) {
      const readBy = JSON.parse(row.read_by || '[]');
      if (!readBy.includes(readerKey)) {
        readBy.push(readerKey);
        update.run(JSON.stringify(readBy), row.id);
      }
    }
  });
  tx();
}

module.exports = {
  migrate,
  postMessage,
  listThreads,
  getThread,
  listMessages,
  markRead,
  threadId,
  messageView,
};
