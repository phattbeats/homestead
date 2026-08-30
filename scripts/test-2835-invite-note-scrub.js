#!/usr/bin/env node
'use strict';
// PHA-2835: scrubPublicNote — the public peek at /api/public/invites/:code
// is unauthenticated, so admin freeform notes must be stripped of
// operational metadata before they reach an invitee. This file is the
// acceptance gate for the server-side scrubber. The browser applies a
// parallel defense-in-depth pass (sanitizeNote in public/invite.html).
//
// Run: node scripts/test-2835-invite-note-scrub.js
//
// Scope: unit tests for invites.scrubPublicNote. The HTML render and
// API route wiring live in smoke-2583-invite-bounce.js and
// test-2711-invite-signup.js; this script asserts the scrub primitives.

const path = require('path');
const assert = require('assert');
const invites = require('../lib/invites');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }

console.log('PHA-2835 scrubPublicNote — invite-note operational-metadata leak guard');
console.log('='.repeat(72));

// ── Direct cases on scrubPublicNote() ───────────────────────────────────

// Case 1: pure operational copy → null (drop completely).
{
  const r = invites.scrubPublicNote('PHA-2664 beta wave (25-use porch invite, reissued after PHA-2728 wipe)');
  assert.strictEqual(r, null, 'pure operational copy returns null');
  ok('Case 1: pure operational copy (the actual leak from the issue body) returns null');
}

// Case 2: pure human copy → returned verbatim.
{
  const r = invites.scrubPublicNote('for the Tailor kid — your cousins');
  assert.strictEqual(r, 'for the Tailor kid — your cousins', 'pure human copy passes through');
  ok('Case 2: pure human copy passes through unchanged');
}

// Case 3: mixed — operational patterns removed, human context kept.
{
  const r = invites.scrubPublicNote('Hi! PHA-1234 reissued — come on in');
  // "PHA-1234" + "reissued" removed → "Hi!  — come on in" → "Hi! — come on in"
  assert.ok(/Hi!/.test(r) && /come on in/.test(r), `mixed copy retains human parts: "${r}"`);
  assert.ok(!/PHA-/.test(r), 'mixed copy strips PHA-####');
  assert.ok(!/reissued/i.test(r), 'mixed copy strips "reissued"');
  ok('Case 3: mixed copy retains human parts, strips operational');
}

// Case 4: edge — empty + null + non-string.
{
  assert.strictEqual(invites.scrubPublicNote(''), null, 'empty string returns null');
  assert.strictEqual(invites.scrubPublicNote(null), null, 'null returns null');
  assert.strictEqual(invites.scrubPublicNote(undefined), null, 'undefined returns null');
  assert.strictEqual(invites.scrubPublicNote(42), null, 'number returns null');
  ok('Case 4: empty/null/non-string inputs all return null');
}

// Case 5: length cap (280 chars).
{
  const tooLong = 'x'.repeat(300);
  assert.strictEqual(invites.scrubPublicNote(tooLong), null, 'overlong notes return null');
  const exactly280 = 'a'.repeat(280);
  assert.strictEqual(invites.scrubPublicNote(exactly280), exactly280, 'exactly-280 passes');
  ok('Case 5: notes over 280 chars return null; exactly 280 passes');
}

// Case 6: 40% rule — mostly operational copy returns null even if it
// has human wrapper.
{
  const r = invites.scrubPublicNote('Hi! PHA-1234 PHA-1235 PHA-1236 reissued beta wave wipe');
  assert.strictEqual(r, null, 'mostly-operational note trips 40% rule');
  ok('Case 6: mostly-operational copy trips 40% rule (returns null)');
}

