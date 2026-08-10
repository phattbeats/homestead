#!/usr/bin/env node
// PHA-1865 calendar-sources smoke test (Google Calendar):
// boot server.js in-process with a fake Google Calendar API v3 server,
// mint an admin session via /api/login, add a google calendar source,
// kick a refresh, hit /api/events/merged, and verify the provider
// events flow through. Designed to fail loudly when the browser-side
// credentials leak contract is broken — same pattern as
// scripts/smoke-calendar-sources.js and scripts/smoke-graph-source.js
// but against the Google endpoint shape (`/calendars/{id}/events`).
//
// Run after `npm test`:
//   CALENDAR_CRED_KEY=$(openssl rand -hex 32) \
//     node scripts/smoke-google-source.js
//
// Exits 0 on success, 1 on any failure.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-google-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3095';
process.env.ADMIN_PASSWORD = 'smoketest-admin-pw';
process.env.BRANDON_PASSWORD = 'smoketest-brandon-pw';
process.env.SESSION_SECRET = 'smoke-test-secret-google';
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

// ---- 1. Boot a tiny fake Google Calendar API server on a free port ----
const fakeGooglePort = 4098;
let googleHits = [];
let refreshHits = 0;
const fakeGoogle = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    googleHits.push({ method: req.method, url: req.url, headers: req.headers, body });
    // Google OAuth2 token endpoint — used by the refresh-on-401 path.
    // We don't trigger refresh in this smoke (the access token we ship
    // never expires during the test window), but if a future run does,
    // mint a fresh token transparently.
    if (req.url === '/token' && req.method === 'POST') {
      refreshHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 3600,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/calendars/') && req.url.includes('/events')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        items: [
          {
            id: 'google-smoke-1',
            summary: 'Google smoke event',
            description: 'smoke',
            start: { dateTime: '2026-08-15T10:00:00-04:00', timeZone: 'America/New_York' },
            end:   { dateTime: '2026-08-15T11:00:00-04:00', timeZone: 'America/New_York' },
            location: { displayName: 'Office' },
            htmlLink: 'https://calendar.google.com/calendar/event?eid=google-smoke-1',
            etag: '"google-1"',
          },
        ],
        nextPageToken: null,
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
  await new Promise((r) => fakeGoogle.listen(fakeGooglePort, '127.0.0.1', r));
  console.log(`[smoke] fake Google on :${fakeGooglePort}`);

  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    const srv = app.listen(3095, '127.0.0.1', () => { console.log('[smoke] homestead listening on :3095'); resolve(srv); });
    srv.on('error', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3095/api/health');
      if (r.ok && (await r.json()).calendarCredKeyReady === true) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots and reports calendarCredKeyReady=true');

  try {
    // Login as admin.
    const loginRes = await fetch('http://127.0.0.1:3095/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'smoketest-admin-pw' }),
    });
    assertEq(loginRes.status, 200, 'admin login returns 200');
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    if (!cookie.includes('connect.sid')) throw new Error('no connect.sid cookie');
    ok('session cookie captured');

    // Add a calendar source pointing at the fake Google.
    // We deliberately use a far-future expires_at so the test doesn't
    // hit the refresh path (the refresh path is exercised by
    // test-google-source.js, which is a unit test).
    const ACCESS_TOKEN = 'super-secret-access-token-NEVER-LEAK';
    const REFRESH_TOKEN = 'super-secret-refresh-token-NEVER-LEAK';
    const CLIENT_SECRET = 'super-secret-client-secret-NEVER-LEAK';
    const createRes = await fetch('http://127.0.0.1:3095/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'google',
        account_id: 'smoketest@phatt.example',
        calendar_id: 'primary',
        base_url: `http://127.0.0.1:${fakeGooglePort}/calendar/v3`,
        display_name: 'Google Smoke',
        color: '#a4c2f4',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_at: '2099-01-01T00:00:00Z',
        client_id: 'smoke-app.apps.googleusercontent.com',
        client_secret: CLIENT_SECRET,
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      }),
    });
    assertEq(createRes.status, 200, 'POST /api/calendar-sources returns 200 (google)');
    const createBody = await createRes.text();
    const created = JSON.parse(createBody);
    assert(!('cred_blob' in created), 'created source response does NOT contain cred_blob');
    assert(!createBody.includes(ACCESS_TOKEN), 'created source response does NOT contain plaintext access_token');
    assert(!createBody.includes(REFRESH_TOKEN), 'created source response does NOT contain plaintext refresh_token');
    assert(!createBody.includes(CLIENT_SECRET), 'created source response does NOT contain plaintext client_secret');
    ok('cred_blob leak check on POST response (google)');
    const sourceId = created.id;

    // Kick a sync.
    const refreshRes = await fetch(`http://127.0.0.1:3095/api/calendar-sources/${sourceId}/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assertEq(refreshRes.status, 200, 'POST /api/calendar-sources/:id/refresh returns 200');

    // Wait for the sync to land (async fire-and-forget in server.js).
    for (let i = 0; i < 30; i++) {
      if (googleHits.some((h) => h.url.includes('/events'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const eventsHits = googleHits.filter((h) => h.url.includes('/events'));
    assert(eventsHits.length >= 1, `fake Google received ${eventsHits.length} events request(s)`);

    // Confirm the fake Google saw a Bearer auth header, NOT plaintext
    // credentials in the URL or body.
    const sawBearer = eventsHits.some((h) => (h.headers.authorization || '').startsWith('Bearer '));
    assert(sawBearer, 'fake Google saw a Bearer Authorization header');
    const allHitsJson = JSON.stringify(googleHits);
    assert(!allHitsJson.includes(REFRESH_TOKEN), 'refresh_token never appears in any Google request URL or body');
    assert(!allHitsJson.includes(CLIENT_SECRET), 'client_secret never appears in any Google request URL or body');
    assert(allHitsJson.includes(ACCESS_TOKEN),
      'access_token IS sent on the wire (inside the Authorization header) — sanity check');

    // Confirm the query parameters Google expects are present.
    const listCall = eventsHits[0];
    assert(listCall.url.includes('timeMin='), 'events request includes timeMin');
    assert(listCall.url.includes('timeMax='), 'events request includes timeMax');
    assert(listCall.url.includes('singleEvents=true'), 'events request sets singleEvents=true');
    assert(listCall.url.includes('orderBy=startTime'), 'events request sets orderBy=startTime');

    // Hit /api/events/merged over a window that includes the smoke event.
    const mergedRes = await fetch(`http://127.0.0.1:3095/api/events/merged?from=2026-08-01&to=2026-09-01`, {
      headers: { Cookie: cookie },
    });
    assertEq(mergedRes.status, 200, 'GET /api/events/merged returns 200');
    const mergedBody = await mergedRes.text();
    const merged = JSON.parse(mergedBody);
    assert(Array.isArray(merged.events), 'merged response has events[]');
    const smokeEvents = merged.events.filter((e) => e.title === 'Google smoke event');
    assert(smokeEvents.length >= 1, 'smoke event appears in merged feed');
    if (smokeEvents.length >= 1) {
      assertEq(smokeEvents[0].origin, 'provider:google', 'smoke event has provider:google origin tag');
      assert(!('cred_blob' in smokeEvents[0]), 'merged event does NOT contain cred_blob');
      assert(!mergedBody.includes(ACCESS_TOKEN), 'merged response does NOT contain plaintext access_token');
      assert(!mergedBody.includes(REFRESH_TOKEN), 'merged response does NOT contain plaintext refresh_token');
      assert(!mergedBody.includes(CLIENT_SECRET), 'merged response does NOT contain plaintext client_secret');
    }

    // List sources — secret must never come back.
    const listRes = await fetch('http://127.0.0.1:3095/api/calendar-sources', {
      headers: { Cookie: cookie },
    });
    assertEq(listRes.status, 200, 'GET /api/calendar-sources returns 200');
    const listBody = await listRes.text();
    assert(!listBody.includes(ACCESS_TOKEN), 'GET /api/calendar-sources does NOT contain plaintext access_token');
    assert(!listBody.includes(REFRESH_TOKEN), 'GET /api/calendar-sources does NOT contain plaintext refresh_token');
    assert(!listBody.includes(CLIENT_SECRET), 'GET /api/calendar-sources does NOT contain plaintext client_secret');
    assert(!listBody.includes('cred_blob'), 'GET /api/calendar-sources does NOT contain cred_blob key');

    // Reject path: google source without client_id is rejected with 400.
    const noClientIdRes = await fetch('http://127.0.0.1:3095/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'google',
        account_id: 'smoketest@phatt.example',
        calendar_id: 'primary',
        access_token: 'tok',
        // no client_id — should be rejected
      }),
    });
    assertEq(noClientIdRes.status, 400, 'POST /api/calendar-sources returns 400 when google client_id is missing');
    const noClientIdBody = await noClientIdRes.text();
    assert(noClientIdBody.includes('client_id'), '400 response mentions client_id requirement');

    // Reject path: google source without access_token is rejected with 400.
    const noAccessTokenRes = await fetch('http://127.0.0.1:3095/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'google',
        account_id: 'smoketest@phatt.example',
        calendar_id: 'primary',
        client_id: 'smoke-app.apps.googleusercontent.com',
        // no access_token — should be rejected
      }),
    });
    assertEq(noAccessTokenRes.status, 400, 'POST /api/calendar-sources returns 400 when google access_token is missing');

    console.log(`\n${pass} pass, ${fail} fail`);
  } finally {
    fakeGoogle.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[smoke] FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});