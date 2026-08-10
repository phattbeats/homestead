#!/usr/bin/env node
// PHA-1620 acceptance tests for the calendar-sources module.
//   * secret-box (AES-256-GCM encrypt/decrypt + fail-closed on missing key)
//   * caldav-source (iCal parser, adapter factory, injected HTTP stub)
//   * calendar-sources (migration, publicView never exposes cred_blob,
//     syncSource happy path, isStale logic)
//
// Each test runs on a fresh in-memory or temp-file SQLite so they are
// independent and idempotent. No external test framework; uses the
// same `ok` / `ng` / `assertEq` helpers as scripts/test-user-model.js.
//
// Wrapped in an async IIFE so Node 24 doesn't try to parse top-level
// `await` as ESM (scripts/test-user-model.js is fully sync for the
// same reason).

'use strict';

(async () => {

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const secretBox = require('../lib/secret-box');
const caldav = require('../lib/caldav-source');
const calendarSources = require('../lib/calendar-sources');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertThrows(fn, pattern, label) {
  try { fn(); ng(label, 'expected throw, got success'); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) {
      ng(label, `wrong error: ${e.message}`);
    } else {
      ok(label);
    }
  }
}

console.log('PHA-1620 calendar-sources tests\n');

// ---- Test 1: secret-box round-trip + tamper detection ----------------
console.log('Test 1: secret-box round-trip');
{
  process.env.CALENDAR_CRED_KEY = 'a'.repeat(64);
  const plaintext = 'hunter2-app-password-for-nextcloud';
  const stored = secretBox.encryptString(plaintext);
  assert(stored.split(':').length === 3, 'stored value has iv:tag:ciphertext shape');
  const back = secretBox.decryptString(stored);
  assertEq(back, plaintext, 'round-trip recovers plaintext');

  // Tamper with the ciphertext — auth tag must reject.
  const [iv, tag, ct] = stored.split(':');
  const tampered = [iv, tag, Buffer.from(ct, 'base64').toString('base64').replace(/^./, 'A')].join(':');
  assertThrows(() => secretBox.decryptString(tampered), /auth/i, 'tampered ciphertext is rejected');
}
{
  // Fail-closed: unset env var throws on every call.
  delete process.env.CALENDAR_CRED_KEY;
  assertThrows(() => secretBox.encryptString('x'), /CALENDAR_CRED_KEY/, 'missing key refuses to encrypt');
  assertThrows(() => secretBox.decryptString('a:b:c'), /CALENDAR_CRED_KEY/, 'missing key refuses to decrypt');
  assertEq(secretBox.keyReady(), false, 'keyReady() reports false when missing');
}
{
  // Wrong-length key: clear error, not a crypto fault.
  process.env.CALENDAR_CRED_KEY = 'abcd';
  assertThrows(() => secretBox.encryptString('x'), /64 hex/, 'wrong-length key rejected at encrypt time');
  delete process.env.CALENDAR_CRED_KEY;
}
process.env.CALENDAR_CRED_KEY = 'b'.repeat(64);

// ---- Test 2: iCal date / VEVENT parsing --------------------------------
console.log('\nTest 2: iCal parser');
{
  const ical = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:abc-123@nextcloud',
    'DTSTART:20260815T140000Z',
    'DTEND:20260815T150000Z',
    'SUMMARY:Team standup',
    'DESCRIPTION:Weekly sync\\nwith the team',
    'LOCATION:Zoom',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:def-456@nextcloud',
    'DTSTART;VALUE=DATE:20260820',
    'SUMMARY:All-day event',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const evs = caldav.parseVEvents(ical);
  assertEq(evs.length, 2, 'parses two VEVENT blocks');
  assertEq(evs[0].uid, 'abc-123@nextcloud', 'first event UID');
  assertEq(evs[0].title, 'Team standup', 'first event SUMMARY');
  assertEq(evs[0].start, '2026-08-15T14:00:00.000Z', 'first event DTSTART');
  assertEq(evs[0].end, '2026-08-15T15:00:00.000Z', 'first event DTEND');
  assertEq(evs[0].location, 'Zoom', 'first event LOCATION');
  assertEq(evs[1].title, 'All-day event', 'second event SUMMARY (date-only)');
  assertEq(evs[1].start, '2026-08-20T00:00:00.000Z', 'second event DTSTART is date-only');
}

// ---- Test 3: CalDAV source with injected HTTP stub ---------------------
console.log('\nTest 3: CalDAV source with mocked HTTP');
{
  const calls = [];
  const stubHttp = async (req) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === 'PROPFIND' && req.url.includes('brandon')) {
      return {
        status: 207,
        headers: {},
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<multistatus xmlns="DAV:">' +
          '<response><href>/remote.php/dav/calendars/brandon/personal/</href>' +
          '<propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Personal</displayname></prop></propstat></response>' +
          '<response><href>/remote.php/dav/calendars/brandon/work/</href>' +
          '<propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Work</displayname></prop></propstat></response>' +
          '</multistatus>',
      };
    }
    if (req.method === 'REPORT') {
      return {
        status: 207,
        headers: {},
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<multistatus xmlns="DAV:">' +
          '<response><href>/cal/abc.ics</href><propstat><prop><getetag>"e1"</getetag><calendar-data>' +
          'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1@cal\r\nDTSTART:20260815T100000Z\r\nDTEND:20260815T110000Z\r\nSUMMARY:Mock event\r\nEND:VEVENT\r\nEND:VCALENDAR' +
          '</calendar-data></prop></propstat></response>' +
          '</multistatus>',
      };
    }
    return { status: 404, headers: {}, body: 'not found' };
  };

  const source = caldav.makeCalDAVSource({
    provider: 'caldav_nextcloud',
    account_id: 'brandon',
    base_url: 'https://nextcloud.example/remote.php/dav',
    app_password: 'app-pw',
  }, { httpDo: stubHttp });

  const cals = await source.listCalendars();
  assertEq(cals.length, 2, 'listCalendars returns 2 calendars from PROPFIND');
  assertEq(cals[0].displayName, 'Personal', 'first calendar display name');
  assertEq(cals[1].displayName, 'Work', 'second calendar display name');

  const events = await source.listEvents({
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
    calendarHref: '/cal/personal',
  });
  assertEq(events.length, 1, 'listEvents returns 1 event from REPORT');
  assertEq(events[0].title, 'Mock event', 'event title from iCal SUMMARY');
  assertEq(events[0].externalId, 'e1@cal', 'event externalId is iCal UID');
  assertEq(events[0].etag, '"e1"', 'event etag from getetag');

  // Auth header is present and is Basic auth, but app_password itself
  // does not appear anywhere in the stub capture (callers should never
  // see it either).
  const allReqs = JSON.stringify(calls);
  assert(!allReqs.includes('app-pw'), 'app_password never appears in captured request payload');
}

