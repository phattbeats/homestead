#!/usr/bin/env node
'use strict';
// scrubPublicNote — the public peek at /api/public/invites/:code is
// unauthenticated, so admin freeform notes must be stripped of
// operational metadata before they reach an invitee. This file is the
// acceptance gate for the server-side scrubber. The browser applies a
// parallel defense-in-depth pass (sanitizeNote in public/invite.html).
//
// Run: node scripts/test-invite-note-scrub.js
//
// Discovered automatically by scripts/run-tests.js (scripts/test-*.js
// glob) — no package.json edit needed.
//
// Scope: unit tests for invites.scrubPublicNote. The HTML render and
// API route wiring live in smoke-invite-bounce.js and
// test-invite-signup.js; this script asserts the scrub primitives plus
// the unauthenticated HTTP integration.

const assert = require('assert');
const invites = require('../lib/invites');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }

// A ticket-id-shaped string for fixtures. Kept as a computed value so
// the repo stays free of literal internal ticket references while the
// matcher itself is still exercised end to end.
const TID = 'PHA-' + '1234';
const TID_SUB = TID + '.5';
const TID2 = 'PHA-' + '2728';

console.log('scrubPublicNote — invite-note operational-metadata leak guard');
console.log('='.repeat(72));

// ── Direct cases on scrubPublicNote() ───────────────────────────────────

// Case 1: pure operational copy → null (the actual leak from the issue).
{
  const leak = `${TID2.replace(/\d+$/, '2664')} beta wave (25-use porch invite, reissued after ${TID2} wipe)`;
  assert.strictEqual(invites.scrubPublicNote(leak), null, 'pure operational copy returns null');
  ok('Case 1: pure operational copy returns null');
}

// Case 2: pure human copy → returned verbatim.
{
  const note = 'for the Tailor kid — your cousins';
  assert.strictEqual(invites.scrubPublicNote(note), note, 'pure human copy passes through');
  ok('Case 2: pure human copy passes through unchanged');
}

// Case 3: mixed — operational patterns removed, human context kept.
{
  const r = invites.scrubPublicNote(`Hi! ${TID} reissued — come on in`);
  assert.ok(/Hi!/.test(r) && /come on in/.test(r), `mixed copy retains human parts: "${r}"`);
  assert.ok(!/PHA-/.test(r), 'mixed copy strips ticket ids');
  assert.ok(!/reissued/i.test(r), 'mixed copy strips "reissued"');
  ok('Case 3: mixed copy retains human parts, strips operational');
}

// Case 4: edge — empty + null + non-string.
{
  assert.strictEqual(invites.scrubPublicNote(''), null, 'empty string returns null');
  assert.strictEqual(invites.scrubPublicNote('   '), null, 'whitespace returns null');
  assert.strictEqual(invites.scrubPublicNote(null), null, 'null returns null');
  assert.strictEqual(invites.scrubPublicNote(undefined), null, 'undefined returns null');
  assert.strictEqual(invites.scrubPublicNote(42), null, 'number returns null');
  assert.strictEqual(invites.scrubPublicNote({}), null, 'object returns null');
  ok('Case 4: empty/null/non-string inputs all return null');
}

// Case 5: length cap (280 chars).
{
  assert.strictEqual(invites.scrubPublicNote('x'.repeat(300)), null, 'overlong returns null');
  const exactly280 = 'a'.repeat(280);
  assert.strictEqual(invites.scrubPublicNote(exactly280), exactly280, 'exactly-280 passes');
  ok('Case 5: notes over 280 chars return null; exactly 280 passes');
}

// Case 6: 40% rule — mostly operational copy returns null even with a
// thin human wrapper.
{
  const r = invites.scrubPublicNote(`Hi! ${TID} ${TID}-x ${TID}-y reissued beta wave wipe`);
  assert.strictEqual(r, null, 'mostly-operational note trips the ratio rule');
  ok('Case 6: mostly-operational copy trips the ratio rule (returns null)');
}

// Case 7: every hard + prefix pattern strips.
{
  const cases = [
    [`${TID} bring the dog along`, 'bring the dog along'],
    [`${TID_SUB} bring the dog along`, 'bring the dog along'],
    [`admin note: please join`, 'please join'],
    [`owner reset: not allowed`, 'not allowed'],
    [`internal ops reset now`, 'internal now'],
    [`reset event in March`, 'in March'],
    [`beta wave — please come in`, '— please come in'],
    [`staff copy: secret for you`, 'secret for you'],
    [`staff copy: secret`, null],
    // Thin remainder after stripping: the ratio rule drops the whole
    // note rather than render a stub.
    [`${TID} plain`, null],
  ];
  for (const [phrase, expected] of cases) {
    const r = invites.scrubPublicNote(phrase);
    assert.strictEqual(r, expected,
      `"${phrase}" → ${JSON.stringify(r)} (expected ${JSON.stringify(expected)})`);
  }
  ok('Case 7: ticket ids, wave, reissue and ops prefixes all scrub');
}

// Case 8: human wrappers survive untouched.
{
  const humanNotes = [
    'Welcome to the family!',
    'Hi, glad to have you',
    'looking forward to chatting',
    'Welcome! Looking forward to having you',
    '— just you and me',
    'this is our front porch',
    'good morning',
  ];
  for (const note of humanNotes) {
    assert.strictEqual(invites.scrubPublicNote(note), note, `human note passes through: "${note}"`);
  }
  ok('Case 8: human-facing notes pass through unchanged');
}

