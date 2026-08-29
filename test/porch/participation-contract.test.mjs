// PHA-2645 unit tests for lib/porch/participation-contract.js.
//
// Node's built-in test runner (Node 24+; no extra devDependency): run
// with `node --test test/porch/` or, for coverage,
// `node --test --experimental-test-coverage test/porch/`.
//
// Uses an in-memory better-sqlite3 db per test. FK enforcement is
// turned off (this build defaults it on) so the porch_* tables'
// REFERENCES clauses stay documentation-only here — production's db
// has real users/walls/wall_posts tables (see server.js); recreating
// those just to satisfy FK checks would make this a walls.js
// integration test instead of a contract unit test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as pc from '../../lib/porch/participation-contract.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  pc.migrate(db);
  return db;
}

const NOW = new Date('2026-08-29T12:00:00.000Z');

const COMPREHENSION = {
  frames: ['frame_003'],
  captionNames: ['Steve'],
  graphEntities: ['The Matrix'],
  pastReactionRefs: [],
};

function baseCharacter(overrides) {
  return {
    registerWeights: { roast: 3, riff: 2, callback: 1, sincere_question: 1, lore_reference: 1, plain_emoji: 1 },
    isForeignAgent: false,
    ...overrides,
  };
}

// ---- 1. Specificity gate ----

test('specificity gate: passes when text references a concrete comprehension detail', () => {
  assert.equal(pc.hasSpecificity('Steve really committed to that bit in frame_003', COMPREHENSION), true);
  assert.equal(pc.hasSpecificity('this reminds me of The Matrix', COMPREHENSION), true);
});

test('specificity gate: fails for generic abstract text with no concrete reference', () => {
  assert.equal(pc.hasSpecificity('wow amazing content right there', COMPREHENSION), false);
  assert.equal(pc.hasSpecificity('', COMPREHENSION), false);
});

test('decide(): abstract candidate is refused (not_specific), concrete candidate posts', () => {
  const db = freshDb();
  const abstract = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter(),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'wow what a moment' }],
  }, { rng: () => 0 });
  assert.deepEqual(abstract, { action: 'silent', reason: 'not_specific' });

  const concrete = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter(),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve really out here in frame_003' }],
  }, { rng: () => 0 });
  assert.equal(concrete.action, 'post');
  assert.equal(concrete.register, 'roast');
});

test('decide(): plain_emoji register is exempt from the specificity gate', () => {
  const db = freshDb();
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter({ registerWeights: { plain_emoji: 1 } }),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'plain_emoji', text: '😂' }],
  }, { rng: () => 0 });
  assert.deepEqual(result, { action: 'post', register: 'plain_emoji', text: '😂' });
});

// ---- 2. Banned lexicon (+ hot-reload) ----

test('containsBannedPhrase: case/punctuation-insensitive substring match', () => {
  const lexicon = ['great post'];
  assert.equal(pc.containsBannedPhrase('GREAT POST!!', lexicon), 'great post');
  assert.equal(pc.containsBannedPhrase('Steve, that was a great post honestly', lexicon), 'great post');
  assert.equal(pc.containsBannedPhrase('Steve nailed the bit in frame_003', lexicon), null);
});

test('decide(): candidate matching the repo-tracked banned.json is refused', () => {
  const db = freshDb();
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter({ registerWeights: { sincere_question: 1 } }),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'sincere_question', text: 'Steve, great post, what happened in frame_003?' }],
  }, { rng: () => 0 });
  assert.deepEqual(result, { action: 'silent', reason: 'banned_lexicon' });
});

