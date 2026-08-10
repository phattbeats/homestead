#!/usr/bin/env node
// PHA-1867 acceptance tests for the month-grid merge layer.
//
// Covers:
//   * `/api/events/merged` returns native + cached provider events tagged
//     with the `origin` discriminator.
//   * The overlap query catches events that START before the window but
//     END inside it (the bug the merge-layer fix is meant to close).
//   * Events from disabled sources are excluded.
//   * The response payload never contains credential field names — this
//     is the publicView leak-check the foundation work (PHA-1620) defined,
//     extended here to the merged endpoint specifically.
//   * The endpoint requires `auth` — anonymous calls get 401.
//
// Same in-memory SQLite + http-only pattern as scripts/test-calendar-sources.js.
// Boots the express app, listens on a free port, and uses fetch() to hit
// the endpoint. Runs in isolation: a fresh DATA_DIR + SESSION_SECRET +
// ADMIN_PASSWORD so it never touches the real Homestead data dir.

'use strict';

(async () => {
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(label){pass++;console.log(`  ✓ ${label}`);}
function ng(label,detail){fail++;console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);}
function assert(cond,label,detail){if(cond)ok(label);else ng(label,detail);}
function assertEq(actual,expected,label){
  const a=JSON.stringify(actual),b=JSON.stringify(expected);
  if(a===b)ok(label);else ng(label,`expected ${b}, got ${a}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-mergetest-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3094';
process.env.ADMIN_PASSWORD = 'mergetest-admin-pw';
process.env.BRANDON_PASSWORD = 'mergetest-brandon-pw';
process.env.SESSION_SECRET = 'merge-test-secret-' + crypto.randomBytes(4).toString('hex');
process.env.NODE_ENV = 'production';
process.env.CALENDAR_CRED_KEY = crypto.randomBytes(32).toString('hex');

const secretBox = require('../lib/secret-box');
const userModel = require('../lib/user-model');
const calendarSources = require('../lib/calendar-sources');

// Stub the caldav adapter so the sync we kick inside the test cannot
// touch the network — it returns canned events that exercise the
// overlap math.
calendarSources.registerAdapter('caldav', (config) => ({
  kind: 'caldav',
  listCalendars: async () => [{ href: config.calendar_id, displayName: 'Test' }],
  listEvents: async () => [], // unused in this test — we seed the cache directly
  createEvent: async () => { throw new Error('not impl'); },
  updateEvent: async () => { throw new Error('not impl'); },
  deleteEvent: async () => { throw new Error('not impl'); },
}));

// Use a fresh DB + the real migrations (user-model seeds admin/brandon/
// emily with bcrypt hashes for the env passwords). Then layer calendar
// tables on top + the seed rows we want to test against.
const Database = require('better-sqlite3');
const db = new Database(path.join(tmpDir, 'life.db'));
db.pragma('foreign_keys = ON');
userModel.migrate(db);
calendarSources.migrate(db);

// Seed calendar_sources: one enabled Nextcloud, one disabled Nextcloud.
function insertSource({provider, account_id, calendar_id, color, enabled}){
  const credBlob = secretBox.encryptString(JSON.stringify({ app_password: 'pw-' + Math.random() }));
  const r = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, enabled, created_by)
    VALUES (NULL, ?, ?, ?, 'https://nc.example/dav', ?, ?, ?, ?, 'brandon')`).run(
    provider, account_id, calendar_id, 'Nextcloud', color, credBlob, enabled ? 1 : 0
  );
  return r.lastInsertRowid;
}

const srcEnabled = insertSource({provider: 'caldav_nextcloud', account_id: 'brandon', calendar_id: 'https://nc.example/dav/personal', color: '#7c9eb8', enabled: true});
const srcDisabled = insertSource({provider: 'caldav_nextcloud', account_id: 'work', calendar_id: 'https://nc.example/dav/work', color: '#aa3322', enabled: false});
// Mark the enabled source as freshly-synced so the stale flag is false
// in the assertion below — the contract is "source.last_synced_at is the
// freshness signal", and we're testing the merge-layer math, not the
// freshness window itself.
db.prepare(`UPDATE calendar_sources SET last_synced_at = datetime('now'), last_error = NULL WHERE id = ?`).run(srcEnabled);

// Seed native events (single-day, all-day).
db.prepare(`INSERT INTO events (title,date,time,owner,created_by) VALUES (?,?,?,?,?)`)
  .run('Native brunch', '2026-08-15', null, 'brandon', 'brandon');

// Seed cached provider events with varying overlap behaviour.
function insertCache(source_id, {title, start_at, end_at, all_day}){
  db.prepare(`INSERT INTO calendar_event_cache
    (source_id, external_id, title, start_at, end_at, all_day, location, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'))`).run(
    source_id, `${title}-${start_at}`, title, start_at, end_at, all_day ? 1 : 0
  );
}
// Event fully inside the test window (Aug 2026).
insertCache(srcEnabled, {title: 'Inside event', start_at: '2026-08-10T14:00:00Z', end_at: '2026-08-10T15:00:00Z'});
// Event that STARTS before the window but ENDS inside (cross-month).
insertCache(srcEnabled, {title: 'Cross-month forward', start_at: '2026-07-28T10:00:00Z', end_at: '2026-08-02T11:00:00Z'});
// Event that STARTS inside the window but ENDS after (multi-day).
insertCache(srcEnabled, {title: 'Multi-day', start_at: '2026-08-20T09:00:00Z', end_at: '2026-08-25T18:00:00Z'});
// All-day event on a single day inside the window.
insertCache(srcEnabled, {title: 'All day single', start_at: '2026-08-12T00:00:00Z', end_at: null, all_day: true});
// Event BEFORE the window (should be excluded).
insertCache(srcEnabled, {title: 'Before window', start_at: '2026-07-01T10:00:00Z', end_at: '2026-07-01T11:00:00Z'});
// Event AFTER the window (should be excluded).
insertCache(srcEnabled, {title: 'After window', start_at: '2026-09-15T10:00:00Z', end_at: '2026-09-15T11:00:00Z'});
// Event from DISABLED source (should be excluded even if inside window).
insertCache(srcDisabled, {title: 'Disabled source event', start_at: '2026-08-15T10:00:00Z', end_at: '2026-08-15T11:00:00Z'});

// Boot the express app.
const app = require('../server.js');
const server = http.createServer(app);
await new Promise((resolve, reject) => {
  server.listen(3094, '127.0.0.1', resolve);
  server.on('error', reject);
});

// Wait for /api/health.
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch('http://127.0.0.1:3094/api/health');
    if (r.ok) break;
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 100));
}

