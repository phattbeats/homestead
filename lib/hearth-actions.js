// Hearth's inbound action surface (PHA-2851).
//
// PHA-2830 shipped the server-side Hearth runtime text-only: the drawer
// demo promises "queue Part Two" and "tell him the meme was mid" take
// real action across the house, but the runtime could only ever talk
// about doing it. This module is the doing.
//
// Deliberately NOT an MCP server host. Third-party tool registration is
// a separate design (and a separate consent story — see PHA-2201's
// manifest/scope contract). These are Hearth's OWN house-actions:
// first-party, small, and named after things a household member would
// actually ask for out loud.
//
// Two actions ship in v1:
//
//   * `enqueue_media`  — queue something from Plex / Kavita /
//     Audiobookshelf onto the caller's watch-next list, and say so on
//     their wall.
//   * `mention_user`   — pass a message to another member, through the
//     mention + notification machinery that already exists.
//
// `set_lights` is deliberately absent. The porch has no lights
// integration and the drawer screenshot never promised one; a stub that
// returns "ok" for an action nothing performs is worse than no action.
//
// Validation follows the lib/connector-spec.js SHAPE — a typed error
// carrying the offending field path — without the machinery. Connector
// specs are untrusted third-party documents that need a full schema
// walk; these are two first-party call sites with five fields between
// them, so the validators are hand-written and readable.
//
// Layering: this module owns the DB writes and the permission checks.
// lib/agent-runtime.js turns it into a provider tool block and executes
// the model's tool_calls against it; server.js exposes the same two
// operations as plain auth-gated REST so a human (or a scripted client)
// can invoke them without going through a model at all. Same function,
// three callers — the permission check can't be skipped by picking a
// different door.

'use strict';

const crypto = require('crypto');

const walls = require('./walls');
const analytics = require('./analytics');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// Mirrors lib/connector-spec.js's ConnectorSpecError: a typed error that
// names the field it rejected, so the route layer can answer with
// `{ error, field }` and the drawer can render *which* argument Hearth
// got wrong rather than a bare 400.

class ActionInputError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ActionInputError';
    this.field = field || null;
    this.status = 400;
    this.code = 'invalid_input';
  }
}

// Everything that isn't a malformed argument: the target isn't reachable,
// the caller has no wall to post to, the media source is unknown to this
// house. `code` is the stable machine-readable string; `message` is what
// Hearth is allowed to say out loud.
class ActionError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MEDIA_SOURCES = Object.freeze(['plex', 'kavita', 'audiobookshelf']);
const MEDIA_SOURCE_SET = new Set(MEDIA_SOURCES);
const MEDIA_SOURCE_NAMES = Object.freeze({
  plex: 'Plex',
  kavita: 'Kavita',
  audiobookshelf: 'Audiobookshelf',
});

// `audiobookshelf` is accepted here but has no sync module yet
// (lib/sync/ ships plex.js + kavita.js only). A queue row for it is
// still meaningful — it records the intent and renders on the wall —
// it just can't resolve a title from the entity graph, so it falls back
// to the raw id. Rejecting the source outright would be worse: the
// action surface would silently disagree with the enum the issue
// specified, and the model would learn to lie about what it can queue.

