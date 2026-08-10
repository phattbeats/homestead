#!/usr/bin/env node
// PHA-1865 acceptance tests for the Google Calendar source adapter.
//
// Covers:
//   * makeGoogleSource factory shape + validation
//   * listEvents() happy path: maps Google event JSON to the
//     CalendarSource contract fields (timed + all-day)
//   * listCalendars() mapping
//   * Bearer auth header is set, and the access_token itself does
//     NOT leak into the URL or request body
//   * Refresh-on-401 path (HTTP stubbed): a 401 triggers one
//     refresh-and-retry round-trip
//   * Pre-emptive refresh when the token is past expires_at
//   * PublicView still hides cred_blob — sanity check that adding
//     Google support didn't introduce a leak in the DTO layer
//
// Same in-process stubbing approach as scripts/test-calendar-sources.js
// and scripts/test-graph-source.js: httpDo is injected, no real
// Google calls.

'use strict';

(async () => {

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const secretBox = require('../lib/secret-box');
const googleSource = require('../lib/google-source');
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

console.log('PHA-1865 google-source tests\n');

// ---- Test 1: factory validation ---------------------------------------
console.log('Test 1: factory validation');
{
  assertThrows(
    () => googleSource.makeGoogleSource({}),
    /provider is required/,
    'missing provider throws'
  );
  assertThrows(
    () => googleSource.makeGoogleSource({ provider: 'google' }),
    /access_token is required/,
    'missing access_token throws'
  );
  assertThrows(
    () => googleSource.makeGoogleSource({ provider: 'caldav_nextcloud', access_token: 'x' }),
    /unknown provider/,
    'wrong provider throws'
  );
  // Valid construction returns the adapter contract shape.
  const src = googleSource.makeGoogleSource({
    provider: 'google',
    account_id: 'brandon@phatt.tech',
    access_token: 'fake-token',
    refresh_token: 'fake-refresh',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app-id.apps.googleusercontent.com',
    client_secret: 'fake-secret',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
  });
  assertEq(src.kind, 'google', 'adapter.kind is "google"');
  assertEq(src.provider, 'google', 'adapter.provider is "google"');
  assert(typeof src.listCalendars === 'function', 'listCalendars is a function');
  assert(typeof src.listEvents === 'function', 'listEvents is a function');
  // Phase-2 stubs throw, like CalDAV/Graph's.
  await (async () => {
    try { await src.createEvent({}); ng('createEvent should throw'); }
    catch (e) { if (/Phase 2/.test(e.message)) ok('createEvent is a Phase-2 stub'); else ng('createEvent wrong error', e.message); }
    try { await src.updateEvent({}); ng('updateEvent should throw'); }
    catch (e) { if (/Phase 2/.test(e.message)) ok('updateEvent is a Phase-2 stub'); else ng('updateEvent wrong error', e.message); }
    try { await src.deleteEvent({}); ng('deleteEvent should throw'); }
    catch (e) { if (/Phase 2/.test(e.message)) ok('deleteEvent is a Phase-2 stub'); else ng('deleteEvent wrong error', e.message); }
  })();
}

// ---- Test 2: listEvents happy path with mocked Google -----------------
console.log('\nTest 2: listEvents with mocked Google');
{
  const calls = [];
  const stubHttp = async (req) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url.includes('/calendars/') && req.url.includes('/events')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            {
              id: 'evt-standup',
              summary: 'Standup',
              description: 'Daily standup notes',
              start: { dateTime: '2026-08-15T14:00:00-04:00', timeZone: 'America/New_York' },
              end:   { dateTime: '2026-08-15T15:00:00-04:00', timeZone: 'America/New_York' },
              location: 'Zoom',
              htmlLink: 'https://calendar.google.com/calendar/event?eid=evt-standup',
              etag: '"p33f8k6k5k5k5"',
            },
            {
              id: 'evt-all-day-off',
              summary: 'All day off',
              start: { date: '2026-08-20' },
              end:   { date: '2026-08-21' },
            },
          ],
          nextPageToken: null,
        }),
      };
    }
    return { status: 404, headers: {}, body: '{"error":"not found"}' };
  };

  const adapter = googleSource.makeGoogleSource({
    provider: 'google',
    account_id: 'brandon@phatt.tech',
    access_token: 'fake-token-xyz',
    refresh_token: 'fake-refresh-xyz',
    expires_at: '2099-01-01T00:00:00Z', // never expires during this test
    client_id: 'app-id.apps.googleusercontent.com',
  }, { httpDo: stubHttp });

  const events = await adapter.listEvents({
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
    calendarHref: 'brandon@phatt.tech',
  });

  assertEq(events.length, 2, 'listEvents returns 2 mapped events');

  // The first event was at 14:00 EDT (-04:00) so it lands at 18:00Z.
  assertEq(events[0].externalId, 'evt-standup', 'first event externalId from Google id');
  assertEq(events[0].title, 'Standup', 'first event title from summary');
  assertEq(events[0].start, '2026-08-15T18:00:00.000Z', 'first event start normalized to ISO UTC (14:00 EDT -> 18:00Z)');
  assertEq(events[0].end, '2026-08-15T19:00:00.000Z', 'first event end normalized to UTC');
  assertEq(events[0].location, 'Zoom', 'first event location passes through');
  assertEq(events[0].allDay, false, 'first event allDay is false');
  assertEq(events[0].etag, '"p33f8k6k5k5k5"', 'first event etag passes through');
  assertEq(events[0].href, 'https://calendar.google.com/calendar/event?eid=evt-standup', 'first event href from htmlLink');

  assertEq(events[1].title, 'All day off', 'second event title');
  assertEq(events[1].allDay, true, 'second event allDay is true');
  assertEq(events[1].start, '2026-08-20T00:00:00.000Z', 'all-day event start anchored to midnight UTC');
  assertEq(events[1].end, '2026-08-21T00:00:00.000Z', 'all-day event end anchored to midnight UTC');

  // Bearer auth: every request includes Authorization: Bearer fake-token-xyz
  // (case-insensitive header lookup; HTTP/1.1 header names are
  // case-insensitive in practice — Node lowercases them on the wire).
  const authed = calls.filter(c => {
    const h = c.headers || {};
    const auth = h.authorization || h.Authorization || '';
    return auth.includes('Bearer fake-token-xyz');
  });
  assertEq(authed.length, calls.length, 'every request includes the Bearer access_token');

  // The access_token MUST NOT leak into the URL. The refresh_token
  // MUST NOT appear anywhere in the captured requests.
  const allCalls = JSON.stringify(calls);
  assert(!allCalls.includes('fake-refresh-xyz'), 'refresh_token never appears in URL or request body');
  assert(!allCalls.includes('fake-token-xyz') || allCalls.split('fake-token-xyz').length === authed.length + 1,
    'access_token appears only inside the Authorization header');

  // The query parameters Google expects MUST be sent.
  const listCall = calls.find(c => c.url.includes('/events'));
  assert(!!listCall, 'a /events request was issued');
  assert(listCall.url.includes('timeMin='), 'events request includes timeMin');
  assert(listCall.url.includes('timeMax='), 'events request includes timeMax');
  assert(listCall.url.includes('singleEvents=true'), 'events request sets singleEvents=true');
  assert(listCall.url.includes('orderBy=startTime'), 'events request sets orderBy=startTime');
}