// Case 7: each individual bad pattern triggers scrub.
{
  const patterns = [
    ['PHA-1234 plain', 'PHA-1234'],
    ['PHA-1234.5 sub-id', 'PHA-1234.5'],
    ['beta wave', 'beta wave'],
    ['reissued', 'reissued'],
    ['re-issued', 're-issued'],
    ['re-issue', 're-issue'],
    ['wiped', 'wiped'],
    ['wipe', 'wipe'],
    ['after PHA-2728', 'after PHA-2728'],
  ];
  for (const [label, phrase] of patterns) {
    const r = invites.scrubPublicNote(phrase);
    assert.ok(r === null || !phrase.includes(r),
      `pattern "${label}" (input "${phrase}") scrubs to: ${JSON.stringify(r)}`);
  }
  // Phrases that mix admin/ops prefix with human copy → admin/ops scrubbed,
// human wrapper survives.
{
  const cases = [
    ['admin note: please join', 'please join'],        // prefix gone, human kept
    ['owner reset: not allowed', 'not allowed'],        // prefix gone, human kept
    ['internal ops reset now', 'internal now'],         // "ops reset" gone, "internal" remains (acceptable: not a leak)
    ['reset event in March', 'in March'],               // reset-event gone, human kept
    ['beta wave — please come in', '— please come in'],  // beta wave removed, em-dash preserved
    ['staff copy: secret for you', 'secret for you'],  // human kept (>=40%)
    ['staff copy: secret', null],                       // mostly operational → null
  ];
  for (const [phrase, expected] of cases) {
    const r = invites.scrubPublicNote(phrase);
    assert.strictEqual(r, expected,
      `prefix "${phrase}" → ${JSON.stringify(r)} (expected ${JSON.stringify(expected)})`);
  }
  ok('Case 7b: prefix patterns scrub admin/ops, preserve human wrappers');
}
  ok('Case 7: every documented operational pattern strips from the result');
}

// Case 8: human wrappers survive.
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
    const r = invites.scrubPublicNote(note);
    assert.strictEqual(r, note, `human note passes through: "${note}"`);
  }
  ok('Case 8: human-facing notes pass through unchanged');
}

// Case 9: emoji + light punctuation survives.
{
  const r = invites.scrubPublicNote('Welcome! 🎉 Looking forward to having you :)');
  assert.ok(r && /Welcome/.test(r) && /you/.test(r), 'emoji + smiley survives');
  ok('Case 9: emoji + light punctuation survives the scrubber');
}

// ── HTTP integration: scrubber is wired into the public peek route ────

async function httpCase() {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pha2835-scrub-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const port = 28351;

  // Boot server via child_process so all migrations run naturally.
  const env = {
    ...process.env,
    DATA_DIR: tmpDir,
    PORT: String(port),
    SESSION_SECRET: 'pha-2835-scrub-test-secret',
    NODE_ENV: 'test',
    ALLOW_HEADER_TRUST: '0',
  };
  const child = require('child_process').spawn(
    'node', [path.join(__dirname, '..', 'server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  // Wait for /api/health.
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        clearInterval(tick);
        if (res.statusCode === 200) resolve();
        else reject(new Error(`/api/health ${res.statusCode}`));
      });
      req.on('error', () => {
        if (Date.now() - start > 8000) {
          clearInterval(tick);
          child.kill('SIGKILL');
          reject(new Error(`server did not come up. stderr:\n${stderr}`));
        }
      });
    }, 100);
  });

  try {
    // Use admin session to mint invites with the operational + human notes.
    // (We need an authenticated POST /api/invites to seed via the public route,
    // OR we can hit the DB directly. Direct DB is faster + simpler.)
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO walls (id, slug, name, visibility, created_at)
      VALUES ('pha2835-porch-id', 'porch', 'The Porch', 'group', datetime('now'))
    `).run();
    const stmt = db.prepare(`
      INSERT INTO invites (id, wall_slug, created_by, created_at, expires_at, note, max_uses)
      VALUES (?, 'porch', NULL, datetime('now'), datetime('now', '+30 days'), ?, 5)
    `);
    const code = 'PHA2835SCRUB00001';
    stmt.run(code, 'PHA-2664 beta wave (25-use porch invite, reissued after PHA-2728 wipe)');

    // Peek the operational note through the unauthenticated endpoint.
    const res = await fetch(`http://127.0.0.1:${port}/api/public/invites/${code}`);
    assert.strictEqual(res.status, 200, 'peek returns 200');
    const body = await res.json();
    assert.ok(body.note === null || !/PHA-/i.test(body.note),
      `peeked note is scrubbed: ${JSON.stringify(body.note)}`);
    assert.ok(body.wall_name === 'The Porch', 'wall_name is returned');

    // Now mint an invite with a human note and verify it passes through.
    const code2 = 'PHA2835SCRUB00002';
    stmt.run(code2, 'for the Tailor kid — your cousins');
    const res2 = await fetch(`http://127.0.0.1:${port}/api/public/invites/${code2}`);
    assert.strictEqual(res2.status, 200, 'peek human-note returns 200');
    const body2 = await res2.json();
    assert.strictEqual(body2.note, 'for the Tailor kid — your cousins',
      `peeked human note passes through: ${JSON.stringify(body2.note)}`);

    ok('Case 10: HTTP peek route scrubs operational note, passes human note');
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