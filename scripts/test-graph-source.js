#!/usr/bin/env node
// PHA-1864 acceptance tests for the Graph (MS365) source adapter.
//
// Covers:
//   * makeGraphSource factory shape + validation
//   * listEvents() happy path: maps Graph event JSON to the
//     CalendarSource contract fields
//   * listCalendars() mapping
//   * Bearer auth header is set, and the access_token itself does
//     NOT leak into the URL or request body
//   * Refresh-on-401 path (HTTP stubbed): a 401 triggers one
//     refresh-and-retry round-trip
//   * Pre-emptive refresh when the token is past expires_at
//   * PublicView still hides cred_blob — sanity check that adding
//     Graph support didn't introduce a leak in the DTO layer
//
// Same in-process stubbing approach as scripts/test-calendar-sources.js:
// httpDo is injected, no real Graph calls.

'use strict';

(async () => {

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const secretBox = require('../lib/secret-box');
const graphSource = require('../lib/graph-source');
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

console.log('PHA-1864 graph-source tests\n');

// ---- Test 1: factory validation ---------------------------------------
console.log('Test 1: factory validation');
{
  assertThrows(
    () => graphSource.makeGraphSource({}),
    /provider is required/,
    'missing provider throws'
  );
  assertThrows(
    () => graphSource.makeGraphSource({ provider: 'ms365' }),
    /access_token is required/,
    'missing access_token throws'
  );
  assertThrows(
    () => graphSource.makeGraphSource({ provider: 'caldav_nextcloud', access_token: 'x' }),
    /unknown provider/,
    'wrong provider throws'
  );
  // Valid construction returns the adapter contract shape.
  const src = graphSource.makeGraphSource({
    provider: 'ms365',
    account_id: 'brandon@phatt.tech',
    access_token: 'fake-token',
    refresh_token: 'fake-refresh',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app-id',
    tenant_id: 'common',
  });
  assertEq(src.kind, 'graph', 'adapter.kind is "graph"');
  assertEq(src.provider, 'ms365', 'adapter.provider is "ms365"');
  assert(typeof src.listCalendars === 'function', 'listCalendars is a function');
  assert(typeof src.listEvents === 'function', 'listEvents is a function');
  // Phase-2 stubs throw, like CalDAV's.
  await (async () => {
    try { await src.createEvent({}); ng('createEvent should throw'); }
    catch (e) { if (/Phase 2/.test(e.message)) ok('createEvent is a Phase-2 stub'); else ng('createEvent wrong error', e.message); }
    try { await src.updateEvent({}); ng('updateEvent should throw'); }
    catch (e) { if (/Phase 2/.test(e.message)) ok('updateEvent is a Phase-2 stub'); else ng('updateEvent wrong error', e.message); }
    try { await src.deleteEvent({}); ng('deleteEvent should throw'); }
    catch (e) { if (/Phase 2/.test(e.message)) ok('deleteEvent is a Phase-2 stub'); else ng('deleteEvent wrong error', e.message); }
  })();
}

// ---- Test 2: listEvents happy path with mocked Graph ------------------
console.log('\nTest 2: listEvents with mocked Graph');
{
  const calls = [];
  const stubHttp = async (req) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url.includes('/me/calendars/') && req.url.includes('/calendarView')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          value: [
            {
              id: 'AAMkAGRiYW5kb24tY2Fs',
              subject: 'Standup',
              bodyPreview: 'Daily standup notes',
              start: { dateTime: '2026-08-15T14:00:00.0000000', timeZone: 'UTC' },
              end:   { dateTime: '2026-08-15T15:00:00.0000000', timeZone: 'UTC' },
              location: { displayName: 'Zoom' },
              isAllDay: false,
              webLink: 'https://outlook.office365.com/calendar/item/abc',
              '@odata.etag': 'W/"abc123"',
            },
            {
              id: 'AAMkAGRiYW5kb24tLWFsbERheQ',
              subject: 'All day off',
              start: { dateTime: '2026-08-20', timeZone: 'UTC' },
              end:   { dateTime: '2026-08-21', timeZone: 'UTC' },
              isAllDay: true,
              location: null,
            },
          ],
          '@odata.nextLink': null,
        }),
      };
    }
    return { status: 404, headers: {}, body: '{"error":"not found"}' };
  };

  const adapter = graphSource.makeGraphSource({
    provider: 'ms365',
    account_id: 'brandon@phatt.tech',
    access_token: 'fake-token-xyz',
    refresh_token: 'fake-refresh-xyz',
    expires_at: '2099-01-01T00:00:00Z', // never expires during this test
    client_id: 'app-id-xyz',
    tenant_id: 'common',
  }, { httpDo: stubHttp });

  const events = await adapter.listEvents({
    start: '2026-08-01T00:00:00Z',
    end: '2026-09-01T00:00:00Z',
    calendarHref: 'AAMkAGRiYW5kb24tY2Fs',
  });

  assertEq(events.length, 2, 'listEvents returns 2 mapped events');

  assertEq(events[0].externalId, 'AAMkAGRiYW5kb24tY2Fs', 'first event externalId from Graph id');
  assertEq(events[0].title, 'Standup', 'first event title from subject');
  assertEq(events[0].start, '2026-08-15T14:00:00.000Z', 'first event start normalized to ISO UTC');
  assertEq(events[0].end, '2026-08-15T15:00:00.000Z', 'first event end normalized');
  assertEq(events[0].location, 'Zoom', 'first event location.displayName');
  assertEq(events[0].allDay, false, 'first event allDay is false');
  assertEq(events[0].etag, 'W/"abc123"', 'first event etag from @odata.etag');
  assertEq(events[0].href, 'https://outlook.office365.com/calendar/item/abc', 'first event href from webLink');

  assertEq(events[1].title, 'All day off', 'second event title');
  assertEq(events[1].allDay, true, 'second event allDay is true');
  assertEq(events[1].start, '2026-08-20T00:00:00.000Z', 'all-day event start anchored to midnight UTC');

  // Bearer auth: every request includes Authorization: Bearer fake-token-xyz
  // (case-insensitive header lookup; HTTP/1.1 header names are
  // case-insensitive in practice — Node lowercases them on the wire).
  const authed = calls.filter(c => {
    const h = c.headers || {};
    const auth = h.authorization || h.Authorization || '';
    return auth.includes('Bearer fake-token-xyz');
  });
  assertEq(authed.length, calls.length, 'every request includes the Bearer access_token');

  // The access_token MUST NOT leak into the URL or any captured body.
  const allCalls = JSON.stringify(calls);
  assert(!allCalls.includes('fake-refresh-xyz'), 'refresh_token never appears in URL');
  assert(!allCalls.includes('fake-token-xyz') || allCalls.split('fake-token-xyz').length === authed.length + 1,
    'access_token appears only inside the Authorization header');
}