// ---- Test 3: listCalendars --------------------------------------------
console.log('\nTest 3: listCalendars');
{
  const stubHttp = async (req) => {
    if (req.url.includes('/users/me/calendarList')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            { id: 'brandon@phatt.tech', summary: 'Personal', backgroundColor: '#a4c2f4', primary: true, accessRole: 'owner' },
            { id: 'family@group.calendar.google.com', summary: 'Family', backgroundColor: '#e4c4a4', primary: false, accessRole: 'reader' },
          ],
        }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  const adapter = googleSource.makeGoogleSource({
    provider: 'google', access_token: 'tok', expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app',
  }, { httpDo: stubHttp });
  const cals = await adapter.listCalendars();
  assertEq(cals.length, 2, 'listCalendars returns 2 calendars');
  assertEq(cals[0].href, 'brandon@phatt.tech', 'calendar href from id');
  assertEq(cals[0].displayName, 'Personal', 'calendar displayName from summary');
  assertEq(cals[0].isDefault, true, 'primary is mapped to isDefault');
  assertEq(cals[0].canEdit, true, 'owner accessRole -> canEdit true');
  assertEq(cals[1].canEdit, false, 'reader accessRole -> canEdit false');
  assertEq(cals[1].color, '#e4c4a4', 'color passes through from backgroundColor');
}

