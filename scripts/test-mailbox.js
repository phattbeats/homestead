#!/usr/bin/env node
// PHA-2426 acceptance tests for lib/porch/mailbox.js: the message
// table's core write path, chatter-budget + per-thread turn-limit
// enforcement, and the structural "every message has a Porch post"
// invariant (rule 3 — no hidden DM layer). Same boot pattern as
// scripts/test-porch-sweep.js (ephemeral DATA_DIR, migrate the
// primitives the module sits on top of, then drive it directly).
//
// "Foreign harness" is simulated exactly as PHA-2201 models it: an
// installed_apps row + an app-scoped agent_tokens row carrying
// read:mailbox/write:mailbox — there is no separate agent registry to
// fake (same fixture shape as scripts/test-agent-endpoints.js's
// "Laptop OpenClaw" label, just via the real installed-app path).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assertThrowsCode(fn, expectedCode, label) {
  try {
    fn();
    ng(label, 'did not throw');
  } catch (err) {
    if (err.code === expectedCode) ok(label);
    else ng(label, `expected code ${expectedCode}, got ${err.code || err.message}`);
  }
}

console.log('PHA-2426 mailbox tests\n');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-mailbox-test-'));
process.env.DATA_DIR = tmpDataDir;

const userModel = require('../lib/user-model');
const media = require('../lib/media');
const walls = require('../lib/walls');
const analytics = require('../lib/analytics');
const agentTokens = require('../lib/agent-tokens');
const mailbox = require('../lib/porch/mailbox');

const dbPath = path.join(tmpDataDir, 'life.db');
const db = new Database(dbPath);
userModel.migrate(db);
agentTokens.migrate(db);
media.migrate(db);
walls.migrate(db);
walls.seed(db);
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    tag TEXT,
    delivered INTEGER NOT NULL DEFAULT 0,
    skipped_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
analytics.migrate(db);
mailbox.migrate(db);

const brandon = userModel.provisionOrClaim(db, 'brandon', 'header_trust', 'brandon', ['household']);
const householdWall = db.prepare("SELECT id FROM walls WHERE slug = 'household'").get();

db.prepare(`INSERT INTO installed_apps (key, name, installed_by_user_id) VALUES (?, ?, ?)`)
  .run('tylers_agent', "Tyler's Household Agent", brandon.id);
const foreignToken = agentTokens.issue(db, brandon.id, {
  label: "Tyler's Household Agent",
  scopes: JSON.stringify(['read:mailbox', 'write:mailbox']),
  appId: 'tylers_agent',
});

function wallPostCount() {
  return db.prepare('SELECT COUNT(*) c FROM wall_posts').get().c;
}

// ---- 1. inbound message: thread creation + Porch mirror ----
{
  const before = wallPostCount();
  const msg = mailbox.postMessage(db, {
    appId: 'tylers_agent',
    localUserId: brandon.id,
    threadKey: 'movie-night',
    topic: 'movie night',
    direction: 'inbound',
    fromIdentity: "Tyler's Household Agent",
    body: 'Want to do movie night Friday at 7?',
  });
  assert(!!msg.id, 'inbound postMessage returns a message id');
  assertEq(msg.trust, 'untrusted_external', 'inbound message is tagged untrusted_external');
  assert(wallPostCount() === before + 1, 'inbound message mirrors exactly one Porch post');
  const wallPost = db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(msg.wallPostId);
  assert(!!wallPost, 'mailbox message references a real wall_posts row');
  assert(wallPost.text_body.includes('untrusted'), 'Porch mirror text carries the untrusted-external marker');
  assert(wallPost.text_body.includes('Want to do movie night'), 'Porch mirror text includes the message body');
}