// ---- Test 3: listCalendars -------------------------------------------
console.log('\nTest 3: listCalendars');
{
  const stubHttp = async (req) => {
    if (req.url.includes('/me/calendars')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          value: [
            { id: 'cal-1', name: 'Personal', color: 'auto', canEdit: true, isDefaultCalendar: true },
            { id: 'cal-2', name: 'Work', color: 'lightBlue', canEdit: true, isDefaultCalendar: false },
          ],
        }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  const adapter = graphSource.makeGraphSource({
    provider: 'ms365', access_token: 'tok', expires_at: '2099-01-01T00:00:00Z',
  }, { httpDo: stubHttp });
  const cals = await adapter.listCalendars();
  assertEq(cals.length, 2, 'listCalendars returns 2 calendars');
  assertEq(cals[0].href, 'cal-1', 'calendar href from id');
  assertEq(cals[0].displayName, 'Personal', 'calendar displayName from name');
  assertEq(cals[0].isDefault, true, 'isDefaultCalendar is mapped');
  assertEq(cals[1].color, 'lightBlue', 'color passes through');
}

// ---- Test 4: refresh-on-401 round-trip --------------------------------
console.log('\nTest 4: refresh-on-401');
{
  let refreshCalled = 0;
  const stubHttp = async (req) => {
    if (req.url.includes('oauth2/v2.0/token')) {
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
    if (req.url.includes('/me/calendars/')) {
      // First call: 401. Second call (after refresh): 200. The auth
      // header lookup is case-insensitive — real Node HTTP normalizes
      // header names to lowercase on the wire.
      const auth = (req.headers.authorization || req.headers.Authorization || '');
      if (auth.includes('fake-token')) {
        return { status: 401, headers: {}, body: '{"error":"token expired"}' };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          value: [
            { id: 'c1', subject: 'After refresh', start: { dateTime: '2026-08-15T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-08-15T11:00:00.0000000', timeZone: 'UTC' }, isAllDay: false },
          ],
        }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };

  let savedToken = null;
  const onRefresh = async (fresh) => { savedToken = fresh; };

  const adapter = graphSource.makeGraphSource({
    provider: 'ms365',
    access_token: 'fake-token',
    refresh_token: 'fake-refresh',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app',
    tenant_id: 'common',
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
    if (req.url.includes('oauth2/v2.0/token')) {
      refreshCalled++;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600 }),
      };
    }
    if (req.url.includes('/me/calendars/')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ value: [
          { id: 'c1', subject: 'After preemptive refresh', start: { dateTime: '2026-08-15T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-08-15T11:00:00.0000000', timeZone: 'UTC' }, isAllDay: false },
        ] }),
      };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  const adapter = graphSource.makeGraphSource({
    provider: 'ms365',
    access_token: 'old-token',
    refresh_token: 'old-refresh',
    expires_at: '2020-01-01T00:00:00Z', // well in the past
    client_id: 'app',
    tenant_id: 'common',
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

// ---- Test 6: syncSource end-to-end via calendar-sources module --------
console.log('\nTest 6: syncSource through calendar-sources');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-graphtest-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  calendarSources.migrate(db);

  process.env.CALENDAR_CRED_KEY = 'e'.repeat(64);
  const credBlob = secretBox.encryptString(JSON.stringify({
    access_token: 'tok-A',
    refresh_token: 'ref-A',
    expires_at: '2099-01-01T00:00:00Z',
    client_id: 'app',
    tenant_id: 'common',
  }));
  const r = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, created_by)
    VALUES (NULL, 'ms365', 'brandon@phatt.tech', 'AAMkAGRiYW5kb24t', NULL, 'MS365 Calendar', '#7c9eb8', ?, 'brandon')`)
    .run(credBlob);
  const id = r.lastInsertRowid;

  // Replace the registered graph factory with a stub dispatching canned events.
  const stubEvents = [
    {
      externalId: 'evt-1',
      etag: 'W/"1"',
      title: 'Sync target event',
      description: 'desc',
      start: '2026-08-15T14:00:00.000Z',
      end: '2026-08-15T15:00:00.000Z',
      allDay: false,
      location: 'Room 1',
      href: 'https://outlook.example/calendar/item/evt-1',
    },
  ];
  calendarSources.registerAdapter('graph', (config) => ({
    kind: 'graph',
    listCalendars: async () => [{ href: 'c', displayName: 'c' }],
    listEvents: async () => stubEvents,
    createEvent: async () => { throw new Error('Phase 2'); },
    updateEvent: async () => { throw new Error('Phase 2'); },
    deleteEvent: async () => { throw new Error('Phase 2'); },
  }));

  const src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  const out = await calendarSources.syncSource(db, src);
  assertEq(out.fetched, 1, 'syncSource returns fetched=1 for the graph adapter');

  const updated = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
  assert(!!updated.last_synced_at, 'last_synced_at is set after sync');
  assertEq(updated.last_error, null, 'last_error is null after a successful sync');

  const cached = db.prepare('SELECT * FROM calendar_event_cache WHERE source_id = ?').all(id);
  assertEq(cached.length, 1, 'calendar_event_cache has the graph event after sync');
  assertEq(cached[0].title, 'Sync target event', 'cached event title');
  assertEq(cached[0].source_id, id, 'cached event source_id matches source row');

  // publicView leak-check is the load-bearing acceptance test for the
  // credential-at-rest story. Re-verify it here so the Graph path can't
  // regress the DTO layer.
  const view = calendarSources.publicView(updated);
  assert(!('cred_blob' in view), 'publicView does NOT include cred_blob (ms365)');
  assert(!JSON.stringify(view).includes('tok-A'), 'publicView does NOT include the plaintext access_token');
  assert(!JSON.stringify(view).includes('ref-A'), 'publicView does NOT include the plaintext refresh_token');
}

// ---- Summary -----------------------------------------------------------
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

})();