// ---- Test 4: refresh-on-401 round-trip --------------------------------
console.log('\nTest 4: refresh-on-401');
{
  let refreshCalled = 0;
  const stubHttp = async (req) => {
    if (req.url.includes('oauth2.googleapis.com/token')) {
      refreshCalled++;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'refreshed-token',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
        }),
      };
    }
    if (req.url.includes('/calendars/') && req.url.includes('/events')) {
      // First call: 401. Second call (after refresh): 200. The auth
      // header lookup is case-insensitive — real Node HTTP normalizes
      // header names to lowercase on the wire.
      const auth = (req.headers.authorization || req.headers.Authorization || '');
      if (auth.includes('fake-token')) {
        return { status: 401, headers: {}, body: '{"error":{"message":"Invalid Credentials"}}' };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            { id: 'c1', summary: 'After refresh', start: { dateTime: '2026-08-15T10:00:00Z' }, end: { dateTime: '2026-08-15T11:00:00Z' } },
          ],
          nextPageToken: null,
        }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };

  let savedToken = null;
  const onRefresh = async (fresh) => { savedToken = fresh; };

  const adapter = googleSource.makeGoogleSource({
    provider: 'google',
    access_token: 'fake-token',
    refresh_token: 'fake-refresh',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app-id',
    client_secret: 'app-secret',
  }, { httpDo: stubHttp, onTokenRefresh: onRefresh });

  const events = await adapter.listEvents({
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
    calendarHref: 'c1',
  });
  assertEq(events.length, 1, 'listEvents succeeds after refresh');
  assertEq(events[0].title, 'After refresh', 'event title from refreshed-token request');
  assertEq(refreshCalled, 1, 'refresh token endpoint was called exactly once');
  assertEq(savedToken && savedToken.access_token, 'refreshed-token', 'onTokenRefresh hook fires with new token');
}

// ---- Test 5: pre-emptive refresh on stale expires_at ------------------
console.log('\nTest 5: pre-emptive refresh when expires_at is in the past');
{
  let refreshCalled = 0;
  const stubHttp = async (req) => {
    if (req.url.includes('oauth2.googleapis.com/token')) {
      refreshCalled++;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600 }),
      };
    }
    if (req.url.includes('/events')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            { id: 'c1', summary: 'After preemptive refresh', start: { dateTime: '2026-08-15T10:00:00Z' }, end: { dateTime: '2026-08-15T11:00:00Z' } },
          ],
          nextPageToken: null,
        }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  const adapter = googleSource.makeGoogleSource({
    provider: 'google',
    access_token: 'old-token',
    refresh_token: 'old-refresh',
    expires_at: '2020-01-01T00:00:00Z', // well in the past
    client_id: 'app',
  }, { httpDo: stubHttp });

  const events = await adapter.listEvents({
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
    calendarHref: 'c1',
  });
  assertEq(refreshCalled, 1, 'pre-emptive refresh triggered when expires_at is past');
  assertEq(events.length, 1, 'listEvents succeeds after pre-emptive refresh');
  assertEq(events[0].title, 'After preemptive refresh', 'event fetched with refreshed token');
}

// ---- Test 6: pagination safety brake ----------------------------------
console.log('\nTest 6: pagination safety brake');
{
  // Force an infinite nextPageToken — adapter must stop at pageCount > 20.
  let pageCount = 0;
  const stubHttp = async (req) => {
    if (req.url.includes('/events')) {
      pageCount++;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [],
          nextPageToken: 'forever',
        }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  const adapter = googleSource.makeGoogleSource({
    provider: 'google',
    access_token: 'tok',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app',
  }, { httpDo: stubHttp });
  let threw = false;
  try {
    await adapter.listEvents({ start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z', calendarHref: 'c1' });
  } catch (e) {
    threw = /exceeded 20 pages/.test(e.message);
  }
  assert(threw, 'listEvents throws when pagination exceeds 20 pages');
  assertEq(pageCount, 21, 'pagination stopped at exactly 21 requests');
}

// ---- Test 7: listEvents falls through to primary when no calendarHref -
console.log('\nTest 7: listEvents with calendarHref undefined falls through to primary');
{
  const calls = [];
  const stubHttp = async (req) => {
    calls.push({ url: req.url });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        items: [
          { id: 'primary-evt', summary: 'Primary event', start: { dateTime: '2026-08-15T10:00:00Z' }, end: { dateTime: '2026-08-15T11:00:00Z' } },
        ],
        nextPageToken: null,
      }),
    };
  };
  const adapter = googleSource.makeGoogleSource({
    provider: 'google',
    access_token: 'tok',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app',
  }, { httpDo: stubHttp });
  const events = await adapter.listEvents({
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
  });
  assertEq(events.length, 1, 'listEvents returns the primary-calendar event');
  assertEq(events[0].title, 'Primary event', 'primary event title');
  assert(calls[0].url.includes('/calendars/primary/events'), 'falls through to /calendars/primary/events');
}

