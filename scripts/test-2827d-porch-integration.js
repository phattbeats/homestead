#!/usr/bin/env node
// PHA-2831 (PHA-2827.D) + PHA-2844 acceptance tests: Hearth as a Porch
// citizen — character row + register weights + sweep integration, plus
// the real comprehension -> per-register draft -> decide -> post
// pipeline that closes the loop server.js's onDecision used to leave
// open.
//
// Exercises the full pipeline end-to-end: ensureBuiltinAgentUser seeds
// Hearth's built-in account + `characters` row (same seed path as
// PHA-2827.B) and backfills wall membership; lib/porch/sweep.js's
// listAgentUserIds() picks him up alongside any user-installed agent
// character; porchContract.resolveCharacter() reads his register
// weights straight off the `characters` table; decide() gates a
// register-weighted candidate and (on pass) an actual post_comment
// gets created through lib/walls.js, same as any agent.
//
// The early blocks below (character row, sweep, identity UI, banned
// lexicon, wall opt-out) still hand-inject candidates the way
// test/porch/participation-contract.test.mjs does — that's testing
// decide()'s gate logic in isolation, not the candidate-generation
// step, and hand-injection is the right tool for that. The PHA-2844
// block at the end is different: it exercises the REAL upstream
// pipeline — lib/porch/comprehension.js's buildComprehension() (real
// media upload + a stubbed vision describer, since no real vision
// network access exists in CI) feeding lib/agent-runtime.js's
// draftPorchCandidate() (a stubbed SSE fetchImpl, same seam
// dispatchHearth's own tests use) feeding porchContract.decide() —
// for one image post and one text-only post, with zero hand-built
// candidates.
//
// Same ephemeral-DATA_DIR boot pattern as scripts/test-porch-sweep.js
// and scripts/test-2647-identity-ui.js.

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

console.log('PHA-2831 (PHA-2827.D) Hearth-on-the-Porch integration tests\n');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-2827d-test-'));
process.env.DATA_DIR = tmpDataDir;

const userModel = require('../lib/user-model');
const media = require('../lib/media');
const walls = require('../lib/walls');
const analytics = require('../lib/analytics');
const agentTokens = require('../lib/agent-tokens');
const hearthCharacters = require('../lib/hearth-characters');
const porchContract = require('../lib/porch/participation-contract');
const sweep = require('../lib/porch/sweep');
const porchComprehension = require('../lib/porch/comprehension');
const agentRuntime = require('../lib/agent-runtime');
const express = require('express');

const dbPath = path.join(tmpDataDir, 'life.db');
const db = new Database(dbPath);
userModel.migrate(db);
media.migrate(db);
walls.migrate(db);
walls.seed(db);
// Mirrors scripts/test-porch-sweep.js / scripts/test-2647-identity-ui.js:
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
sweep.migrate(db);
hearthCharacters.migrate(db);

const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();

