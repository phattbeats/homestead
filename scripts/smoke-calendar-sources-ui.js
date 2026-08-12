#!/usr/bin/env node
// PHA-1868 smoke test: per-user source config UI surface area.
//
// Exercises the new endpoints the SPA uses:
//   * GET    /api/calendar-sources/kinds — provider metadata for the
//     add/edit form (labels, credential field schemas, placeholder text,
//     disabled flags for providers that are reserved but not shipped).
//   * PATCH  /api/calendar-sources/:id   — edit display_name / color /
//     enabled without re-prompting credentials.
//   * GET    /api/calendar-sources        — list (publicView — never
//     leaks cred_blob).
//   * POST   /api/calendar-sources/:id/refresh — kick a sync against the
//     provider sandbox.
//   * DELETE /api/calendar-sources/:id    — remove a row.
//
// The test boots server.js in-process against a fake CalDAV sandbox
// (same pattern as scripts/smoke-calendar-sources.js). It also adds a
// placeholder ms365 source and confirms the provider allow-list returns
// both kinds AND marks google as disabled until PHA-1865 merges.
//
// Exits 0 on success, 1 on any failure. Designed to fail loudly when
// the browser-side credentials leak contract is broken (the new PATCH
// and /kinds surfaces are load-bearing too — neither one may echo
// cred_blob or any plaintext credential).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-cs-ui-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3097';
process.env.ADMIN_PASSWORD = 'smoketest-admin-pw';
process.env.BRANDON_PASSWORD = 'smoketest-brandon-pw';
process.env.SESSION_SECRET = 'smoke-test-secret-cs-ui';
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

// ---- 1. Boot a tiny fake CalDAV server on a free port -----------------
const fakeCalDavPort = 4099;
const fakeEvents = new Map();
let etagCounter = 0;
const calDavHits = [];
const fakeCalDav = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    calDavHits.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<multistatus xmlns="DAV:">' +
        '<response><href>/cal/personal/</href>' +
        '<propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Personal</displayname></prop></propstat></response>' +
        '</multistatus>'
      );
      return;
    }
    if (req.method === 'REPORT') {
      const responses = [];
      const seedIcal = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:cs-ui-1@fake\r\nDTSTART:20260817T090000Z\r\nDTEND:20260817T100000Z\r\nSUMMARY:CS UI smoke event\r\nEND:VEVENT\r\nEND:VCALENDAR';
      responses.push(`<response><href>/cal/personal/cs-ui-1.ics</href><propstat><prop><getetag>"e1"</getetag><calendar-data>${seedIcal}</calendar-data></prop></propstat></response>`);
      for (const [href, ev] of fakeEvents.entries()) {
        responses.push(`<response><href>${href}</href><propstat><prop><getetag>${ev.etag}</getetag><calendar-data>${ev.ical}</calendar-data></prop></propstat></response>`);
      }
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<multistatus xmlns="DAV:">' +
        responses.join('') +
        '</multistatus>'
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not implemented in fake');
  });
});
fakeCalDav.listen(fakeCalDavPort, '127.0.0.1', () => {
  console.log(`[smoke] fake CalDAV on :${fakeCalDavPort}`);
});