// ---- Test 8: googleDateTimeToIso edge cases ----------------------------
console.log('\nTest 8: googleDateTimeToIso edge cases');
{
  const { googleDateTimeToIso } = googleSource;
  assertEq(googleDateTimeToIso({ dateTime: '2026-08-15T14:00:00-04:00' }), '2026-08-15T18:00:00.000Z', 'timed event with offset is normalized to UTC');
  assertEq(googleDateTimeToIso({ dateTime: '2026-08-15T14:00:00Z' }), '2026-08-15T14:00:00.000Z', 'timed event with Z is normalized to UTC');
  assertEq(googleDateTimeToIso({ date: '2026-08-20' }), '2026-08-20T00:00:00.000Z', 'all-day date is anchored to midnight UTC');
  assertEq(googleDateTimeToIso(null), null, 'null returns null');
  assertEq(googleDateTimeToIso({}), null, 'empty object returns null');
  assertEq(googleDateTimeToIso({ dateTime: 'not-a-date' }), null, 'invalid dateTime returns null');
}

// ---- Test 9: syncSource end-to-end via calendar-sources module --------
console.log('\nTest 9: syncSource through calendar-sources');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-googletest-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  calendarSources.migrate(db);

  process.env.CALENDAR_CRED_KEY = 'e'.repeat(64);
  const credBlob = secretBox.encryptString(JSON.stringify({
    access_token: 'tok-A',
    refresh_token: 'ref-A',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app-A',
    client_secret: 'secret-A',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
  }));
  const r = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, created_by)
    VALUES (NULL, 'google', 'brandon@phatt.tech', 'primary', NULL, 'Google Calendar', '#a4c2f4', ?, 'brandon')`)
    .run(credBlob);
  const id = r.lastInsertRowid;

  // Replace the registered google factory with a stub dispatching canned events.
  const stubEvents = [
    {
      externalId: 'evt-1',
      etag: '"1"',
      title: 'Sync target event',
      description: 'desc',
      start: '2026-08-15T14:00:00.000Z',
      end: '2026-08-15T15:00:00.000Z',
      allDay: false,
      location: 'Room 1',
      href: 'https://calendar.google.com/calendar/event?eid=evt-1',
    },
  ];
  calendarSources.registerAdapter('google', (config) => ({
    kind: 'google',
    listCalendars: async () => [{ href: 'c', displayName: 'c' }],
    listEvents: async () => stubEvents,
    createEvent: async () => { throw new Error('Phase 2'); },
    updateEvent: async () => { throw new Error('Phase 2'); },
    deleteEvent: async () => { throw new Error('Phase 2'); },
  }));

  const src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  const out = await calendarSources.syncSource(db, src);
  assertEq(out.fetched, 1, 'syncSource returns fetched=1 for the google adapter');

  const updated = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  assert(!!updated.last_synced_at, 'last_synced_at is set after sync');
  assertEq(updated.last_error, null, 'last_error is null after a successful sync');

  const cached = db.prepare('SELECT * FROM calendar_event_cache WHERE source_id = ?').all(id);
  assertEq(cached.length, 1, 'calendar_event_cache has the google event after sync');
  assertEq(cached[0].title, 'Sync target event', 'cached event title');
  assertEq(cached[0].source_id, id, 'cached event source_id matches source row');

  // publicView leak-check is the load-bearing acceptance test for the
  // credential-at-rest story. Re-verify it here so the Google path
  // can't regress the DTO layer.
  const view = calendarSources.publicView(updated);
  assert(!('cred_blob' in view), 'publicView does NOT include cred_blob (google)');
  assert(!JSON.stringify(view).includes('tok-A'), 'publicView does NOT include the plaintext access_token');
  assert(!JSON.stringify(view).includes('ref-A'), 'publicView does NOT include the plaintext refresh_token');
  assert(!JSON.stringify(view).includes('secret-A'), 'publicView does NOT include the plaintext client_secret');
}

// ---- Summary -----------------------------------------------------------
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

})();