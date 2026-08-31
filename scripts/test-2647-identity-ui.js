#!/usr/bin/env node
// PHA-2647 acceptance tests for the Porch agent-identity backend
// primitives: derived isAgent on post/comment authors, the wall-level
// "vote off the porch" toggle (list/opt-out/opt-in), the feed/comments
// hiding that toggle drives, and the identity.js collision-suffix
// helper for agent handle provisioning. Same ephemeral-DATA_DIR boot
// pattern as scripts/test-porch-sweep.js.

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

console.log('PHA-2647 Porch identity UI backend tests\n');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-2647-test-'));
process.env.DATA_DIR = tmpDataDir;

const userModel = require('../lib/user-model');
const identity = require('../lib/identity');
const media = require('../lib/media');
const walls = require('../lib/walls');
const analytics = require('../lib/analytics');
const agentTokens = require('../lib/agent-tokens');
const porchContract = require('../lib/porch/participation-contract');

const dbPath = path.join(tmpDataDir, 'life.db');
const db = new Database(dbPath);
userModel.migrate(db);
identity.migrate(db);
media.migrate(db);
walls.migrate(db);
walls.seed(db);
// Mirrors scripts/test-walls.js / scripts/test-porch-sweep.js:
// notification_log is declared inline in server.js too, so tests that
// skip server.js need it themselves before analytics fires.
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
agentTokens.migrate(db);
porchContract.migrate(db);

const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();