test('banned lexicon hot-reload: edits to the file take effect without a restart', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-lexicon-test-'));
  const tmpFile = path.join(tmpDir, 'banned.json');

  fs.writeFileSync(tmpFile, JSON.stringify({ phrases: ['love this'] }));
  fs.utimesSync(tmpFile, new Date(1000), new Date(1000));
  let lexicon = pc.getLexicon({ filePath: tmpFile });
  assert.deepEqual(lexicon, ['love this']);
  assert.ok(pc.containsBannedPhrase('I love this so much', lexicon));

  // Same content, no reload needed — mtime cache should short-circuit re-parsing.
  const sameLexicon = pc.getLexicon({ filePath: tmpFile });
  assert.deepEqual(sameLexicon, lexicon);

  fs.writeFileSync(tmpFile, JSON.stringify({ phrases: ['totally different phrase'] }));
  fs.utimesSync(tmpFile, new Date(2000), new Date(2000));
  lexicon = pc.getLexicon({ filePath: tmpFile });
  assert.deepEqual(lexicon, ['totally different phrase']);
  assert.equal(pc.containsBannedPhrase('I love this so much', lexicon), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getLexicon: missing file returns empty list instead of throwing', () => {
  const lexicon = pc.getLexicon({ filePath: '/nonexistent/path/does-not-exist.json' });
  assert.deepEqual(lexicon, []);
});