try {
  // Anonymous call must 401.
  const anonRes = await fetch('http://127.0.0.1:3094/api/events/merged?from=2026-08-01&to=2026-08-31');
  assertEq(anonRes.status, 401, 'anonymous /api/events/merged returns 401');

  // Log in as admin.
  const loginRes = await fetch('http://127.0.0.1:3094/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'mergetest-admin-pw' }),
  });
  assertEq(loginRes.status, 200, 'admin login returns 200');
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  // Missing from/to must 400.
  const noRangeRes = await fetch('http://127.0.0.1:3094/api/events/merged', { headers: { Cookie: cookie } });
  assertEq(noRangeRes.status, 400, 'missing from/to returns 400');

  // Bad date format must 400.
  const badRes = await fetch('http://127.0.0.1:3094/api/events/merged?from=not-a-date&to=2026-08-31', { headers: { Cookie: cookie } });
  assertEq(badRes.status, 400, 'invalid date format returns 400');

  // Happy path.
  const mergedRes = await fetch('http://127.0.0.1:3094/api/events/merged?from=2026-08-01&to=2026-08-31', { headers: { Cookie: cookie } });
  assertEq(mergedRes.status, 200, 'GET /api/events/merged returns 200');
  const body = await mergedRes.text();
  const merged = JSON.parse(body);

  // Shape.
  assert(Array.isArray(merged.events), 'response has events[]');
  assert(merged.events.length > 0, 'merged feed has events');

  // Find each test event.
  function find(title){ return merged.events.find((e) => e.title === title); }
  const inside = find('Inside event');
  const crossForward = find('Cross-month forward');
  const multiDay = find('Multi-day');
  const allDay = find('All day single');
  const before = find('Before window');
  const after = find('After window');
  const disabled = find('Disabled source event');
  const native = find('Native brunch');

  assert(!!inside, 'inside-window event present');
  assert(!!crossForward, 'cross-month event present (overlap catches it)');
  assert(!!multiDay, 'multi-day event present');
  assert(!!allDay, 'all-day event present');
  assert(!before, 'before-window event excluded');
  assert(!after, 'after-window event excluded');
  assert(!disabled, 'disabled-source event excluded');
  assert(!!native, 'native event present');

  // Origin tags.
  if (inside) assertEq(inside.origin, 'provider:caldav_nextcloud', 'inside event tagged provider:caldav_nextcloud');
  if (native) assertEq(native.origin, 'native', 'native event tagged origin=native');

  // Provider color + stale flag present.
  if (inside) {
    assertEq(inside.color, '#7c9eb8', 'inside event carries source color');
    assertEq(inside.stale, false, 'inside event has stale=false (just synced)');
    assert(typeof inside.source_id === 'number', 'inside event has source_id');
  }

  // All-day event shape.
  if (allDay) {
    assertEq(allDay.allDay, true, 'all-day event flagged allDay=true');
    assert(!allDay.end, 'all-day event has no end timestamp');
  }

  // Multi-day event shape — end_at present and > start_at.
  if (multiDay) {
    assert(typeof multiDay.end === 'string' && multiDay.end > multiDay.start, 'multi-day event has end > start');
  }

  // publicView / credential leak check — the entire response must NEVER
  // contain credential field names. This is the merge-layer equivalent
  // of the PR #5 smoke check, extended to /api/events/merged.
  assert(!body.includes('cred_blob'), 'merged response does NOT contain cred_blob');
  assert(!body.includes('app_password'), 'merged response does NOT contain plaintext app_password');
  assert(!body.includes('access_token'), 'merged response does NOT contain access_token');
  assert(!body.includes('refresh_token'), 'merged response does NOT contain refresh_token');
  assert(!body.includes('client_secret'), 'merged response does NOT contain client_secret');

  // Disabled source never leaks via the merged endpoint either.
  assert(!body.includes('Disabled source event'), 'disabled-source row never appears in response');

  // Disabled=0 source row should also not appear in /api/calendar-sources
  // for anyone (it's just disabled, not deleted — but it must not leak
  // through the merged feed).
  const listRes = await fetch('http://127.0.0.1:3094/api/calendar-sources', { headers: { Cookie: cookie } });
  const listBody = await listRes.text();
  assert(!listBody.includes('Disabled source event'), 'disabled-source title never appears in /api/calendar-sources');
  assert(!listBody.includes('cred_blob'), 'calendar-sources list does NOT contain cred_blob');
} finally {
  server.close();
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[test-merge-layer] FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