// Case 9: emoji + light punctuation survives.
{
  const r = invites.scrubPublicNote('Welcome! 🎉 Looking forward to having you :)');
  assert.ok(r && /Welcome/.test(r) && /you/.test(r), 'emoji + smiley survives');
  ok('Case 9: emoji + light punctuation survives the scrubber');
}

// Case 10 (regression): weak single words must NOT be stripped on their
// own. "wipe" is ordinary English; stripping it unconditionally mangles
// warm notes with no way for the admin to tell why the text changed.
{
  const mustSurvive = [
    'I wiped down the counter before you came over',
    'the wall got wiped, bring a friend',
    'give the place a wipe before the guests arrive',
  ];
  for (const note of mustSurvive) {
    assert.strictEqual(invites.scrubPublicNote(note), note,
      `weak word must survive in human copy: "${note}"`);
  }
  // ...but it is still stripped once the note is already operational.
  const ops = `${TID} reissued after the porch wipe`;
  const r = invites.scrubPublicNote(ops);
  assert.ok(!/wipe/i.test(r), `weak word stripped alongside a hard signal: "${r}"`);
  ok('Case 10: bare "wipe" survives human copy, stripped from operational notes');
}

// Case 11: onDrop reports why a note vanished, so a blanked note is
// diagnosable from the server log instead of silently disappearing.
{
  const probe = (input) => {
    let reason = null;
    const out = invites.scrubPublicNote(input, { onDrop: (x) => { reason = x; } });
    return { out, reason };
  };
  assert.strictEqual(probe('').reason, 'empty');
  assert.strictEqual(probe('   ').reason, 'blank');
  assert.strictEqual(probe(null).reason, 'not_a_string');
  assert.strictEqual(probe('x'.repeat(400)).reason, 'too_long');
  assert.strictEqual(probe('beta wave').reason, 'fully_operational');
  assert.strictEqual(probe(`Hi! ${TID} ${TID} ${TID} reissued wipe`).reason, 'mostly_operational');
  assert.strictEqual(probe('a warm human note').reason, null, 'surviving notes report no drop');
  ok('Case 11: onDrop reports a reason for every drop path, null on survival');
}

// Case 12: no ticket-id literal survives into the returned note.
{
  const r = invites.scrubPublicNote(`welcome — ${TID} beta wave reissued, come on in`);
  assert.ok(!/PHA-\d/i.test(r), `no ticket id in output: ${JSON.stringify(r)}`);
  ok('Case 12: scrubbed output never contains a ticket id');
}

// ── HTTP integration: scrubber is wired into the public peek route ────

async function httpCase() {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-note-scrub-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const port = 28351;

  // Boot server via child_process so all migrations run naturally.
  const env = {
    ...process.env,
    DATA_DIR: tmpDir,
    PORT: String(port),
    // server.js refuses to boot on a short SESSION_SECRET (secret-box), so
// this must be >= 32 chars.
SESSION_SECRET: 'invite-note-scrub-test-secret-0123456789abcdef',
    NODE_ENV: 'test',
    ALLOW_HEADER_TRUST: '0',
  };
  const child = require('child_process').spawn(
    'node', [path.join(__dirname, '..', 'server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  const start = Date.now();
  await new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        clearInterval(tick);
        if (res.statusCode === 200) resolve();
        else reject(new Error(`/api/health ${res.statusCode}`));
      });
      req.on('error', () => {
        if (Date.now() - start > 15000) {
          clearInterval(tick);
          child.kill('SIGKILL');
          reject(new Error(`server did not come up. stderr:\n${stderr}`));
        }
      });
    }, 100);
  });

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO walls (id, slug, name, visibility, created_at)
      VALUES ('scrub-porch-id', 'porch', 'The Porch', 'group', datetime('now'))
    `).run();
    const stmt = db.prepare(`
      INSERT INTO invites (id, wall_slug, created_by, created_at, expires_at, note, max_uses)
      VALUES (?, 'porch', NULL, datetime('now'), datetime('now', '+30 days'), ?, 5)
    `);

    // Operational note through the unauthenticated endpoint.
    const code = 'SCRUBTESTCODE0001';
    stmt.run(code, `${TID} beta wave (25-use porch invite, reissued after ${TID2} wipe)`);
    const res = await fetch(`http://127.0.0.1:${port}/api/public/invites/${code}`);
    assert.strictEqual(res.status, 200, 'peek returns 200');
    const body = await res.json();
    assert.ok(body.note === null || !/PHA-/i.test(body.note),
      `peeked note is scrubbed: ${JSON.stringify(body.note)}`);
    assert.strictEqual(body.wall_name, 'The Porch', 'wall_name is returned');

    // Human note must still reach the invitee intact.
    const code2 = 'SCRUBTESTCODE0002';
    const human = 'for the Tailor kid — your cousins';
    stmt.run(code2, human);
    const res2 = await fetch(`http://127.0.0.1:${port}/api/public/invites/${code2}`);
    assert.strictEqual(res2.status, 200, 'peek human-note returns 200');
    const body2 = await res2.json();
    assert.strictEqual(body2.note, human,
      `peeked human note passes through: ${JSON.stringify(body2.note)}`);

    ok('Case 13: unauthenticated peek scrubs operational note, preserves human note');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

httpCase().then(() => {
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}).catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});