(async () => {
  await new Promise((resolve) => fakeCalDav.on('listening', resolve));

  // ---- 2. Boot homestead in-process --------------------------------
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    const srv = app.listen(3097, '127.0.0.1', () => { console.log('[smoke] homestead listening on :3097'); resolve(srv); });
    srv.on('error', reject);
  });

  // Wait for /api/health.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3097/api/health');
      if (r.ok && (await r.json()).calendarCredKeyReady === true) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots and reports calendarCredKeyReady=true');

  try {
    // Login as admin.
    const loginRes = await fetch('http://127.0.0.1:3097/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'smoketest-admin-pw' }),
    });
    assertEq(loginRes.status, 200, 'admin login returns 200');
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    if (!cookie.includes('connect.sid')) throw new Error('no connect.sid cookie');
    ok('session cookie captured');

    // ---- /api/calendar-sources/kinds ----------------------------------
    const kindsRes = await fetch('http://127.0.0.1:3097/api/calendar-sources/kinds', {
      headers: { Cookie: cookie },
    });
    assertEq(kindsRes.status, 200, 'GET /api/calendar-sources/kinds returns 200');
    const kindsBody = await kindsRes.text();
    // /kinds describes credential FIELD ids (so "access_token" /
    // "refresh_token" appear as field-name strings — that's correct).
    // The leak check is for credential VALUES, which are set further
    // down. Use unique fake values that don't collide with field ids.
    assert(!kindsBody.includes('cred_blob'), '/kinds response does NOT contain cred_blob');
    const kindsJson = JSON.parse(kindsBody);
    const kindIds = (kindsJson.kinds || []).map((k) => k.id);
    assertEq(kindIds.includes('caldav_nextcloud'), true, '/kinds lists caldav_nextcloud');
    assertEq(kindIds.includes('caldav_icloud'), true, '/kinds lists caldav_icloud');
    assertEq(kindIds.includes('ms365'), true, '/kinds lists ms365');
    assertEq(kindIds.includes('google'), true, '/kinds lists google (reserved)');
    const googleKind = (kindsJson.kinds || []).find((k) => k.id === 'google');
    assertEq(googleKind && googleKind.disabled, true, 'google kind is marked disabled until PHA-1865');
    const caldavKind = (kindsJson.kinds || []).find((k) => k.id === 'caldav_nextcloud');
    assert(Array.isArray(caldavKind && caldavKind.credentialFields) && caldavKind.credentialFields.length === 1 && caldavKind.credentialFields[0].id === 'app_password', 'caldav_nextcloud kind has app_password credential field');
    const ms365Kind = (kindsJson.kinds || []).find((k) => k.id === 'ms365');
    const ms365FieldIds = (ms365Kind.credentialFields || []).map((f) => f.id);
    assertEq(ms365FieldIds.includes('access_token'), true, 'ms365 kind has access_token credential field');
    assertEq(ms365FieldIds.includes('refresh_token'), true, 'ms365 kind has refresh_token credential field');
    assertEq(ms365FieldIds.includes('client_id'), true, 'ms365 kind has client_id credential field');

    // ---- POST /api/calendar-sources (caldav) -------------------------
    const APP_PW = 'super-secret-cs-ui-pw-NEVER-LEAK';
    const createCalRes = await fetch('http://127.0.0.1:3097/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'caldav_nextcloud',
        account_id: 'csui',
        calendar_id: `http://127.0.0.1:${fakeCalDavPort}/cal/personal/`,
        base_url: `http://127.0.0.1:${fakeCalDavPort}/remote.php/dav`,
        display_name: 'CS UI Smoke',
        color: '#7c9eb8',
        app_password: APP_PW,
      }),
    });
    assertEq(createCalRes.status, 200, 'POST /api/calendar-sources (caldav) returns 200');
    const createCalBody = await createCalRes.text();
    const createdCal = JSON.parse(createCalBody);
    assert(!('cred_blob' in createdCal), 'created caldav source response does NOT contain cred_blob');
    assert(!createCalBody.includes(APP_PW), 'created caldav source response does NOT contain plaintext app_password');
    const caldavSourceId = createdCal.id;

    // ---- POST /api/calendar-sources (ms365) --------------------------
    const ACCESS_TOKEN = 'fake-access-token-NEVER-LEAK';
    const REFRESH_TOKEN = 'fake-refresh-token-NEVER-LEAK';
    const createMsRes = await fetch('http://127.0.0.1:3097/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'ms365',
        account_id: 'brandon@phatt.vip',
        calendar_id: 'AAMkAGRiYW5kb24tY2Fs',
        display_name: 'Work (ms365)',
        color: '#8a9ec4',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        client_id: 'azure-app-client-id',
        tenant_id: 'common',
        scope: 'Calendars.Read offline_access',
      }),
    });
    assertEq(createMsRes.status, 200, 'POST /api/calendar-sources (ms365) returns 200');
    const createMsBody = await createMsRes.text();
    assert(!createMsBody.includes(ACCESS_TOKEN), 'created ms365 source response does NOT contain access_token');
    assert(!createMsBody.includes(REFRESH_TOKEN), 'created ms365 source response does NOT contain refresh_token');
    const createdMs = JSON.parse(createMsBody);
    assertEq(createdMs.provider, 'ms365', 'ms365 source has provider=ms365');
    const ms365SourceId = createdMs.id;

    // ---- GET /api/calendar-sources (list) -----------------------------
    const listRes = await fetch('http://127.0.0.1:3097/api/calendar-sources', {
      headers: { Cookie: cookie },
    });
    assertEq(listRes.status, 200, 'GET /api/calendar-sources returns 200');
    const listBody = await listRes.text();
    assert(!listBody.includes(APP_PW), 'list response does NOT contain app_password');
    assert(!listBody.includes(ACCESS_TOKEN), 'list response does NOT contain access_token');
    assert(!listBody.includes(REFRESH_TOKEN), 'list response does NOT contain refresh_token');
    assert(!listBody.includes('cred_blob'), 'list response does NOT contain cred_blob key');
    const list = JSON.parse(listBody);
    assertEq(list.length, 2, 'list response has 2 sources');
    const listCal = list.find((s) => s.id === caldavSourceId);
    assert(!!listCal, 'list contains the caldav source');
    assert(!('cred_blob' in listCal), 'list row does NOT contain cred_blob');
    assert(!('app_password' in listCal), 'list row does NOT contain app_password');
    assertEq(listCal.display_name, 'CS UI Smoke', 'list row has display_name');
    assertEq(listCal.color, '#7c9eb8', 'list row has color');
    assertEq(listCal.enabled, true, 'list row has enabled=true');
    const listMs = list.find((s) => s.id === ms365SourceId);
    assert(!!listMs, 'list contains the ms365 source');
    assertEq(listMs.provider, 'ms365', 'ms365 list row has provider=ms365');

    // ---- PATCH /api/calendar-sources/:id ------------------------------
    const patchRes = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        display_name: 'CS UI Smoke (renamed)',
        color: '#a3b8c9',
        enabled: false,
      }),
    });
    assertEq(patchRes.status, 200, 'PATCH /api/calendar-sources/:id returns 200');
    const patchBody = await patchRes.text();
    assert(!patchBody.includes(APP_PW), 'PATCH response does NOT contain app_password');
    assert(!patchBody.includes('cred_blob'), 'PATCH response does NOT contain cred_blob');
    const patched = JSON.parse(patchBody);
    assertEq(patched.display_name, 'CS UI Smoke (renamed)', 'PATCH persisted display_name');
    assertEq(patched.color, '#a3b8c9', 'PATCH persisted color');
    assertEq(patched.enabled, false, 'PATCH persisted enabled=false');

    // PATCH back to enabled.
    const patch2Res = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true, color: '#7c9eb8', display_name: 'CS UI Smoke' }),
    });
    assertEq(patch2Res.status, 200, 'PATCH re-enable returns 200');
    const patched2 = JSON.parse(await patch2Res.text());
    assertEq(patched2.enabled, true, 'PATCH re-enabled source');

    // PATCH with bogus color is normalised to the default.
    const patchBadRes = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ color: 'red' }),
    });
    assertEq(patchBadRes.status, 200, 'PATCH bogus color returns 200');
    const patched3 = JSON.parse(await patchBadRes.text());
    assertEq(patched3.color, '#7c9eb8', 'PATCH bogus color normalised to default');

    // PATCH nonexistent source returns 404.
    const patch404Res = await fetch(`http://127.0.0.1:3097/api/calendar-sources/999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ display_name: 'x' }),
    });
    assertEq(patch404Res.status, 404, 'PATCH on missing source returns 404');

    // PATCH with empty body is a no-op (returns the current row).
    const patchEmptyRes = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    assertEq(patchEmptyRes.status, 200, 'PATCH empty body returns 200 (no-op)');
    const patchEmpty = JSON.parse(await patchEmptyRes.text());
    assert(!('cred_blob' in patchEmpty), 'PATCH no-op response does NOT contain cred_blob');

    // ---- POST /api/calendar-sources/:id/refresh -----------------------
    const refreshRes = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assertEq(refreshRes.status, 200, 'POST /api/calendar-sources/:id/refresh returns 200');

    // Wait for the sync to land.
    for (let i = 0; i < 30; i++) {
      if (calDavHits.length >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(calDavHits.length >= 1, `fake CalDAV received ${calDavHits.length} request(s)`);

    // /api/events/merged includes the caldav provider event.
    const mergedRes = await fetch('http://127.0.0.1:3097/api/events/merged?from=2026-08-01&to=2026-09-01', {
      headers: { Cookie: cookie },
    });
    assertEq(mergedRes.status, 200, 'GET /api/events/merged returns 200');
    const mergedBody = await mergedRes.text();
    assert(!mergedBody.includes(APP_PW), 'merged response does NOT contain app_password');
    assert(!mergedBody.includes(ACCESS_TOKEN), 'merged response does NOT contain access_token');
    assert(!mergedBody.includes(REFRESH_TOKEN), 'merged response does NOT contain refresh_token');
    const merged = JSON.parse(mergedBody);
    const providerEvents = (merged.events || []).filter((e) => e.origin === 'provider:caldav_nextcloud');
    assert(providerEvents.length >= 1, 'merged feed includes caldav_nextcloud events');

    // Disabled source is excluded from the merged feed (PHA-1867 + lib/calendar-sources).
    const disabledPatchRes = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    assertEq(disabledPatchRes.status, 200, 'PATCH enabled=false returns 200');
    const merged2 = await (await fetch('http://127.0.0.1:3097/api/events/merged?from=2026-08-01&to=2026-09-01', { headers: { Cookie: cookie } })).json();
    const stillThere = (merged2.events || []).filter((e) => e.origin === 'provider:caldav_nextcloud');
    assertEq(stillThere.length, 0, 'merged feed excludes events from disabled sources');
    // Re-enable for the rest of the smoke test.
    await fetch(`http://127.0.0.1:3097/api/calendar-sources/${caldavSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });

    // ---- DELETE /api/calendar-sources/:id -----------------------------
    const delMsRes = await fetch(`http://127.0.0.1:3097/api/calendar-sources/${ms365SourceId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assertEq(delMsRes.status, 200, 'DELETE /api/calendar-sources/:id returns 200');
    const listAfterDel = await (await fetch('http://127.0.0.1:3097/api/calendar-sources', { headers: { Cookie: cookie } })).json();
    assertEq(listAfterDel.length, 1, 'list after delete has 1 source');
    assertEq(listAfterDel[0].id, caldavSourceId, 'remaining source is the caldav one');

    // DELETE nonexistent source returns 404.
    const del404Res = await fetch('http://127.0.0.1:3097/api/calendar-sources/999999', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assertEq(del404Res.status, 404, 'DELETE on missing source returns 404');

    // Final leak check across every API response we touched.
    const finalLeakCheck = [kindsBody, createCalBody, createMsBody, listBody, patchBody].join('\n');
    assert(!finalLeakCheck.includes(APP_PW), 'no plaintext app_password anywhere');
    assert(!finalLeakCheck.includes(ACCESS_TOKEN), 'no plaintext access_token anywhere');
    assert(!finalLeakCheck.includes(REFRESH_TOKEN), 'no plaintext refresh_token anywhere');

    console.log(`\n${pass} pass, ${fail} fail`);
  } finally {
    fakeCalDav.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[smoke] FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});