// migrate(db): the per-user media queue.
//
// `wall_post_id` intentionally carries NO foreign key to wall_posts.
// The queue row is the durable record of "I asked for this"; the wall
// post is an announcement with a retention window (walls can set
// retention_days, and posts expire). A cascade or a SET NULL would let
// wall retention quietly rewrite the queue's history. Soft reference,
// checked at read time by whoever wants to deep-link.
//
// UNIQUE(user_id, source, source_id) makes the action idempotent: a
// model that retries its own tool_call — or a user who says "queue it"
// twice — gets the same queueId back and exactly one wall post, rather
// than a duplicate row and a second announcement.
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_queue (
      id            TEXT PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source        TEXT NOT NULL CHECK(source IN ('plex','kavita','audiobookshelf')),
      source_id     TEXT NOT NULL,
      title         TEXT,
      entity_id     TEXT,
      user_message  TEXT,
      wall_post_id  TEXT,
      queued_via    TEXT NOT NULL DEFAULT 'hearth',
      status        TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued','done','removed')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_queue_user
      ON media_queue(user_id, created_at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function requireString(value, field, { max = 2000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ActionInputError(`${field} must be a non-empty string`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ActionInputError(`${field} must be ${max} characters or fewer`, field);
  }
  return trimmed;
}

function optionalString(value, field, opts) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, opts);
}

// validateEnqueueMedia(input) -> normalized { source, id, userMessage }
function validateEnqueueMedia(input) {
  const b = input || {};
  const source = requireString(b.source, 'source', { max: 40 }).toLowerCase();
  if (!MEDIA_SOURCE_SET.has(source)) {
    throw new ActionInputError(
      `source must be one of ${MEDIA_SOURCES.join(', ')}`,
      'source'
    );
  }
  return {
    source,
    id: requireString(b.id, 'id', { max: 200 }),
    userMessage: optionalString(b.userMessage, 'userMessage', { max: 500 }),
  };
}

// validateMentionUser(input) -> normalized { username, message, onWall }
//
// The username bound matches lib/notifications.js's MENTION_RE
// (`@([A-Za-z0-9_]{1,32})`) — a name this validator accepts but that
// regex wouldn't match would post a message that never becomes a
// mention row, which is exactly the silent failure this issue exists to
// kill.
function validateMentionUser(input) {
  const b = input || {};
  const username = requireString(b.username, 'username', { max: 32 }).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,32}$/.test(username)) {
    throw new ActionInputError(
      'username must be 1-32 characters of letters, digits or underscore',
      'username'
    );
  }
  return {
    username,
    message: requireString(b.message, 'message', { max: 1000 }),
    onWall: optionalString(b.onWall, 'onWall', { max: 80 }),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// defaultWallFor(userId): the wall an action posts to when the caller
// didn't name one. Prefers the Household Porch (walls.seed()'s
// `household` slug — the one wall every seeded member is in), then falls
// back to the caller's oldest wall. Returns null when the user is in no
// wall at all, which callers surface as `no_wall` rather than inventing
// one.
//
// Reads through lib/walls.js's own membership query rather than
// re-deriving the group/direct join here — one definition of "walls you
// can see", so an action can never post somewhere the Porch UI wouldn't
// show the user.
function defaultWallFor(userId) {
  const mine = walls.listForUser(userId);
  if (!mine.length) return null;
  return mine.find((w) => w.slug === 'household') || mine[0];
}

// sharesWall(userIdA, userIdB): membership intersection, used as the
// reachability rule for mention_user. Same source of truth as
// defaultWallFor.
function sharedWalls(userIdA, userIdB) {
  const a = new Set(walls.listForUser(userIdA).map((w) => w.slug));
  return walls.listForUser(userIdB).filter((w) => a.has(w.slug));
}

// resolveMediaTitle(db, source, id): best-effort join into the entity
// graph (lib/sync/plex.js + kavita.js upsert `(kind, source_service,
// source_id)`). A house that hasn't synced that library yet — or the
// Audiobookshelf case, which has no sync module — gets a null title and
// the caller falls back to the raw id. Never throws: a missing
// `entities` table means "no entity graph here", not an error (several
// narrow test scripts migrate walls without lib/sync's schema).
function resolveMediaTitle(db, source, id) {
  try {
    const row = db.prepare(`
      SELECT id, name FROM entities
      WHERE source_service = ? AND source_id = ?
      ORDER BY CASE kind WHEN 'work' THEN 0 ELSE 1 END
      LIMIT 1
    `).get(source, id);
    return row ? { entityId: row.id, title: row.name } : { entityId: null, title: null };
  } catch (e) {
    if (/no such table/i.test(e.message)) return { entityId: null, title: null };
    throw e;
  }
}

function findUserByUsername(db, username) {
  return db.prepare(
    'SELECT id, username, display FROM users WHERE lower(username) = lower(?)'
  ).get(username) || null;
}

// ---------------------------------------------------------------------------
// Action: enqueue_media
// ---------------------------------------------------------------------------
//
// enqueueMedia(db, me, input) -> { ok, queueId, wallPostId, title,
//   source, alreadyQueued }
//
// Writes the queue row FIRST, then announces it. If the announcement
// throws (retention math, a wall deleted between the membership read and
// the insert) the queue row is rolled back rather than left behind — an
// action that half-happened is the thing the drawer chip would lie
// about.

function enqueueMedia(db, me, input) {
  const { source, id, userMessage } = validateEnqueueMedia(input);

  const existing = db.prepare(
    'SELECT * FROM media_queue WHERE user_id = ? AND source = ? AND source_id = ?'
  ).get(me.id, source, id);
  if (existing) {
    return {
      ok: true,
      queueId: existing.id,
      wallPostId: existing.wall_post_id || null,
      title: existing.title || existing.source_id,
      source,
      alreadyQueued: true,
    };
  }

  const wall = defaultWallFor(me.id);
  if (!wall) {
    throw new ActionError(409, 'no_wall', "You're not on a wall yet, so there's nowhere for me to post that.");
  }

  const { entityId, title } = resolveMediaTitle(db, source, id);
  const label = title || id;
  const queueId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO media_queue (id, user_id, source, source_id, title, entity_id, user_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(queueId, me.id, source, id, title, entityId, userMessage);

  const text = [
    `🕒 Queued via Hearth: ${MEDIA_SOURCE_NAMES[source]} — ${label}`,
    userMessage,
  ].filter(Boolean).join('\n');

  let post;
  try {
    post = walls.createPost(wall.slug, me.id, { kind: 'text', text_body: text });
  } catch (e) {
    db.prepare('DELETE FROM media_queue WHERE id = ?').run(queueId);
    throw e;
  }

  db.prepare('UPDATE media_queue SET wall_post_id = ? WHERE id = ?').run(post.id, queueId);

  analytics.logEvent(db, {
    userId: me.id,
    kind: 'hearth_action_invoked',
    subjectType: 'media_queue',
    subjectId: queueId,
    meta: { action: 'enqueue_media', source, wall_slug: wall.slug, resolved_title: !!title },
  });

  return {
    ok: true,
    queueId,
    wallPostId: post.id,
    title: label,
    source,
    wallSlug: wall.slug,
    alreadyQueued: false,
  };
}

// ---------------------------------------------------------------------------
// Action: mention_user
// ---------------------------------------------------------------------------
//
// mentionUser(db, me, input) -> { ok, mentionId, delivered, postId, wallSlug }
//
// "Tell him the meme was mid" is a mention, not a new messaging
// primitive. It posts `@target <message>` to a wall they share, which
// runs the message through lib/walls.js's createPost — the same path a
// human typing the same thing takes. That buys the mention row, the
// notification fan-out, the per-wall notification level check, thread
// mutes and quiet hours for free, and guarantees Hearth can never
// deliver a message the recipient's own settings said no to.
//
// `delivered` is the honest count: notification_log rows written for the
// target with no skipped_reason. If they've muted the wall, Hearth
// reports 0 and says so — that's the "delivered count" the issue asks
// for, and it's the number the drawer chip should show.
//
// NOTE ON EMAIL: the issue's acceptance says "notification row + email".
// This repo has no mail transport — no nodemailer, no SMTP config, no
// sender identity anywhere in lib/ or server.js. The household's actual
// delivery surface is the notification row plus web-push (server.js's
// notify()), which is what this wires. Adding an SMTP dependency and a
// deliverability story is its own issue, not a line item inside the
// smallest viable action slice; flagged on PHA-2851 rather than faked
// with a no-op mailer that would report "sent".

const MENTION_REACHABILITY_MSG =
  "I can't reach that person — we're not on a wall together.";

function mentionUser(db, me, input) {
  const { username, message, onWall } = validateMentionUser(input);

  const target = findUserByUsername(db, username);
  if (!target) {
    throw new ActionError(404, 'unknown_user', `I don't know anyone called @${username}.`);
  }

  const isSelf = target.id === me.id;

  // Wall resolution. `porch` is an alias for "wherever this user's
  // porch is" rather than a literal slug — the seeded Household Porch
  // is `household` (walls.seed()), and a house that renamed it would
  // otherwise break the model's most natural argument.
  let wall;
  if (onWall && onWall !== 'porch') {
    const mine = walls.listForUser(me.id);
    wall = mine.find((w) => w.slug === onWall) || null;
    if (!wall) {
      throw new ActionError(403, 'wall_not_reachable', `I can't post to "${onWall}".`);
    }
  } else {
    wall = defaultWallFor(me.id);
    if (!wall) {
      throw new ActionError(409, 'no_wall', "You're not on a wall yet, so there's nowhere for me to post that.");
    }
  }

  // Reachability: the target must be reachable from the CALLER, and the
  // chosen wall must be one they actually share. Checking both matters —
  // sharing *some* wall doesn't license posting an @-mention on a
  // different one the target can't see, which would produce a mention
  // row pointing at a post that 404s for them.
  if (!isSelf) {
    const shared = sharedWalls(me.id, target.id);
    if (!shared.length) {
      throw new ActionError(403, 'not_reachable', MENTION_REACHABILITY_MSG);
    }
    if (!shared.some((w) => w.slug === wall.slug)) {
      throw new ActionError(403, 'not_reachable',
        `@${username} isn't on ${wall.name}, so they'd never see it there.`);
    }
  }

  // Only prefix the handle when the message doesn't already carry it —
  // otherwise "tell brandon @brandon nice one" double-pings.
  const alreadyMentions = new RegExp(`(?<![A-Za-z0-9_])@${username}\\b`, 'i').test(message);
  const text = alreadyMentions ? message : `@${target.username} ${message}`;

  const post = walls.createPost(wall.slug, me.id, { kind: 'text', text_body: text });

  // Self-mentions: notifications.parseMentions deliberately skips the
  // author, so createPost wrote no mention row. Write it here so the
  // `{ ok, mentionId }` contract holds for "leave myself a note" — but
  // do NOT synthesize a notification, because notifying yourself about
  // something you just did is noise the rest of the system is careful
  // to avoid (emitForPost excludes the author for the same reason).
  let mentionRow = db.prepare(
    'SELECT id FROM mentions WHERE post_id = ? AND mentioned_user_id = ?'
  ).get(post.id, target.id);
  if (!mentionRow && isSelf) {
    const info = db.prepare(`
      INSERT INTO mentions (post_id, comment_id, mentioned_user_id, mentioned_by)
      VALUES (?, NULL, ?, ?)
    `).run(post.id, target.id, me.id);
    mentionRow = { id: info.lastInsertRowid };
  }

  const delivered = db.prepare(`
    SELECT COUNT(*) AS n FROM notification_log
    WHERE user_id = ? AND tag = ? AND skipped_reason IS NULL
  `).get(target.id, `wall_post:mention:${post.id}`).n;

  analytics.logEvent(db, {
    userId: me.id,
    kind: 'hearth_action_invoked',
    subjectType: 'wall_post',
    subjectId: post.id,
    meta: { action: 'mention_user', wall_slug: wall.slug, delivered, self: isSelf },
  });

  return {
    ok: true,
    mentionId: mentionRow ? mentionRow.id : null,
    delivered,
    postId: post.id,
    wallSlug: wall.slug,
    target: target.username,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions + dispatch
// ---------------------------------------------------------------------------
//
// TOOLS is the provider-facing shape: OpenAI-compatible function
// definitions, which is the wire all three configured providers speak
// (lib/agent-runtime.js's createProvider). `run` is the server-side
// implementation the runtime executes a tool_call against.
//
// `chip` renders the drawer's tool-result chip — "(✓ queued Part Two)".
// It lives beside the implementation on purpose: the thing that knows
// what happened is the thing that should phrase it, so a new action
// can't ship with a chip that describes the old one.

const TOOLS = Object.freeze([
  {
    name: 'enqueue_media',
    description:
      'Queue a movie, show, book or audiobook onto the user\'s watch-next list and announce it on their wall. '
      + 'Use when the user asks you to queue, save, add or line up something to watch, read or listen to.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: [...MEDIA_SOURCES],
          description: 'Which library the item lives in.',
        },
        id: {
          type: 'string',
          description: 'The item id in that library (Plex ratingKey, Kavita series id, Audiobookshelf item id).',
        },
        userMessage: {
          type: 'string',
          description: 'Optional short note from the user to include in the wall post.',
        },
      },
      required: ['source', 'id'],
    },
    run: enqueueMedia,
    chip: (r) => (r.alreadyQueued ? `already queued ${r.title}` : `queued ${r.title}`),
  },
  {
    name: 'mention_user',
    description:
      'Pass a message to another household member by @-mentioning them on a wall you both share. '
      + 'Use when the user asks you to tell, ping, remind or pass something along to someone.',
    parameters: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'The member\'s username, without the @.' },
        message: { type: 'string', description: 'What to say to them, in the user\'s voice.' },
        onWall: {
          type: 'string',
          description: 'Optional wall slug to post on, or "porch" for their default wall.',
        },
      },
      required: ['username', 'message'],
    },
    run: mentionUser,
    chip: (r) => (r.delivered
      ? `told @${r.target} (${r.delivered} notified)`
      : `posted for @${r.target} — notifications off, so no ping`),
  },
]);

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// toolSpecs(): the definitions only, safe to hand to a provider (drops
// `run`/`chip`, which are server-side).
function toolSpecs() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// execute(db, me, name, input) -> { ok: true, action, result, chip }
//                              | { ok: false, action, status, code, error, field }
//
// Never throws for a known failure mode. The runtime feeds the result
// back to the model as a tool result and the drawer renders a chip
// either way — an action that failed a permission check should say so
// in the conversation, not vanish. Unknown exceptions DO propagate:
// those are bugs, and swallowing them would let the model narrate a
// success that never happened.
function execute(db, me, name, input) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return { ok: false, action: name, status: 400, code: 'unknown_action', error: `unknown action "${name}"` };
  }
  try {
    const result = tool.run(db, me, input);
    return { ok: true, action: name, result, chip: tool.chip(result) };
  } catch (e) {
    if (e instanceof ActionInputError) {
      analytics.logEvent(db, {
        userId: me.id, kind: 'hearth_action_failed', subjectType: 'user', subjectId: String(me.id),
        meta: { action: name, code: e.code, field: e.field },
      });
      return { ok: false, action: name, status: e.status, code: e.code, error: e.message, field: e.field };
    }
    if (e instanceof ActionError) {
      analytics.logEvent(db, {
        userId: me.id, kind: 'hearth_action_failed', subjectType: 'user', subjectId: String(me.id),
        meta: { action: name, code: e.code },
      });
      return { ok: false, action: name, status: e.status, code: e.code, error: e.message };
    }
    throw e;
  }
}

module.exports = {
  MEDIA_SOURCES,
  MEDIA_SOURCE_NAMES,
  TOOLS,
  ActionInputError,
  ActionError,
  migrate,
  validateEnqueueMedia,
  validateMentionUser,
  defaultWallFor,
  sharedWalls,
  enqueueMedia,
  mentionUser,
  toolSpecs,
  execute,
};