// ---- 2. outbound reply in the same thread ----
{
  const threadId = mailbox.threadId('tylers_agent', 'movie-night');
  const before = wallPostCount();
  const reply = mailbox.postMessage(db, {
    appId: 'tylers_agent',
    localUserId: brandon.id,
    threadKey: 'movie-night',
    topic: 'movie night',
    direction: 'outbound',
    fromIdentity: 'local:brandon',
    body: 'Friday works, 7pm.',
  });
  assertEq(reply.trust, 'household_authored', 'outbound reply is tagged household_authored');
  assert(wallPostCount() === before + 1, 'outbound reply also mirrors exactly one Porch post');
  const thread = mailbox.getThread(db, threadId);
  assertEq(thread.turn_count, 2, 'thread turn_count accumulates across both directions');
}

// ---- 3. validation ----
{
  assertThrowsCode(() => mailbox.postMessage(db, { localUserId: brandon.id, threadKey: 'x', topic: 't', direction: 'inbound', fromIdentity: 'x', body: 'y' }),
    'app_id_required', 'postMessage rejects missing appId');
  assertThrowsCode(() => mailbox.postMessage(db, { appId: 'tylers_agent', localUserId: brandon.id, threadKey: 'x', topic: 't', direction: 'sideways', fromIdentity: 'x', body: 'y' }),
    'invalid_direction', 'postMessage rejects an invalid direction');
  assertThrowsCode(() => mailbox.postMessage(db, { appId: 'tylers_agent', localUserId: brandon.id, threadKey: 'x', topic: 't', direction: 'inbound', fromIdentity: 'x', body: '   ' }),
    'body_required', 'postMessage rejects a blank body');
}

// ---- 4. per-thread turn limit ----
{
  const cfg = { MAX_TURNS_PER_THREAD: 2 };
  assertThrowsCode(() => mailbox.postMessage(db, {
    appId: 'tylers_agent', localUserId: brandon.id, threadKey: 'movie-night', topic: 'movie night',
    direction: 'inbound', fromIdentity: "Tyler's Household Agent", body: 'One more thing —', config: cfg,
  }), 'thread_turn_limit_reached', 'a thread already at its turn cap rejects a further message');
}

// ---- 5. chatter (per-app) budget ----
{
  const cfg = { MAX_MESSAGES_PER_WINDOW: 2, WINDOW_MINUTES: 60 };
  // The 2 messages from tests 1-2 already spent this app's budget.
  assertThrowsCode(() => mailbox.postMessage(db, {
    appId: 'tylers_agent', localUserId: brandon.id, threadKey: 'grocery-swap', topic: 'grocery run',
    direction: 'inbound', fromIdentity: "Tyler's Household Agent", body: 'Can you grab milk?', config: cfg,
  }), 'chatter_budget_exceeded', 'an app over its rolling-window message cap is rejected on a brand new thread too');
}

// ---- 6. listThreads scoping ----
{
  const appScoped = mailbox.listThreads(db, { appId: 'tylers_agent' });
  assertEq(appScoped.length, 1, 'listThreads scoped by appId returns only that app\'s thread');
  const householdScoped = mailbox.listThreads(db, { localUserId: brandon.id });
  assertEq(householdScoped.length, 1, 'listThreads scoped by localUserId returns the same thread');
}

// ---- 7. listMessages + markRead ----
{
  const threadId = mailbox.threadId('tylers_agent', 'movie-night');
  const messages = mailbox.listMessages(db, threadId, {});
  assertEq(messages.length, 2, 'listMessages returns both turns in chronological order');
  assertEq(messages[0].direction, 'inbound', 'first message in the thread is the inbound one');
  mailbox.markRead(db, messages.map((m) => m.id), 'app:tylers_agent');
  const reread = mailbox.listMessages(db, threadId, {});
  assert(reread.every((m) => m.readBy.includes('app:tylers_agent')), 'markRead is reflected on the next read');
  const sinceFirst = mailbox.listMessages(db, threadId, { sinceId: messages[0].id });
  assertEq(sinceFirst.length, 1, 'sinceId cursor excludes already-seen messages');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmpDataDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