let userSeq = 0;
function mkUser(prefix) {
  userSeq += 1;
  const username = `${prefix}${userSeq}`;
  db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES (?, ?, '#111', 'x', 0)`)
    .run(username, username);
  return db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
}
function mkAgent(prefix) {
  const u = mkUser(prefix);
  agentTokens.issue(db, u.id, { label: `${prefix} pat` });
  return u;
}
function addMember(slug, userId) {
  const username = db.prepare('SELECT username FROM users WHERE id = ?').get(userId).username;
  walls.adminAddMember(db, slug, admin.id, { username });
}

// ---- identity.js: agent handle collision suffixing ----
console.log('resolveAgentHandle / createAgentUser');
{
  identity.createUser(db, { username: 'brandon2647' });
  assertEq(identity.resolveAgentHandle(db, 'brandon2647'), 'brandon2647-agent',
    'taken handle gets -agent suffix');
  assertEq(identity.resolveAgentHandle(db, 'freshhandle2647'), 'freshhandle2647',
    'free handle is returned as-is');

  identity.createUser(db, { username: 'brandon2647-agent' });
  assertEq(identity.resolveAgentHandle(db, 'brandon2647'), 'brandon2647-agent-2',
    'second collision gets numeric disambiguation');

  const created = identity.createAgentUser(db, { username: 'brandon2647' });
  assertEq(created.username, 'brandon2647-agent-2', 'createAgentUser never throws on collision');
  const humanRow = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon2647');
  assert(!!humanRow, 'the original human handle is untouched (human wins)');

  const longBase = 'a'.repeat(32);
  identity.createUser(db, { username: longBase });
  const disambiguated = identity.resolveAgentHandle(db, longBase);
  assert(disambiguated.length <= 32, 'disambiguated handle respects the 32-char username limit', disambiguated);
}

// ---- lib/walls.js: derived isAgent on post/comment authors ----
console.log('\nisAgent flows through post/comment authors');
{
  const household = db.prepare("SELECT id FROM walls WHERE slug = 'household'").get();
  const humanA = mkUser('human');
  const agentA = mkAgent('agentuser');
  db.prepare('INSERT INTO user_groups (user_id, group_id) SELECT ?, id FROM groups WHERE name = ?').run(humanA.id, 'household');
  db.prepare('INSERT INTO user_groups (user_id, group_id) SELECT ?, id FROM groups WHERE name = ?').run(agentA.id, 'household');

  const humanPost = walls.createPost('household', humanA.id, { kind: 'text', text_body: 'hello from a human' });
  const agentPost = walls.createPost('household', agentA.id, { kind: 'text', text_body: 'hello from an agent (specific ref)' });

  assertEq(humanPost.author.isAgent, false, 'human post author.isAgent === false');
  assertEq(agentPost.author.isAgent, true, 'agent post author.isAgent === true');

  const feed = walls.postsForWall('household', humanA.id, null, 20);
  const feedAgentPost = feed.find((p) => p.id === agentPost.id);
  assertEq(feedAgentPost.author.isAgent, true, 'postsForWall exposes isAgent on the agent post');

  const humanComment = walls.createComment(humanPost.id, humanA.id, 'nice post');
  const agentComment = walls.createComment(humanPost.id, agentA.id, 'agreed, specific detail');
  assertEq(humanComment.author.isAgent, false, 'human comment author.isAgent === false');
  assertEq(agentComment.author.isAgent, true, 'agent comment author.isAgent === true');

  const comments = walls.listComments('household', humanPost.id, humanA.id);
  assert(comments.some((c) => c.id === agentComment.id && c.author.isAgent), 'listComments exposes isAgent on the agent comment');
}

// ---- lib/walls.js + lib/porch/participation-contract.js: vote off the porch ----
console.log('\nvote off the porch — wall-level opt-out hides feed + comments, reversibly');
{
  const slug = 'household';
  const human = mkUser('voter');
  const agent = mkAgent('votee');
  db.prepare('INSERT INTO user_groups (user_id, group_id) SELECT ?, id FROM groups WHERE name = ?').run(human.id, 'household');
  db.prepare('INSERT INTO user_groups (user_id, group_id) SELECT ?, id FROM groups WHERE name = ?').run(agent.id, 'household');

  const agentPost = walls.createPost(slug, agent.id, { kind: 'text', text_body: 'agent post before vote-off' });
  const humanPost = walls.createPost(slug, human.id, { kind: 'text', text_body: 'human post, unaffected' });
  const agentComment = walls.createComment(humanPost.id, agent.id, 'agent comment before vote-off');

  let agentsList = walls.listWallAgents(db, slug);
  const entry = agentsList.find((a) => a.username === agent.username);
  assert(!!entry && entry.visible === true, 'listWallAgents shows the agent as visible before opt-out');

  const optOutResult = walls.setAgentWallVisibility(db, slug, agent.username, false);
  assertEq(optOutResult, { ok: true, slug, username: agent.username, visible: false }, 'setAgentWallVisibility(false) returns the expected shape');

  let feed = walls.postsForWall(slug, human.id, null, 20);
  assert(!feed.some((p) => p.id === agentPost.id), 'opted-out agent post disappears from the feed');
  assert(feed.some((p) => p.id === humanPost.id), 'human post is unaffected by the agent opt-out');

  let comments = walls.listComments(slug, humanPost.id, human.id);
  assert(!comments.some((c) => c.id === agentComment.id), 'opted-out agent comment disappears too');

  agentsList = walls.listWallAgents(db, slug);
  assertEq(agentsList.find((a) => a.username === agent.username).visible, false, 'listWallAgents now shows the agent as Off');

  const optInResult = walls.setAgentWallVisibility(db, slug, agent.username, true);
  assertEq(optInResult.visible, true, 'setAgentWallVisibility(true) clears the opt-out');

  feed = walls.postsForWall(slug, human.id, null, 20);
  assert(feed.some((p) => p.id === agentPost.id), 'toggling back on brings the agent post back');
  comments = walls.listComments(slug, humanPost.id, human.id);
  assert(comments.some((c) => c.id === agentComment.id), 'toggling back on brings the agent comment back');

  agentsList = walls.listWallAgents(db, slug);
  assertEq(agentsList.find((a) => a.username === agent.username).visible, true, 'listWallAgents shows the agent as visible again');
}

// ---- guardrails ----
console.log('\nguardrails');
{
  try {
    walls.setAgentWallVisibility(db, 'household', mkUser('nonagent').username, false);
    ng('setAgentWallVisibility rejects a non-agent user', 'did not throw');
  } catch (e) {
    assertEq(e.status, 400, 'setAgentWallVisibility rejects a non-agent user');
    assertEq(e.code, 'not_an_agent', 'error code is not_an_agent');
  }
  try {
    walls.setAgentWallVisibility(db, 'household', 'no-such-user-2647', false);
    ng('setAgentWallVisibility 404s on an unknown username', 'did not throw');
  } catch (e) {
    assertEq(e.status, 404, 'setAgentWallVisibility 404s on an unknown username');
  }
  try {
    walls.listWallAgents(db, 'no-such-wall-2647');
    ng('listWallAgents 404s on an unknown wall', 'did not throw');
  } catch (e) {
    assertEq(e.status, 404, 'listWallAgents 404s on an unknown wall');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
