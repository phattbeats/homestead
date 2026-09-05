#!/usr/bin/env node
// PHA-2853 acceptance tests — the typed Gazette issue rework.
//
// Covers:
//   1. `composeTypedPayload` produces typed, card-renderable sections
//      (not prose blobs) from a canned context, and the thin-edition
//      rule still holds (no material -> no sections, `thin: true`).
//   2. `GET /api/gazette/today` returns a typed payload with all four
//      section keys present when there is material for each, generates
//      on demand (no cron dependency), and caches to `gazette_issues`.
//   3. `GET /api/gazette/:date` serves back-issues and 404s on a date
//      with no issue.
//   4. `POST /api/gazette/ask` round-trips through the real Hearth
//      dispatch path (agentRuntime.dispatchHearth) against the same
//      fake provider used by scripts/test-2659-gazette.js.
//   5. The no-connectors first-run case (nothing enabled beyond
//      gazette+agent+wall+calendar, no data seeded) produces a
//      coherent thin edition rather than an error.
//
// Follows the DB-fixture / fake-provider / assert() conventions from
// scripts/test-2659-gazette.js and scripts/test-snapshot.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-gazette-issue-'));
const FAKE_PROVIDER_PORT = 3199;
const PORT = 3198;

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'gazette-issue-test-pw';
process.env.BRANDON_PASSWORD = 'gazette-issue-test-pw';
process.env.SESSION_SECRET = 'gazette-issue-test-secret';
process.env.NODE_ENV = 'production';
process.env.HEARTH_PROVIDER = 'litellm';
process.env.HEARTH_LITELLM_URL = `http://127.0.0.1:${FAKE_PROVIDER_PORT}`;
process.env.HEARTH_LITELLM_KEY = 'fake-key-for-tests';
process.env.HEARTH_LITELLM_MODEL = 'fake-model';

const gazette = require('../lib/gazette');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-2853 Gazette typed-issue tests\n');

// -----------------------------------------------------------------------------
// 1. Pure unit tests: composeTypedPayload
// -----------------------------------------------------------------------------
{
  console.log('Test 1: composeTypedPayload — typed sections, thin-edition rule');

  const emptyCtx = {
    date: '2026-09-05', tz: 'UTC', user: { display: 'Brandon' },
    today_tasks: [], overdue_tasks: [], upcoming_chores: [],
    today_events: [], porch_overnight: { posts: [], comments: [] },
    arrivals: [], tile_health: [],
  };
  const thin = gazette.composeTypedPayload(emptyCtx);
  assertEq(thin.thin, true, 'no material anywhere -> thin: true');
  assertEq(thin.sections, [], 'no material -> zero sections (never padded)');
  assert(thin.weather && typeof thin.weather.icon === 'string', 'thin issue still carries a typed weather entry');
  assertEq(thin.editors_note, gazette.THIN_NOTE, 'thin issue carries the one Homestead-owned sentence');

  const busyCtx = {
    ...emptyCtx,
    today_tasks: [{ id: 1, title: 'Take out trash', assignee: 'brandon', due_date: '2026-09-05' }],
    arrivals: [{ id: 2, kind: 'movie', name: 'Sample Feature', slug: 'sample-feature', source_service: 'plex', created_at: '2026-09-05' }],
    porch_overnight: { posts: [{ id: 3, wall_slug: 'household', wall_name: 'Household', author_display: 'Emily', text_body: 'Dinner was great.', created_at: '2026-09-05' }], comments: [] },
    today_events: [{ id: 4, title: 'Family dinner', time: '18:00', room_id: 'r1', room_label: 'Kitchen' }],
  };
  const issue = gazette.composeTypedPayload(busyCtx);
  assertEq(issue.thin, false, 'material present -> thin: false');
  assertEq(issue.sections.map(s => s.key), ['rotation_desk', 'arts_media', 'porch', 'listings'],
    'all four sections present, in print order, when each has material');

  for (const s of issue.sections) {
    assert(Array.isArray(s.items), `section '${s.key}' carries a typed items[] array`);
    assert(s.items.every(i => typeof i.type === 'string'), `every item in '${s.key}' is typed (has a 'type' field)`);
  }

  const listing = issue.sections.find(s => s.key === 'listings').items[0];
  assertEq(listing.room_label, 'Kitchen', 'PHA-2852 room-keyed listing carries room_label through to the typed item');

  const rotation = issue.sections.find(s => s.key === 'rotation_desk').items[0];
  assertEq(rotation.status, 'due_today', 'rotation desk item is typed with its due-status, not prose');

  // Optional agent prose attaches to the matching section without
  // displacing the typed items — cards remain renderable either way.
  const withProse = gazette.composeTypedPayload(busyCtx, {
    prose: { lede: { headline: 'The bin goes out', body: 'One thing due today.' }, briefs: [{ key: 'porch', headline: 'Porch', body: 'Dinner talk.' }], editors_note: null },
  });
  const rd = withProse.sections.find(s => s.key === 'rotation_desk');
  assertEq(rd.headline, 'The bin goes out', 'lede prose attaches to the lede section');
  assert(Array.isArray(rd.items) && rd.items.length > 0, 'lede section keeps its typed items alongside the prose');
  const porch = withProse.sections.find(s => s.key === 'porch');
  assertEq(porch.headline, 'Porch', 'brief prose attaches to its matching section by key');
}