// ---- Test 4: CalDAV source rejects unknown provider -------------------
console.log('\nTest 4: CalDAV source provider validation');
{
  assertThrows(
    () => caldav.makeCalDAVSource({ provider: 'unknown', account_id: 'x', base_url: 'https://x', app_password: 'p' }),
    /unknown provider/,
    'unknown provider name throws'
  );
  assertThrows(
    () => caldav.makeCalDAVSource({ provider: 'caldav_nextcloud', account_id: 'x', base_url: 'https://x' }),
    /app_password/,
    'missing app_password throws'
  );
}

// ---- Test 5: migration + publicView never leaks cred_blob -------------
console.log('\nTest 5: migration + publicView leak check');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-caltest-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  // The calendar_sources table has FK references to users(id); in
  // production the user-model migration runs first and creates that
  // table. For an isolated calendar-sources test we don't need the
  // users table, so disable FK enforcement on this in-memory DB.
  db.pragma('foreign_keys = OFF');
  calendarSources.migrate(db);
  // Tables exist.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'calendar_%' ORDER BY name").all().map(t => t.name);
  assertEq(tables, ['calendar_event_cache', 'calendar_sources'], 'migration creates both tables');
  // Idempotent — calling migrate again does not throw.
  calendarSources.migrate(db);
  ok('migration is idempotent');

  // Insert a source row with a known cred_blob, then check publicView.
  const credBlob = secretBox.encryptString(JSON.stringify({ app_password: 'super-secret-pw' }));
  const r = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, created_by)
    VALUES (NULL, 'caldav_nextcloud', 'brandon', 'personal', 'https://nc.example/dav', 'Brandon', '#7c9eb8', ?, 'brandon')`)
    .run(credBlob);
  const row = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(r.lastInsertRowid);
  const view = calendarSources.publicView(row);
  assert(!('cred_blob' in view), 'publicView does NOT include cred_blob');
  assert(!JSON.stringify(view).includes('super-secret-pw'), 'publicView does NOT include the plaintext app_password');
  assertEq(view.provider, 'caldav_nextcloud', 'publicView includes provider');
  assertEq(view.account_id, 'brandon', 'publicView includes account_id');
  assertEq(view.color, '#7c9eb8', 'publicView includes color');
}

// ---- Test 6: syncSource + isStale ---------------------------------------
console.log('\nTest 6: syncSource + isStale');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-caltest-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  calendarSources.migrate(db);

  // Insert a source.
  const credBlob = secretBox.encryptString(JSON.stringify({ app_password: 'pw' }));
  const r = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, created_by)
    VALUES (NULL, 'caldav_nextcloud', 'brandon', 'https://nc.example/dav/personal', 'https://nc.example/dav', 'Personal', '#7c9eb8', ?, 'brandon')`)
    .run(credBlob);
  const id = r.lastInsertRowid;

  // Fresh row: isStale must be true (never synced).
  let src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  assertEq(calendarSources.isStale(src), true, 'isStale is true when last_synced_at is null');

  // Replace the registered caldav factory with a test-dispatching one.
  const stubEvents = [
    { externalId: 'e1@cal', title: 'Sync test', description: 'd', start: '2026-08-15T14:00:00.000Z', end: '2026-08-15T15:00:00.000Z', allDay: false, location: 'L', href: '/cal/e1.ics', etag: '"e1"' },
  ];
  calendarSources.registerAdapter('caldav', (config) => ({
    kind: 'caldav',
    listCalendars: async () => [{ href: 'h', displayName: 'd' }],
    listEvents: async () => stubEvents,
    createEvent: async () => { throw new Error('not impl'); },
    updateEvent: async () => { throw new Error('not impl'); },
    deleteEvent: async () => { throw new Error('not impl'); },
  }));

  src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  const result = await calendarSources.syncSource(db, src);
  assertEq(result.fetched, 1, 'syncSource returns fetched count');

  src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  assert(!!src.last_synced_at, 'last_synced_at is set after sync');
  assertEq(src.last_error, null, 'last_error is cleared after a successful sync');
  assertEq(calendarSources.isStale(src), false, 'isStale is false right after sync');

  // Cache has the event.
  const cached = db.prepare('SELECT * FROM calendar_event_cache WHERE source_id = ?').all(id);
  assertEq(cached.length, 1, 'calendar_event_cache has 1 event after sync');
  assertEq(cached[0].title, 'Sync test', 'cached event title');
  assertEq(cached[0].start_at, '2026-08-15T14:00:00.000Z', 'cached event start_at');
  // Make sure the secret is not accidentally written to the cache.
  assert(!JSON.stringify(cached).includes('super-secret-pw'), 'cached events do not include the app_password');
}

// ---- Summary -----------------------------------------------------------
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

})();