let userSeq = 0;
function mkUser(prefix) {
  userSeq += 1;
  const username = `${prefix}${userSeq}`;
  db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES (?, ?, '#111', 'x', 0)`)
    .run(username, username);
  return db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
}

function mkWall(slug) {
  return walls.createWall(db, admin.id, { slug, name: slug, visibility: 'direct' });
}

function addMember(slug, userId) {
  const username = db.prepare('SELECT username FROM users WHERE id = ?').get(userId).username;
  walls.adminAddMember(db, slug, admin.id, { username });
}

function mkPost(slug, authorId, text, createdAt) {
  const post = walls.createPost(slug, authorId, { kind: 'text', text_body: text });
  if (createdAt) {
    db.prepare('UPDATE wall_posts SET created_at = ? WHERE id = ?').run(sweep.toSqliteTimestamp(createdAt), post.id);
  }
  return db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(post.id);
}

// Stubbed SSE fetchImpl — same shape lib/agent-runtime.js's own
// createProvider() consumes, so draftPorchCandidate() runs its real
// parsing/streaming code against a canned single-chunk reply instead
// of a real network call. Every register in a given call gets the
// same reply text; the PHA-2844 pipeline tests pick reply text that
// deliberately contains one of the comprehension package's concrete
// refs so the specificity gate has something real to pass.
function fakeProviderCfg(replyText) {
  const sseBody = `data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: 'stop' }] })}\n\n`;
  return {
    provider: 'litellm',
    baseUrl: 'http://fake-litellm.invalid',
    apiKey: 'fake-key',
    model: 'fake-model',
    fetchImpl: async () => ({
      ok: true,
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { value: undefined, done: true };
              sent = true;
              return { value: Buffer.from(sseBody), done: false };
            },
          };
        },
      },
    }),
  };
}

// Real media upload through the same HTTP route production uses
// (lib/media.js's `upload`), so lib/porch/comprehension.js has an
// actual file on disk to build a comprehension package from — same as
// scripts/test-2644-media-context.js's pattern.
async function uploadTestPng(username) {
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const app = express();
  app.use((req, res, next) => { req.session = { user: { username } }; next(); });
  app.post('/api/media', media.upload);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const boundary = '----pha2844boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="loaf.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG_1X1,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  let uploaded;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    uploaded = await res.json();
  } finally {
    server.close();
  }
  return uploaded;
}

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const BASE_NOW = new Date('2026-08-30T12:00:00.000Z');

// ---- Setup: wall + human member + Hearth's built-in account ----
const slug = 'porch-2827d';
mkWall(slug);
const human = mkUser('household-member');
addMember(slug, human.id);

const hearthUserId = hearthCharacters.ensureBuiltinAgentUser(db);
const hearthUser = db.prepare('SELECT username FROM users WHERE id = ?').get(hearthUserId);

// ---- 1/2. Character row + register weights seeded from SOUL.md's seed path ----
console.log('character row + register weights');
{
  const character = hearthCharacters.getDefaultCharacter(db, hearthUserId);
  assert(!!character, 'Hearth built-in account has a default characters row');
  assertEq(character.character_key, 'hearth', 'character_key is hearth');
  assert(!!character.soul_source_sha, 'soul_source_sha recorded (same seed path as PHA-2827.B)');
  assert(!!character.intro_source_sha, 'intro_source_sha recorded');
  assertEq(
    JSON.parse(character.register_weights_json),
    hearthCharacters.SEED_DEFAULT_REGISTERS,
    'register_weights_json matches the SOUL.md-derived defaults'
  );

  const resolved = porchContract.resolveCharacter(db, hearthUserId);
  assert(!!resolved, 'participation-contract.resolveCharacter finds Hearth\'s row');
  assertEq(resolved.registerWeights, hearthCharacters.SEED_DEFAULT_REGISTERS,
    'resolveCharacter reads registerWeights straight off the characters table');
  assertEq(resolved.characterKey, 'hearth', 'resolveCharacter surfaces the character_key');

  assertEq(porchContract.resolveCharacter(db, human.id), null,
    'resolveCharacter returns null for an agent/user with no characters row');
}

// ---- 3. Sweep pipeline: Hearth is a built-in participant ----
console.log('\nsweep considers Hearth alongside user-installed agent characters');
{
  const ids = sweep.listAgentUserIds(db, BASE_NOW);
  assert(ids.includes(hearthUserId), 'listAgentUserIds() includes Hearth\'s built-in account');

  const agentUser = mkUser('installed-agent');
  agentTokens.issue(db, agentUser.id, { label: 'installed agent pat' });
  addMember(slug, agentUser.id);
  const idsWithBoth = sweep.listAgentUserIds(db, BASE_NOW);
  assert(idsWithBoth.includes(hearthUserId) && idsWithBoth.includes(agentUser.id),
    'listAgentUserIds() unions built-in and agent_tokens-derived agents');

  assert(!!db.prepare('SELECT 1 FROM wall_memberships wm JOIN walls w ON w.id = wm.wall_id WHERE w.slug = ? AND wm.user_id = ?').get(slug, hearthUserId),
    'ensureBuiltinAgentUser backfilled Hearth into the wall\'s membership');
}

// ---- 5. Identity UI: kind: 'built-in' discriminator ----
console.log('\nidentity UI — built-in discriminator, not connector:<spec_id>');
{
  assertEq(walls.isAgentUserId(hearthUserId), true, 'walls.isAgentUserId(hearth) === true');
  const view = walls.userView(hearthUserId);
  assertEq(view.isAgent, true, 'userView(hearth).isAgent === true');
  assertEq(view.kind, 'built-in', 'userView(hearth).kind === \'built-in\' (not connector:<spec_id>)');

  const humanView = walls.userView(human.id);
  assertEq(humanView.isAgent, false, 'userView(human).isAgent === false');
  assert(!('kind' in humanView), 'a human user view carries no kind field at all');
}

// ---- Comprehension + candidates (stand-in for the not-yet-built
// per-register LLM draft — same injection shape test/porch/
// participation-contract.test.mjs already uses) ----
const COMPREHENSION = {
  frames: [],
  captionNames: [],
  graphEntities: ['sourdough starter'],
  pastReactionRefs: [],
};

function candidatesReferencing(entity) {
  return [
    { register: 'sincere_question', text: `did the ${entity} actually rise this time?` },
    { register: 'callback', text: `still thinking about the ${entity} saga from last week` },
    { register: 'riff', text: `the ${entity} truly understood the assignment` },
    { register: 'lore_reference', text: `the ${entity} remembers everything` },
  ];
}

// ---- 6. Accept: sweep -> resolveCharacter -> decide -> post a comment ----
console.log('\naccept: sweep considers Hearth, register-weighted draft clears gates, posts a comment');
{
  const postCreated = new Date(BASE_NOW.getTime() - 5 * HOUR); // past the 4h grace window
  const post = mkPost(slug, human.id, 'watching the sourdough starter today', postCreated);

  const sweepResult = sweep.runSweep(db, { now: BASE_NOW });
  const decision = sweepResult.decisions.find((d) => d.agentUserId === hearthUserId && d.postId === post.id);
  assert(!!decision, 'runSweep() proposes a decision for Hearth on the new post');

  const character = porchContract.resolveCharacter(db, hearthUserId);
  const action = porchContract.decide(db, {
    wallId: decision.wallId,
    postId: decision.postId,
    agentUserId: hearthUserId,
    now: BASE_NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: candidatesReferencing('sourdough starter'),
  }, { rng: () => 0.01 });

  assert(action.action === 'post' || action.action === 'riff', 'decide() clears every gate and posts/riffs', JSON.stringify(action));
  assert(action.register !== 'roast', 'the chosen register is never roast (weight 0 in the SOUL.md seed)', action.register);

  const comment = walls.createComment(post.id, hearthUserId, action.text);
  sweep.recordAction(db, {
    wallId: decision.wallId, agentUserId: hearthUserId, postId: post.id,
    authorUserId: human.id, actionKind: 'comment', now: BASE_NOW,
  });

  const row = db.prepare('SELECT * FROM post_comments WHERE id = ?').get(comment.id);
  assertEq(row.author_user_id, hearthUserId, 'the comment is authored by Hearth\'s built-in account');

  const comments = walls.listComments(slug, post.id, human.id);
  const hearthComment = comments.find((c) => c.id === comment.id);
  assert(!!hearthComment && hearthComment.author.isAgent && hearthComment.author.kind === 'built-in',
    'listComments exposes Hearth\'s comment with isAgent + kind: built-in');
}

// ---- 4. Banned lexicon still applies — SOUL.md is additive, not a replacement ----
console.log('\nbanned lexicon: global list still gates Hearth (SOUL.md is additive, not a replacement)');
{
  const postCreated = new Date(BASE_NOW.getTime() - 5 * HOUR);
  const post = mkPost(slug, human.id, 'another sourdough starter update', postCreated);
  const character = porchContract.resolveCharacter(db, hearthUserId);
  const action = porchContract.decide(db, {
    wallId: db.prepare('SELECT id FROM walls WHERE slug = ?').get(slug).id,
    postId: post.id,
    agentUserId: hearthUserId,
    now: BASE_NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [{ register: 'sincere_question', text: 'great post, the sourdough starter really came through' }],
  });
  assertEq(action, { action: 'silent', reason: 'banned_lexicon' },
    'a banned-lexicon phrase is refused even though it references something concrete');
}

// ---- Negative: per-wall opt-out -> silence with wall_opt_out reason ----
console.log('\nnegative: per-wall opt-out silences Hearth (vote him off the porch)');
{
  const optOut = walls.setAgentWallVisibility(db, slug, hearthUser.username, false);
  assertEq(optOut, { ok: true, slug, username: hearthUser.username, visible: false },
    'setAgentWallVisibility(hearth, false) works — same API as any other agent');

  const agentsList = walls.listWallAgents(db, slug);
  const hearthEntry = agentsList.find((a) => a.username === hearthUser.username);
  assert(!!hearthEntry && hearthEntry.visible === false, 'listWallAgents shows Hearth as Off');

  // Past both SWEEP_INTERVAL_MINUTES (90m, so the wall is due again)
  // and AUTHOR_COOLDOWN_HOURS (6h, left over from the accept test's
  // recordAction on this same human author) — otherwise the cooldown
  // itself would explain the silence, not the opt-out.
  const nextNow = new Date(BASE_NOW.getTime() + 7 * HOUR);
  const postCreated = new Date(nextNow.getTime() - 5 * HOUR);
  // A fresh post (never yet considered by Hearth). sweep may instead
  // pick an older still-uncommented post from an earlier test block —
  // either way, find the decision by agent, not by this specific post.
  mkPost(slug, human.id, 'a third sourdough starter update', postCreated);

  const sweepResult = sweep.runSweep(db, { now: nextNow });
  const decision = sweepResult.decisions.find((d) => d.agentUserId === hearthUserId);
  assert(!!decision, 'sweep still proposes a WHEN decision for an opted-out agent (silence is the contract\'s job, not sweep\'s)');

  const character = porchContract.resolveCharacter(db, hearthUserId);
  const action = porchContract.decide(db, {
    wallId: decision.wallId,
    postId: decision.postId,
    agentUserId: hearthUserId,
    now: nextNow,
    character,
    comprehension: COMPREHENSION,
    candidates: candidatesReferencing('sourdough starter'),
  });
  assertEq(action, { action: 'silent', reason: 'wall_opt_out' }, 'decide() is silent with reason wall_opt_out');

  const commentsBefore = db.prepare('SELECT COUNT(*) c FROM post_comments WHERE post_id = ?').get(decision.postId).c;
  assertEq(commentsBefore, 0, 'no comment was posted for the opted-out decision');

  const optIn = walls.setAgentWallVisibility(db, slug, hearthUser.username, true);
  assertEq(optIn.visible, true, 'voting Hearth back onto the porch clears the opt-out');
}

(async () => {
  // ---- PHA-2844: real pipeline, image post — comprehension (real
  // upload + stubbed vision) -> per-register draft (stubbed LLM) ->
  // decide -> post. No hand-injected candidates anywhere below. ----
  console.log('\nPHA-2844: real pipeline end-to-end — image post');
  {
    const uploaded = await uploadTestPng(human.username);
    assert(!!uploaded && !!uploaded.id, 'test PNG uploaded through the real lib/media.js route', JSON.stringify(uploaded));

    const imgPost = walls.createPost(slug, human.id, { kind: 'image', media_id: uploaded.id });
    const postCreated = new Date(BASE_NOW.getTime() + 20 * HOUR - 5 * HOUR);
    db.prepare('UPDATE wall_posts SET created_at = ? WHERE id = ?').run(sweep.toSqliteTimestamp(postCreated), imgPost.id);
    const imgPostRow = db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(imgPost.id);

    porchComprehension.__test__.setFrameDescriber(async () => ({
      frames: ['a golden loaf resting on a cutting board'],
      captionNames: ['golden loaf', 'cutting board'],
      graphEntities: ['sourdough starter'],
    }));

    const comprehension = await porchComprehension.buildComprehension(db, { post: imgPostRow, agentUserId: hearthUserId });
    porchComprehension.__test__.resetFrameDescriber();
    assert(comprehension.frames.includes('a golden loaf resting on a cutting board'),
      'buildComprehension() surfaces the (stubbed) vision description for a real uploaded image');
    assert(comprehension.graphEntities.includes('sourdough starter'),
      'buildComprehension() surfaces the (stubbed) vision entity extraction');

    const character = porchContract.resolveCharacter(db, hearthUserId);
    const allowed = porchContract.allowedRegisters(character, false);
    const draftReply = 'still can\'t get over that cutting board moment, an instant classic';
    const drafts = await Promise.all(allowed.map((register) => agentRuntime.draftPorchCandidate({
      comprehension,
      register,
      postText: imgPostRow.text_body || '',
      providerCfg: fakeProviderCfg(draftReply),
    })));
    const candidates = drafts.filter((d) => d && d.ok && d.text).map((d) => ({ register: d.register, text: d.text }));
    assert(candidates.length === allowed.length, 'draftPorchCandidate() (stubbed LLM) produced a real candidate for every allowed register');

    const action = porchContract.decide(db, {
      wallId: db.prepare('SELECT id FROM walls WHERE slug = ?').get(slug).id,
      postId: imgPost.id,
      agentUserId: hearthUserId,
      now: new Date(BASE_NOW.getTime() + 21 * HOUR),
      character,
      comprehension,
      candidates,
    });
    assert(action.action === 'post' || action.action === 'riff',
      'decide() clears every gate for the real image pipeline output', JSON.stringify(action));

    const comment = walls.createComment(imgPost.id, hearthUserId, action.text);
    const row = db.prepare('SELECT * FROM post_comments WHERE id = ?').get(comment.id);
    assertEq(row.author_user_id, hearthUserId,
      'a real post_comment row exists for the image post — comprehension->candidate->decide->post, zero hand-injected candidates');
  }

  // ---- PHA-2844: real pipeline, text-only post — comprehension is
  // derived straight from the post text (no LLM call at all) -> per-
  // register draft (stubbed LLM) -> decide -> post. ----
  console.log('\nPHA-2844: real pipeline end-to-end — text-only post');
  {
    const textPost = mkPost(slug, human.id, 'the Kowalski twins built a blanket fort in the living room',
      new Date(BASE_NOW.getTime() + 22 * HOUR - 5 * HOUR));

    const comprehension = await porchComprehension.buildComprehension(db, { post: textPost, agentUserId: hearthUserId });
    assert(comprehension.frames.length === 0, 'a text-only post carries no frames');
    assert(comprehension.graphEntities.some((e) => e.includes('kowalski')),
      'text-only comprehension derives a proper-noun entity straight from the post text, no LLM call');
    assert(comprehension.captionNames.includes('blanket'),
      'text-only comprehension derives significant words straight from the post text');

    const character = porchContract.resolveCharacter(db, hearthUserId);
    const allowed = porchContract.allowedRegisters(character, false);
    const draftReply = 'a blanket fort built with the seriousness of a load-bearing wall';
    const drafts = await Promise.all(allowed.map((register) => agentRuntime.draftPorchCandidate({
      comprehension,
      register,
      postText: textPost.text_body,
      providerCfg: fakeProviderCfg(draftReply),
    })));
    const candidates = drafts.filter((d) => d && d.ok && d.text).map((d) => ({ register: d.register, text: d.text }));
    assert(candidates.length === allowed.length, 'draftPorchCandidate() (stubbed LLM) produced a real candidate for every allowed register (text-only)');

    const action = porchContract.decide(db, {
      wallId: db.prepare('SELECT id FROM walls WHERE slug = ?').get(slug).id,
      postId: textPost.id,
      agentUserId: hearthUserId,
      now: new Date(BASE_NOW.getTime() + 23 * HOUR),
      character,
      comprehension,
      candidates,
    });
    assert(action.action === 'post' || action.action === 'riff',
      'decide() clears every gate for the real text-only pipeline output', JSON.stringify(action));

    const comment = walls.createComment(textPost.id, hearthUserId, action.text);
    const row = db.prepare('SELECT * FROM post_comments WHERE id = ?').get(comment.id);
    assertEq(row.author_user_id, hearthUserId,
      'a real post_comment row exists for the text-only post — comprehension->candidate->decide->post, zero hand-injected candidates');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('PHA-2844 pipeline test crashed:', e);
  process.exit(1);
});