// -----------------------------------------------------------------------------
// 2-5. Route-level tests against a live server + fake Hearth provider
// -----------------------------------------------------------------------------
let FAKE_COMPLETION = '';
let fakeRequests = [];

function startFakeProvider() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        fakeRequests.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FAKE_COMPLETION }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end();
      });
    });
    srv.listen(FAKE_PROVIDER_PORT, '127.0.0.1', () => resolve(srv));
  });
}

const HEAD = { 'x-authentik-username': 'brandon', 'x-authentik-groups': 'household' };
const GET = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: HEAD });
const POST = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST',
  headers: { ...HEAD, 'content-type': 'application/json' },
  body: JSON.stringify(body === undefined ? {} : body),
});

async function main() {
  const fakeProvider = await startFakeProvider();
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(PORT, '127.0.0.1', resolve);
    process.on('uncaughtException', reject);
  });

  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\nTest 2: module gating — /api/gazette/today refuses before enable');
  {
    const r = await GET('/api/gazette/today');
    assertEq(r.status, 403, 'gazette not yet enabled -> 403');
  }

  console.log('\nTest 3: enabling gazette (with its widened requires) works out of the box');
  {
    // PHA-2853 widened requires to ['agent','wall','calendar']; all
    // three are grandfathered-enabled on a fresh install, so this
    // should not need withRequirements.
    const en = await POST('/api/me/modules/gazette/enable');
    assertEq(en.status, 200, 'enabling gazette succeeds with agent+wall+calendar already on');
  }

  console.log('\nTest 4: no-connectors first run -> coherent thin issue, no harness call');
  {
    fakeRequests = [];
    const r = await GET('/api/gazette/today');
    assertEq(r.status, 200, 'first-ever open -> 200, not an error');
    const d = await r.json();
    assertEq(d.payload.thin, true, 'nothing seeded yet -> thin issue');
    assertEq(d.payload.sections, [], 'thin issue has zero sections');
    assertEq(fakeRequests.length, 0, 'thin issue never calls the harness');
  }

  console.log('\nTest 5: material -> all present sections come back typed, and the issue caches');
  {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await POST('/api/me/modules/chores/enable', { withRequirements: true });
    const t = await POST('/api/tasks', { title: 'Take out trash', assignee: 'all', due_date: iso });
    assertEq(t.status, 200, 'seeded a task due today');

    // The cached thin issue from Test 4 already occupies today's row;
    // gazette_issues has no `?refresh=1` escape hatch by design (the
    // typed items are cheap to recompute; back-issues are immutable
    // history once a day has passed). Delete the row directly to
    // simulate "the cron/on-demand generation had not run yet".
    try {
      const Database = require('better-sqlite3');
      const dbPath = path.join(tmpDir, 'life.db');
      const raw = new Database(dbPath);
      raw.pragma('busy_timeout = 5000');
      raw.prepare('DELETE FROM gazette_issues WHERE date = ?').run(iso);
      raw.close();
    } catch (err) { console.error('  (warning) could not clear cached thin issue:', err.message); }

    FAKE_COMPLETION = JSON.stringify({
      lede: { headline: 'The bin goes out', body: 'One thing due, and it is the bin.' },
      briefs: [],
      editors_note: 'Ask the editor: whose turn is it really?',
    });
    fakeRequests = [];

    const r = await GET('/api/gazette/today');
    assertEq(r.status, 200, 'generate -> 200');
    const d = await r.json();
    assert(d.payload.sections.some(s => s.key === 'rotation_desk'), 'rotation_desk section present with real material', JSON.stringify(d.payload.sections.map(s => s.key)));
    const rd = d.payload.sections.find(s => s.key === 'rotation_desk');
    assert(!!rd && rd.items.some(i => i.title === 'Take out trash'), 'typed item carries the real task title');
    assert(!!rd && rd.headline === 'The bin goes out', 'agent prose attached to the lede section');

    fakeRequests = [];
    const again = await (await GET('/api/gazette/today')).json();
    assertEq(again.cached, true, 'second open is a cache hit against gazette_issues');
    assertEq(fakeRequests.length, 0, 'cache hit does not re-call the harness');
  }

  console.log('\nTest 6: GET /api/gazette/:date — back-issue browsing');
  {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const r = await GET(`/api/gazette/${iso}`);
    assertEq(r.status, 200, "today's date via the back-issue route -> 200");
    const missing = await GET('/api/gazette/2001-01-01');
    assertEq(missing.status, 404, 'a date with no issue -> 404');
    const bad = await GET('/api/gazette/not-a-date');
    assertEq(bad.status, 400, 'malformed date -> 400');
  }

  console.log('\nTest 7: POST /api/gazette/ask routes through the real Hearth dispatch');
  {
    FAKE_COMPLETION = 'The bin is due today because it is Friday.';
    fakeRequests = [];
    const r = await POST('/api/gazette/ask', { question: 'Why is the bin due today?' });
    assertEq(r.status, 200, 'ask -> 200');
    const d = await r.json();
    assertEq(d.ok, true, 'ask succeeds against the fake provider');
    assert(typeof d.answer === 'string' && d.answer.length > 0, 'answer text comes back');
    assert(fakeRequests.length >= 1, 'the question actually reached the Hearth dispatch path');

    const empty = await POST('/api/gazette/ask', { question: '' });
    assertEq(empty.status, 400, 'empty question -> 400');
  }

  fakeProvider.close();
}

(async () => {
  await main();
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail > 0 ? 1 : 0);
})();
