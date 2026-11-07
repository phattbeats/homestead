#!/usr/bin/env node
// acceptance tests — PHA-4891: the Gazette daily catch-up window.
//
// Reproduces the 2026-11-03 failure, end to end:
//
//   04:21 ET  the compose tick runs. The upstream wire build has not
//             finished yet, so the issue is composed WITHOUT a wire.
//   08:54 ET  the build finishes and the artifact lands.
//   09:00 ET  the next tick must REPAIR that issue — in place, same
//             row, one issue per user per local day.
//
// Before this change the issue stayed wire-less for the rest of the
// day: `runForUser` returned early for ANY existing row, so a late
// artifact could never reach the paper. Separately, a container that
// booted at 09:00 never composed anything at all, because the old tick
// only acted when the local hour was EXACTLY 4 — a silent day.
//
// What is asserted here:
//
//   1. Before 04:00 local, the job does nothing at all.
//   2. Inside the window with no artifact, the issue is composed and
//      carries `external.status = 'unavailable'`.
//   3. When the artifact lands, the SAME issue row is recomposed in
//      place and now carries the wire sections.
//   4. An issue that already has a wire is never rewritten.
//   5. A wire-less issue with no artifact is left completely alone —
//      no model call, no rewrite, no `generated_at` bump.
//   6. When the window closes on a wire-less day, the job says so —
//      exactly once, not once per tick.
//   7. One issue row per user per local day, throughout.
//
// Follows the assert() conventions from scripts/test-gazette-issue.js
// and scripts/test-external-edition.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Pin the process timezone so the job's host-local date is the same
// on every machine that runs this test.
process.env.TZ = 'America/New_York';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-gazette-catchup-'));
const artifactDir = path.join(tmpDir, 'gazette-v2');
fs.mkdirSync(artifactDir, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'gazette-catchup-test-secret-padding-to-meet-min-32-chars';
process.env.HMAC_CRED_KEY = process.env.HMAC_CRED_KEY
  || 'gazette-catchup-hmac-key-padding-to-meet-min-32-chars';
process.env.ADMIN_PASSWORD = 'catchup-test-pw';
process.env.BRANDON_PASSWORD = 'catchup-test-pw';
// The bootstrap shim blanks these for every other test so a live
// machine's morning artifact cannot leak into a unit test. This test
// is ABOUT the wire, so it points them at its own fixture directory.
process.env.GAZETTE_EXTERNAL_EDITION_DIR = artifactDir;
process.env.GAZETTE_EXTERNAL_OWNER_ID = 'phatt';

const agentRuntime = require('../lib/agent-runtime');
const gazette = require('../lib/gazette');
const gazetteDaily = require('../jobs/gazette-daily');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

// --- the model stub -------------------------------------------------------
//
// The job calls `agentRuntime.composeGazette` for the prose layer. It
// is stubbed here so the test can COUNT the calls: "a retry with no
// artifact must not burn a model call" is only assertable if the calls
// are visible.

let composeCalls = 0;
agentRuntime.composeGazette = async () => {
  composeCalls += 1;
  return {
    ok: true,
    text: JSON.stringify({
      lede: { headline: 'The bin goes out', body: 'One thing due today.' },
      briefs: [],
      editors_note: null,
    }),
  };
};

// --- the fixture ----------------------------------------------------------

const TZ = 'America/New_York';
const DAY1 = '2026-11-03'; // the day the failure was observed
const DAY2 = '2026-11-04'; // a second day, for the no-artifact path

// Nov 3 2026 is after the DST change (Nov 1), so these are all -05:00.
const T = {
  beforeWindow: new Date('2026-11-03T03:00:00-05:00'),
  firstCompose: new Date('2026-11-03T04:21:00-05:00'),
  afterBuild: new Date('2026-11-03T09:00:00-05:00'),
  stillHealthy: new Date('2026-11-03T09:15:00-05:00'),
  windowClosed: new Date('2026-11-03T16:30:00-05:00'),
  day2Compose: new Date('2026-11-04T04:21:00-05:00'),
  day2StillMissing: new Date('2026-11-04T09:00:00-05:00'),
  day2WindowClosed: new Date('2026-11-04T16:30:00-05:00'),
  day2WindowClosedAgain: new Date('2026-11-04T16:45:00-05:00'),
};

function artifact(date, generatedAt) {
  return {
    schema_version: 2,
    type: 'external.edition',
    edition_date: date,
    timezone: TZ,
    generated_at: generatedAt,
    status: 'published',
    audience_scope: 'mixed',
    masthead: { title: 'The Ledger' },
    sources: [
      { id: 'bbc', label: 'BBC News', status: 'ok', checked_at: generatedAt },
      { id: 'reddit', label: 'Reddit', status: 'ok', checked_at: generatedAt },
    ],
    sections: [
      {
        id: 'news', homestead_key: 'world_news', title: 'The World Today', audience: 'household',
        max_age_hours: 48, source_ids: ['bbc'],
        items: [
          { id: 'a1', kind: 'article', title: 'Headline one', summary: 'Excerpt one.', summary_origin: 'publisher_excerpt', url: 'https://example.org/one', source: 'BBC News', source_id: 'bbc', published_at: generatedAt },
        ],
      },
      {
        id: 'twitter', homestead_key: 'social_timeline', title: 'From Your Timeline', audience: 'personal',
        max_age_hours: 24, source_ids: ['reddit'],
        items: [
          { id: 't1', kind: 'tweet', title: '@someone: hello', summary: 'hello', summary_origin: 'post_text', url: 'https://x.com/someone/status/1', source: 'X / Twitter', source_id: 'reddit', published_at: generatedAt, author: 'Someone' },
        ],
      },
    ],
    provenance: { summary_policy: 'Publisher excerpts and existing digest selections; no invented reporting.', producer: 'daily-newspaper' },
    policy: {
      untrusted_content: true,
      citation_required: ['url', 'source'],
      personal_sections: ['social_timeline'],
      shared_wall_publication: 'forbidden',
      max_item_chars: { title: 300, summary: 500 },
    },
  };
}

function writeArtifact(doc) {
  fs.writeFileSync(
    path.join(artifactDir, `${doc.edition_date}.json`),
    JSON.stringify(doc, null, 2)
  );
}

// `gazette_issues.generated_at` is stored at SECOND resolution
// (datetime('now')). Two writes inside the same second are therefore
// indistinguishable, which would make every "did this row move?"
// assertion vacuous. Crossing a second boundary before each of those
// checks makes them real: a rewrite now has to show up.
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
const NEXT_SECOND = 1100;

function issueRows(db, userId, date) {
  return db.prepare('SELECT COUNT(*) c FROM gazette_issues WHERE user_id = ? AND date = ?')
    .get(userId, date).c;
}

function shoutCount(db, userId) {
  return db.prepare('SELECT COUNT(*) c FROM shouts WHERE user_id = ?').get(userId).c;
}

function shoutBodies(db, userId) {
  return db.prepare('SELECT body FROM shouts WHERE user_id = ?').all(userId).map(r => r.body);
}

function wireKeys(payload) {
  if (!payload || !Array.isArray(payload.sections)) return [];
  return payload.sections
    .filter(s => s && ['world_news', 'technology', 'daily_podcast', 'social_timeline', 'social_forum'].includes(s.key))
    .map(s => s.key);
}

console.log('\nGazette daily catch-up — PHA-4891\n');

async function main() {
  const app = require('../server.js');
  const db = app.db;

  // --- fixture: a user with the gazette module on, a pinned tz, and
  // --- material on both days so the prose layer is actually reached.

  db.prepare("INSERT INTO users (username, display, pass_hash) VALUES (?, ?, ?)")
    .run('phatt', 'Phatt', '');
  const user = db.prepare("SELECT id, username FROM users WHERE username = 'phatt'").get();
  db.prepare("INSERT INTO user_modules (user_id, module_key, enabled_at) VALUES (?, 'gazette', datetime('now'))")
    .run(user.id);
  // The tz is carried on the most recent edition row — pin it so the
  // job's local window is America/New_York regardless of host clock.
  gazette.putEdition(db, user.id, DAY1, { tz: TZ, status: 'published', edition: {} });
  for (const d of [DAY1, DAY2]) {
    db.prepare("INSERT INTO tasks (title, assignee, due_date) VALUES (?, 'all', ?)")
      .run(`Take out trash ${d}`, d);
  }

  console.log('Test 1: before 04:00 local, the job does nothing');
  {
    const before = issueRows(db, user.id, DAY1);
    const results = await gazetteDaily.tick(db, T.beforeWindow);
    assertEq(results.length, 0, 'no work before the window opens');
    assertEq(issueRows(db, user.id, DAY1), before, 'no issue row written before the window');
    assertEq(composeCalls, 0, 'no model call before the window');
  }

  console.log('\nTest 2: first compose inside the window, with no artifact yet');
  {
    const results = await gazetteDaily.tick(db, T.firstCompose);
    assertEq(results.length, 1, 'the tick composes one user');
    assert(!results[0].skipped, 'the first compose is not a skip', JSON.stringify(results[0]));
    const issue = gazette.getIssue(db, user.id, DAY1);
    assert(!!issue, 'an issue row exists for the day');
    assertEq(issue.payload.external.status, 'unavailable', 'the wire-less issue says so');
    assertEq(wireKeys(issue.payload), [], 'no wire sections landed');
    assertEq(composeCalls, 1, 'the prose layer was reached once');
  }

  console.log('\nTest 3: the artifact lands — the issue is repaired in place');
  {
    await sleep(NEXT_SECOND);
    const before = gazette.getIssue(db, user.id, DAY1);
    writeArtifact(artifact(DAY1, '2026-11-03T13:54:00Z')); // 08:54 ET
    const results = await gazetteDaily.tick(db, T.afterBuild);
    assertEq(results.length, 1, 'the tick processed one user');
    assert(results[0].recomposed === true, 'this was a RECOMPOSE, not a fresh compose', JSON.stringify(results[0]));
    assertEq(issueRows(db, user.id, DAY1), 1, 'still exactly one issue row for the day');
    const after = gazette.getIssue(db, user.id, DAY1);
    assertEq(after.payload.external.status, 'published', 'the repaired issue carries the wire');
    assert(wireKeys(after.payload).includes('world_news'), 'the household wire section landed', JSON.stringify(wireKeys(after.payload)));
    assert(wireKeys(after.payload).includes('social_timeline'), 'the owner-only wire section landed for the owner');
    assert(after.generated_at !== before.generated_at, 'generated_at advanced on the recompose');
    assertEq(composeCalls, 2, 'the recompose reached the prose layer once more');
  }

  console.log('\nTest 4: an issue that already has a wire is never rewritten');
  {
    await sleep(NEXT_SECOND);
    const before = gazette.getIssue(db, user.id, DAY1);
    const results = await gazetteDaily.tick(db, T.stillHealthy);
    assertEq(results.length, 1, 'the tick saw the user');
    assertEq(results[0].skipped, 'already_generated', 'the tick skipped the healthy issue');
    const after = gazette.getIssue(db, user.id, DAY1);
    assertEq(after.generated_at, before.generated_at, 'generated_at did not move');
    assertEq(composeCalls, 2, 'no model call for a healthy issue');
  }

  console.log('\nTest 5: the window closing on a wired day says nothing');
  {
    const results = await gazetteDaily.tick(db, T.windowClosed);
    assertEq(results.length, 1, 'the tick saw the user');
    assertEq(results[0].skipped, 'already_generated', 'a wired day closes out silently');
    assertEq(shoutCount(db, user.id), 0, 'no alert for a day that went well');
  }

  console.log('\nTest 6: a wire-less day with no artifact is left completely alone');
  {
    const results = await gazetteDaily.tick(db, T.day2Compose);
    assertEq(results.length, 1, 'the tick composed one user');
    const issue = gazette.getIssue(db, user.id, DAY2);
    assert(!!issue, 'an issue row exists for the second day');
    assertEq(issue.payload.external.status, 'unavailable', 'the second day is wire-less');
    const callsAfterCompose = composeCalls;

    await sleep(NEXT_SECOND);
    const before = gazette.getIssue(db, user.id, DAY2);
    const retry = await gazetteDaily.tick(db, T.day2StillMissing);
    assertEq(retry.length, 1, 'the retry saw the user');
    assertEq(retry[0].skipped, 'wire_missing', 'the retry skipped: no artifact to use');
    const after = gazette.getIssue(db, user.id, DAY2);
    assertEq(after.generated_at, before.generated_at, 'generated_at did NOT move on the no-artifact retry');
    assertEq(composeCalls, callsAfterCompose, 'no model call burned on the no-artifact retry');
    assertEq(issueRows(db, user.id, DAY2), 1, 'still exactly one issue row for the second day');
  }

  console.log('\nTest 7: when the window closes on a wire-less day, it says so — once');
  {
    const results = await gazetteDaily.tick(db, T.day2WindowClosed);
    assertEq(results.length, 1, 'the close-out saw the user');
    assertEq(results[0].alert, 'sent', 'the alert was sent');
    assertEq(shoutCount(db, user.id), 1, 'exactly one alert');
    const bodies = shoutBodies(db, user.id);
    assert(bodies[0].includes(DAY2), 'the alert names the day it is about', bodies[0]);
    assert(bodies[0].length <= 280, 'the alert fits the shoutbox body limit', `len=${bodies[0].length}`);

    const again = await gazetteDaily.tick(db, T.day2WindowClosedAgain);
    assertEq(again.length, 1, 'the second close-out tick saw the user');
    assertEq(again[0].alert, 'already_sent', 'the second close-out did not repeat the alert');
    assertEq(shoutCount(db, user.id), 1, 'still exactly one alert');
  }

  console.log('\nTest 8: the guard reads the merged payload, not payload.external.sections');
  {
    // The shape the storage actually has: the wire sections are merged
    // into the TOP-LEVEL sections array, and `external` carries only
    // the status. A guard that looks for `external.sections` finds
    // nothing and would recompose a perfectly wired paper forever.
    const issue = gazette.getIssue(db, user.id, DAY1);
    assert(!('sections' in issue.payload.external), 'the stored external block has no sections key');
    assertEq(issue.payload.external.status, 'published', 'the stored external block carries the status');
    assert(gazetteDaily.issueHasWire(issue), 'the guard recognises the wired issue');
    const wireless = gazette.getIssue(db, user.id, DAY2);
    assert(!gazetteDaily.issueHasWire(wireless), 'the guard rejects the wire-less issue');
  }

  console.log('\nTest 9: a stale artifact is not a usable artifact');
  {
    // The artifact is 100 hours old. The reader drops its sections for
    // age, so it must never be spliced into a paper.
    const stale = artifact(DAY2, '2026-10-31T00:00:00Z');
    writeArtifact(stale);
    const block = require('../lib/external-edition').readExternalEdition({
      date: DAY2, now: T.day2StillMissing, userId: 'phatt',
    });
    assertEq(block.status, 'stale', 'the reader ages the artifact out');
    assert(!gazetteDaily.wireUsable(block), 'the guard rejects a stale artifact');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test crashed:', err && err.stack || err);
  process.exit(1);
});