test('watchLexicon: fires the log callback when the file changes, and stop() is idempotent-safe', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-lexicon-watch-'));
  const tmpFile = path.join(tmpDir, 'banned.json');
  fs.writeFileSync(tmpFile, JSON.stringify({ phrases: ['alpha'] }));

  const logs = [];
  const watcher = pc.watchLexicon({ filePath: tmpFile, log: (msg) => logs.push(msg) });

  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.writeFileSync(tmpFile, JSON.stringify({ phrases: ['alpha', 'beta'] }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  watcher.stop();
  assert.ok(logs.length >= 1, `expected at least one reload log, got ${JSON.stringify(logs)}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- 3. Register weights per SOUL ----

test('weightedRegisterOrder: zero draw picks the front of the cumulative distribution', () => {
  const weights = { roast: 3, riff: 1 };
  const order = pc.weightedRegisterOrder(weights, ['roast', 'riff'], () => 0);
  assert.equal(order[0], 'roast');
});

test('weightedRegisterOrder: draw past the heavy register\'s share picks the lighter one', () => {
  const weights = { roast: 3, riff: 1 };
  // total=4; roast covers [0,0.75), riff covers [0.75,1)
  const order = pc.weightedRegisterOrder(weights, ['roast', 'riff'], () => 0.9);
  assert.equal(order[0], 'riff');
  assert.equal(order[1], 'roast'); // fallback order, heaviest-first
});

test('weightedRegisterOrder: all-zero weights still returns every available register', () => {
  const order = pc.weightedRegisterOrder({}, ['roast', 'riff', 'callback'], () => 0.5);
  assert.equal(order.length, 3);
  assert.deepEqual(new Set(order), new Set(['roast', 'riff', 'callback']));
});

test('decide(): register with more SOUL weight is preferred when both have valid candidates', () => {
  const db = freshDb();
  const character = baseCharacter({ registerWeights: { roast: 9, sincere_question: 1 } });
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [
      { register: 'roast', text: 'Steve, frame_003 is a crime scene' },
      { register: 'sincere_question', text: 'Steve, what was happening in frame_003?' },
    ],
  }, { rng: () => 0.05 }); // low draw -> lands in roast's large share
  assert.equal(result.action, 'post');
  assert.equal(result.register, 'roast');
});

test('decide(): falls back to the next-heaviest register when the top pick fails a gate', () => {
  const db = freshDb();
  const character = baseCharacter({ registerWeights: { roast: 9, sincere_question: 1 } });
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [
      { register: 'roast', text: 'great post honestly' }, // banned lexicon -> fails
      { register: 'sincere_question', text: 'Steve, what was happening in frame_003?' },
    ],
  }, { rng: () => 0.05 });
  assert.equal(result.action, 'post');
  assert.equal(result.register, 'sincere_question');
});

// ---- 4. Silence is first-class ----

test('decide(): no candidates at all -> silent with reason no_candidates', () => {
  const db = freshDb();
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter(),
    comprehension: COMPREHENSION,
    candidates: [],
  });
  assert.deepEqual(result, { action: 'silent', reason: 'no_candidates' });
});

test('decide(): every candidate fails its gate -> silent with the last gate\'s reason', () => {
  const db = freshDb();
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter({ registerWeights: { roast: 1 } }),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'this is amazing' }], // banned lexicon
  }, { rng: () => 0 });
  assert.deepEqual(result, { action: 'silent', reason: 'banned_lexicon' });
});

test('decide() throws without a character record (no global fallback table)', () => {
  const db = freshDb();
  assert.throws(() => pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW, candidates: [],
  }), /character record is required/);
});

// ---- 5. Foreign-agent restriction (PHA-2426) ----

test('allowedRegisters: foreign agents are limited to sincere_question, callback, plain_emoji', () => {
  const character = baseCharacter({ isForeignAgent: true });
  const allowed = pc.allowedRegisters(character, true);
  assert.deepEqual(new Set(allowed), new Set(pc.FOREIGN_AGENT_ALLOWED_REGISTERS));
});

test('decide(): foreign agent\'s roast candidate is refused even with a heavy roast weight and valid content', () => {
  const db = freshDb();
  const character = { registerWeights: { roast: 9 }, isForeignAgent: true };
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 42, now: NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is rough' }],
  });
  assert.deepEqual(result, { action: 'silent', reason: 'no_allowed_registers' });
});

test('decide(): foreign agent with a mixed SOUL still refuses a disallowed-register candidate (no_candidates, not no_allowed_registers)', () => {
  const db = freshDb();
  const character = { registerWeights: { roast: 5, callback: 1 }, isForeignAgent: true };
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 42, now: NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is rough' }], // only a roast candidate offered
  });
  assert.deepEqual(result, { action: 'silent', reason: 'no_candidates' });
});

test('decide(): foreign agent\'s sincere_question candidate is allowed', () => {
  const db = freshDb();
  const character = { registerWeights: { sincere_question: 1 }, isForeignAgent: true };
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 42, now: NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [{ register: 'sincere_question', text: 'Steve, what happened in frame_003?' }],
  }, { rng: () => 0 });
  assert.equal(result.action, 'post');
  assert.equal(result.register, 'sincere_question');
});

// ---- 6. Banter memory (provenance + dedupe) ----

test('isDuplicateBit: same normalized text from the same agent within the lookback window is a duplicate', () => {
  const db = freshDb();
  pc.recordBanterMemory(db, {
    agentUserId: 1, wallId: 'w1', postId: 'p1', register: 'roast', text: 'Steve, frame_003 strikes again!',
  }, NOW);
  assert.equal(pc.isDuplicateBit(db, 1, 'steve frame_003 strikes again', NOW), true);
  assert.equal(pc.isDuplicateBit(db, 1, 'an entirely different bit about frame_003', NOW), false);
  assert.equal(pc.isDuplicateBit(db, 2, 'Steve, frame_003 strikes again!', NOW), false); // different agent
});

test('decide(): repeating a prior bit verbatim is refused as repeated_bit', () => {
  const db = freshDb();
  const character = baseCharacter({ registerWeights: { roast: 1 } });
  const first = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character, comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is unhinged' }],
  }, { rng: () => 0 });
  assert.equal(first.action, 'post');

  const second = pc.decide(db, {
    wallId: 'w1', postId: 'p2', agentUserId: 1, now: NOW,
    character, comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is unhinged' }],
  }, { rng: () => 0 });
  assert.deepEqual(second, { action: 'silent', reason: 'repeated_bit' });
});

test('decide(): a valid callbackRef to the agent\'s own prior reaction is first-class (riff)', () => {
  const db = freshDb();
  const character = baseCharacter({ registerWeights: { callback: 1 } });
  const first = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter({ registerWeights: { roast: 1 } }),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is a whole saga' }],
  }, { rng: () => 0 });
  assert.equal(first.action, 'post');

  const priorReactionId = db.prepare('SELECT id FROM porch_agent_reactions WHERE agent_user_id = 1').get().id;

  const riff = pc.decide(db, {
    wallId: 'w1', postId: 'p2', agentUserId: 1, now: NOW,
    character,
    comprehension: COMPREHENSION,
    candidates: [{ register: 'callback', text: 'still thinking about frame_003, part two', callbackRef: priorReactionId }],
  }, { rng: () => 0 });
  assert.equal(riff.action, 'riff');
  assert.equal(riff.callbackRef, priorReactionId);
});

test('decide(): callback register without a resolvable callbackRef is refused as invalid_callback', () => {
  const db = freshDb();
  const character = baseCharacter({ registerWeights: { callback: 1 } });
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character, comprehension: COMPREHENSION,
    candidates: [{ register: 'callback', text: 'still thinking about frame_003', callbackRef: 'does-not-exist' }],
  }, { rng: () => 0 });
  assert.deepEqual(result, { action: 'silent', reason: 'invalid_callback' });
});

test('findCallbackCandidate: only resolves the reaction if it belongs to the same agent', () => {
  const db = freshDb();
  const id = pc.recordBanterMemory(db, {
    agentUserId: 1, wallId: 'w1', postId: 'p1', register: 'roast', text: 'a bit',
  }, NOW);
  assert.ok(pc.findCallbackCandidate(db, 1, id));
  assert.equal(pc.findCallbackCandidate(db, 2, id), null);
  assert.equal(pc.findCallbackCandidate(db, 1, null), null);
});

// ---- Wall opt-out ("vote this agent off the porch") ----

test('isWallOptedOut: false with no row, true after an indefinite opt-out', () => {
  const db = freshDb();
  assert.equal(pc.isWallOptedOut(db, 'w1', 1, NOW), false);
  pc.setWallOptOut(db, 'w1', 1, null, NOW);
  assert.equal(pc.isWallOptedOut(db, 'w1', 1, NOW), true);
});

test('isWallOptedOut: a timed ban expires on its own once `now` passes it', () => {
  const db = freshDb();
  const until = pc.toSqliteTimestamp(new Date('2026-08-29T13:00:00.000Z'));
  pc.setWallOptOut(db, 'w1', 1, until, NOW);
  assert.equal(pc.isWallOptedOut(db, 'w1', 1, NOW), true);
  assert.equal(pc.isWallOptedOut(db, 'w1', 1, new Date('2026-08-29T14:00:00.000Z')), false);
});

test('clearWallOptOut: voting an agent back on removes the short-circuit', () => {
  const db = freshDb();
  pc.setWallOptOut(db, 'w1', 1, null, NOW);
  assert.equal(pc.isWallOptedOut(db, 'w1', 1, NOW), true);
  pc.clearWallOptOut(db, 'w1', 1);
  assert.equal(pc.isWallOptedOut(db, 'w1', 1, NOW), false);
});

test('decide(): wall opt-out short-circuits before any gate runs, even with a perfect candidate', () => {
  const db = freshDb();
  pc.setWallOptOut(db, 'w1', 1, null, NOW);
  const result = pc.decide(db, {
    wallId: 'w1', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter(),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is legendary' }],
  }, { rng: () => 0 });
  assert.deepEqual(result, { action: 'silent', reason: 'wall_opt_out' });
});

test('decide(): opt-out is scoped per wall — the same agent can still post on a different wall', () => {
  const db = freshDb();
  pc.setWallOptOut(db, 'w1', 1, null, NOW);
  const result = pc.decide(db, {
    wallId: 'w2', postId: 'p1', agentUserId: 1, now: NOW,
    character: baseCharacter({ registerWeights: { roast: 1 } }),
    comprehension: COMPREHENSION,
    candidates: [{ register: 'roast', text: 'Steve, frame_003 is legendary' }],
  }, { rng: () => 0 });
  assert.equal(result.action, 'post');
});

// ---- migrate() idempotency ----

test('migrate() is safe to call twice against the same db', () => {
  const db = freshDb();
  assert.doesNotThrow(() => pc.migrate(db));
});
