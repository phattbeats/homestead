#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1864 calendar-sources smoke test (Graph / MS365):
// boot server.js in-process with a fake Microsoft Graph server, mint
// an admin session via /api/login, add an ms365 calendar source, kick
// a refresh, hit /api/events/merged, and verify the provider events
// flow through. Designed to fail loudly when the browser-side
// credentials leak contract is broken — same pattern as
// scripts/smoke-calendar-sources.js but against the Graph endpoint
// shape (`/me/calendars/{id}/calendarView`).
//
// Run after `npm test`:
//   CALENDAR_CRED_KEY=$(openssl rand -hex 32) \
//     node scripts/smoke-graph-source.js
//
// Exits 0 on success, 1 on any failure.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-graph-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3094';
process.env.ADMIN_PASSWORD = 'smoketest-admin-pw';
process.env.BRANDON_PASSWORD = 'smoketest-brandon-pw';
process.env.SESSION_SECRET = 'smoke-test-secret-graph';
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

// ---- 1. Boot a tiny fake Graph server on a free port ---------------
const fakeGraphPort = 4099;
let graphHits = [];
let refreshHits = 0;
const fakeGraph = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    graphHits.push({ method: req.method, url: req.url, headers: req.headers, body });
    // Azure AD token endpoint — used by the refresh-on-401 path. We
    // don't trigger refresh in this smoke (the access token we ship
    // never expires during the test window), but if a future run does,
    // mint a fresh token transparently.
    if (req.url.includes('oauth2/v2.0/token')) {
      refreshHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 3600,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/me/calendars/') && req.url.includes('/calendarView')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:graph-smoke-1\r\nDTSTART:20260815T100000Z\r\nDTEND:20260815T110000Z\r\nSUMMARY:Graph smoke event\r\nEND:VEVENT\r\nEND:VCALENDAR';
      res.end(JSON.stringify({
        value: [
          {
            id: 'AAMkAGRiYXNk',
            subject: 'Graph smoke event',
            bodyPreview: 'smoke',
            start: { dateTime: '2026-08-15T10:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-08-15T11:00:00.0000000', timeZone: 'UTC' },
            isAllDay: false,
            location: { displayName: 'Office' },
            webLink: 'https://outlook.example/calendar/item/AAMkAGRiYXNk',
            '@odata.etag': 'W/"graph-1"',
          },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

(async () => {
  await new Promise((r) => fakeGraph.listen(fakeGraphPort, '127.0.0.1', r));
  console.log(`[smoke] fake Graph on :${fakeGraphPort}`);

  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    const srv = app.listen(3094, '127.0.0.1', () => { console.log('[smoke] homestead listening on :3094'); resolve(srv); });
    srv.on('error', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3094/api/health');
      if (r.ok && (await r.json()).calendarCredKeyReady === true) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots and reports calendarCredKeyReady=true');

  try {
    // Login as admin.
    const loginRes = await fetch('http://127.0.0.1:3094/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'smoketest-admin-pw' }),
    });
    assertEq(loginRes.status, 200, 'admin login returns 200');
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    if (!cookie.includes('connect.sid')) throw new Error('no connect.sid cookie');
    ok('session cookie captured');

    // Add a calendar source pointing at the fake Graph.
    // We deliberately use a far-future expires_at so the test doesn't
    // hit the refresh path (the refresh path is exercised by
    // test-graph-source.js, which is a unit test).
    const ACCESS_TOKEN = 'super-secret-access-token-NEVER-LEAK';
    const REFRESH_TOKEN = 'super-secret-refresh-token-NEVER-LEAK';
    const createRes = await fetch('http://127.0.0.1:3094/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'ms365',
        account_id: 'smoketest@phatt.example',
        calendar_id: 'AAMkAGRiYXNk',
        base_url: `http://127.0.0.1:${fakeGraphPort}/v1.0`,
        display_name: 'Graph Smoke',
        color: '#8a9ec4',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_at: '2099-01-01T00:00:00Z',
        client_id: 'smoke-app',
        tenant_id: 'common',
        scope: 'Calendars.Read offline_access',
      }),
    });
    assertEq(createRes.status, 200, 'POST /api/calendar-sources returns 200 (ms365)');
    const createBody = await createRes.text();
    const created = JSON.parse(createBody);
    assert(!('cred_blob' in created), 'created source response does NOT contain cred_blob');
    assert(!createBody.includes(ACCESS_TOKEN), 'created source response does NOT contain plaintext access_token');
    assert(!createBody.includes(REFRESH_TOKEN), 'created source response does NOT contain plaintext refresh_token');
    ok('cred_blob leak check on POST response (ms365)');
    const sourceId = created.id;

    // Kick a sync.
    const refreshRes = await fetch(`http://127.0.0.1:3094/api/calendar-sources/${sourceId}/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assertEq(refreshRes.status, 200, 'POST /api/calendar-sources/:id/refresh returns 200');

    // Wait for the sync to land (async fire-and-forget in server.js).
    for (let i = 0; i < 30; i++) {
      if (graphHits.some((h) => h.url.includes('/calendarView'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const calViewHits = graphHits.filter((h) => h.url.includes('/calendarView'));
    assert(calViewHits.length >= 1, `fake Graph received ${calViewHits.length} calendarView request(s)`);

    // Confirm the fake Graph saw a Bearer auth header, NOT plaintext
    // credentials in the URL or body.
    const sawBearer = calViewHits.some((h) => (h.headers.authorization || '').startsWith('Bearer '));
    assert(sawBearer, 'fake Graph saw a Bearer Authorization header');
    const allHitsJson = JSON.stringify(graphHits);
    assert(!allHitsJson.includes(REFRESH_TOKEN), 'refresh_token never appears in any Graph request URL or body');
    assert(allHitsJson.includes(ACCESS_TOKEN),
      'access_token IS sent on the wire (inside the Authorization header) — sanity check');

    // Hit /api/events/merged over a window that includes the smoke event.
    const mergedRes = await fetch(`http://127.0.0.1:3094/api/events/merged?from=2026-08-01&to=2026-09-01`, {
      headers: { Cookie: cookie },
    });
    assertEq(mergedRes.status, 200, 'GET /api/events/merged returns 200');
    const mergedBody = await mergedRes.text();
    const merged = JSON.parse(mergedBody);
    assert(Array.isArray(merged.events), 'merged response has events[]');
    const smokeEvents = merged.events.filter((e) => e.title === 'Graph smoke event');
    assert(smokeEvents.length >= 1, 'smoke event appears in merged feed');
    if (smokeEvents.length >= 1) {
      assertEq(smokeEvents[0].origin, 'provider:ms365', 'smoke event has provider:ms365 origin tag');
      assert(!('cred_blob' in smokeEvents[0]), 'merged event does NOT contain cred_blob');
      assert(!mergedBody.includes(ACCESS_TOKEN), 'merged response does NOT contain plaintext access_token');
      assert(!mergedBody.includes(REFRESH_TOKEN), 'merged response does NOT contain plaintext refresh_token');
    }

    // List sources — secret must never come back.
    const listRes = await fetch('http://127.0.0.1:3094/api/calendar-sources', {
      headers: { Cookie: cookie },
    });
    assertEq(listRes.status, 200, 'GET /api/calendar-sources returns 200');
    const listBody = await listRes.text();
    assert(!listBody.includes(ACCESS_TOKEN), 'GET /api/calendar-sources does NOT contain plaintext access_token');
    assert(!listBody.includes(REFRESH_TOKEN), 'GET /api/calendar-sources does NOT contain plaintext refresh_token');
    assert(!listBody.includes('cred_blob'), 'GET /api/calendar-sources does NOT contain cred_blob key');

    console.log(`\n${pass} pass, ${fail} fail`);
  } finally {
    fakeGraph.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[smoke] FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});