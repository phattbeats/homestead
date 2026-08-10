#!/usr/bin/env node
// PHA-1620 calendar-sources smoke test (v1): boot server.js in-process
// with a fake CalDAV server, mint an admin session via /api/login, add
// a calendar source, kick a refresh, hit /api/events/merged, and
// verify the provider events flow through. Designed to fail loudly
// when the browser-side credentials leak contract is broken.
//
// Run after `npm test`:
//   CALENDAR_CRED_KEY=$(openssl rand -hex 32) \
//     node scripts/smoke-calendar-sources.js
//
// Exits 0 on success, 1 on any failure. Same require + app.listen()
// pattern as scripts/smoke-push.js (avoids spawning a child process).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Use a fresh DATA_DIR + known port for isolation.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-cal-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3092';
process.env.ADMIN_PASSWORD = 'smoketest-admin-pw';
process.env.BRANDON_PASSWORD = 'smoketest-brandon-pw';
process.env.SESSION_SECRET = 'smoke-test-secret';
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

// ---- 1. Boot a tiny fake CalDAV server on a free port ---------------
// PHA-1866: the fake now also handles PUT/DELETE for write-back so the
// round-trip create → update → delete flow can be exercised end-to-end
// against the provider sandbox. The server keeps an in-memory list of
// created events so the next REPORT returns them alongside the seed.
const fakeCalDavPort = 4098;
let calDavHits = [];
const fakeEvents = new Map(); // href -> { ical, etag }
let etagCounter = 0;
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
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      const responses = [];
      // Seed event so the read-through still works on a fresh boot.
      const seedIcal = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:smoke-1@fake\r\nDTSTART:20260815T100000Z\r\nDTEND:20260815T110000Z\r\nSUMMARY:Smoke test event\r\nEND:VEVENT\r\nEND:VCALENDAR';
      responses.push(`<response><href>/cal/personal/abc.ics</href><propstat><prop><getetag>"e1"</getetag><calendar-data>${seedIcal}</calendar-data></prop></propstat></response>`);
      for (const [href, ev] of fakeEvents.entries()) {
        responses.push(`<response><href>${href}</href><propstat><prop><getetag>${ev.etag}</getetag><calendar-data>${ev.ical}</calendar-data></prop></propstat></response>`);
      }
      res.end(
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<multistatus xmlns="DAV:">' +
        responses.join('') +
        '</multistatus>'
      );
      return;
    }
    if (req.method === 'PUT') {
      const newEtag = `"e${++etagCounter}"`;
      // Extract UID from the VCALENDAR body if present.
      const uidMatch = body.match(/UID:([^\r\n]+)/);
      const href = req.url;
      fakeEvents.set(href, { ical: body, etag: newEtag });
      res.writeHead(201, { etag: newEtag });
      res.end(uidMatch ? `created ${uidMatch[1]}` : 'created');
      return;
    }
    if (req.method === 'DELETE') {
      fakeEvents.delete(req.url);
      res.writeHead(204);
      res.end();
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
  await new Promise((r) => fakeCalDav.listen(fakeCalDavPort, '127.0.0.1', r));
  console.log(`[smoke] fake CalDAV on :${fakeCalDavPort}`);

  // server.js's `if (require.main === module) { app.listen(...) }` is
  // false because we required it from a script — call listen ourselves.
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    const srv = app.listen(3092, '127.0.0.1', () => { console.log('[smoke] homestead listening on :3092'); resolve(srv); });
    srv.on('error', reject);
  });

  // Wait for /api/health to come back 200.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3092/api/health');
      if (r.ok && (await r.json()).calendarCredKeyReady === true) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots and reports calendarCredKeyReady=true');

  try {
    // Login as admin.
    const loginRes = await fetch('http://127.0.0.1:3092/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'smoketest-admin-pw' }),
    });
    assertEq(loginRes.status, 200, 'admin login returns 200');
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    if (!cookie.includes('connect.sid')) throw new Error('no connect.sid cookie');
    ok('session cookie captured');

    // Add a calendar source pointing at the fake CalDAV.
    const APP_PW = 'super-secret-pw-NEVER-LEAK';
    const createRes = await fetch('http://127.0.0.1:3092/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'caldav_nextcloud',
        account_id: 'smoketest',
        calendar_id: `http://127.0.0.1:${fakeCalDavPort}/cal/personal/`,
        base_url: `http://127.0.0.1:${fakeCalDavPort}/remote.php/dav`,
        display_name: 'Smoke Test',
        color: '#7c9eb8',
        app_password: APP_PW,
      }),
    });
    assertEq(createRes.status, 200, 'POST /api/calendar-sources returns 200');
    const createBody = await createRes.text();
    const created = JSON.parse(createBody);
    assert(!('cred_blob' in created), 'created source response does NOT contain cred_blob');
    assert(!createBody.includes(APP_PW), 'created source response does NOT contain plaintext app_password');
    ok('cred_blob leak check on POST response');
    const sourceId = created.id;

    // Kick a sync.
    const refreshRes = await fetch(`http://127.0.0.1:3092/api/calendar-sources/${sourceId}/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assertEq(refreshRes.status, 200, 'POST /api/calendar-sources/:id/refresh returns 200');

    // Wait for the sync to land (async fire-and-forget in server.js).
    for (let i = 0; i < 30; i++) {
      if (calDavHits.length >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(calDavHits.length >= 1, `fake CalDAV received ${calDavHits.length} request(s)`);

    // Hit /api/events/merged over a window that includes the smoke event.
    const mergedRes = await fetch(`http://127.0.0.1:3092/api/events/merged?from=2026-08-01&to=2026-09-01`, {
      headers: { Cookie: cookie },
    });
    assertEq(mergedRes.status, 200, 'GET /api/events/merged returns 200');
    const mergedBody = await mergedRes.text();
    const merged = JSON.parse(mergedBody);
    assert(Array.isArray(merged.events), 'merged response has events[]');
    const smokeEvents = merged.events.filter((e) => e.title === 'Smoke test event');
    assert(smokeEvents.length >= 1, 'smoke event appears in merged feed');
    if (smokeEvents.length >= 1) {
      assertEq(smokeEvents[0].origin, 'provider:caldav_nextcloud', 'smoke event has provider origin tag');
      assert(!('cred_blob' in smokeEvents[0]), 'merged event does NOT contain cred_blob');
      assert(!mergedBody.includes(APP_PW), 'merged response does NOT contain plaintext app_password');
    }

    // List sources — secret must never come back.
    const listRes = await fetch('http://127.0.0.1:3092/api/calendar-sources', {
      headers: { Cookie: cookie },
    });
    assertEq(listRes.status, 200, 'GET /api/calendar-sources returns 200');
    const listBody = await listRes.text();
    assert(!listBody.includes(APP_PW), 'GET /api/calendar-sources does NOT contain plaintext app_password');
    assert(!listBody.includes('cred_blob'), 'GET /api/calendar-sources does NOT contain cred_blob key');

    // Confirm the fake CalDAV saw Basic auth, not plaintext.
    const sawBasic = calDavHits.some((h) => (h.headers.authorization || '').startsWith('Basic '));
    assert(sawBasic, 'fake CalDAV saw a Basic auth header');
    const calDavBody = JSON.stringify(calDavHits);
    assert(!calDavBody.includes(APP_PW), 'plaintext app_password never appears in any CalDAV request body or URL');

    // ---- PHA-1866: Phase 2 write-back round-trip ----
    // Create an event on the provider, verify it surfaces in the merged
    // feed, update it, verify the update, then delete it and verify
    // the deletion. The fake CalDAV server keeps the new event in
    // memory so the next REPORT returns it.
    const hitsBeforeWrite = calDavHits.length;
    const createEventRes = await fetch(`http://127.0.0.1:3092/api/calendar-sources/${sourceId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        title: 'Write-back event',
        description: 'created by smoke test',
        start: '2026-08-16T14:00:00.000Z',
        end: '2026-08-16T15:00:00.000Z',
      }),
    });
    assertEq(createEventRes.status, 200, 'POST /api/calendar-sources/:id/events returns 200');
    const createdEventRaw = await createEventRes.text();
    const createdEvent = JSON.parse(createdEventRaw);
    assert(!!createdEvent.externalId, 'createEvent response includes externalId');
    assert(createdEvent.href && createdEvent.href.endsWith('.ics'), 'createEvent response includes href ending in .ics');
    assert(!createdEventRaw.includes(APP_PW), 'createEvent response does NOT contain plaintext app_password');
    const newUid = createdEvent.externalId;

    // Fake CalDAV received the PUT with the right headers and body.
    const putHit = calDavHits.slice(hitsBeforeWrite).find(h => h.method === 'PUT');
    assert(!!putHit, 'fake CalDAV received a PUT request');
    assert(putHit && putHit.headers['if-none-match'] === '*', 'PUT carried If-None-Match: *');
    assert(putHit && /text\/calendar/.test(putHit.headers['content-type'] || ''), 'PUT Content-Type is text/calendar');
    assert(putHit && putHit.body.includes('SUMMARY:Write-back event'), 'PUT body contains the new event summary');
    assert(putHit && putHit.body.includes('UID:' + newUid), 'PUT body contains the generated UID');

    // Wait for the post-write sync to land so /api/events/merged picks up the
    // new event on the next read.
    let syncedAfterCreate = false;
    for (let i = 0; i < 30; i++) {
      const hits = calDavHits.slice(hitsBeforeWrite);
      // We expect: PUT (create) + PUT (sync after create triggers another sync) ... actually
      // the sync after create is a REPORT, not a PUT. Count REPORTs after the create.
      const reports = hits.filter(h => h.method === 'REPORT');
      if (reports.length >= 1) { syncedAfterCreate = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(syncedAfterCreate, 'post-create sync REPORT landed');

    // Verify the created event appears in the merged feed.
    const mergedRes2 = await fetch(`http://127.0.0.1:3092/api/events/merged?from=2026-08-01&to=2026-09-01`, {
      headers: { Cookie: cookie },
    });
    assertEq(mergedRes2.status, 200, 'GET /api/events/merged returns 200 after create');
    const merged2 = await mergedRes2.json();
    const writeBackEvents = merged2.events.filter((e) => e.title === 'Write-back event');
    assert(writeBackEvents.length >= 1, 'Write-back event appears in merged feed after create');
    const writeBackId = writeBackEvents.length >= 1 ? writeBackEvents[0].id : null;

    // Update the event.
    const hitsBeforeUpdate = calDavHits.length;
    const updateEventRes = await fetch(`http://127.0.0.1:3092/api/calendar-sources/${sourceId}/events/${encodeURIComponent(newUid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        title: 'Write-back event (updated)',
        start: '2026-08-16T14:00:00.000Z',
        end: '2026-08-16T16:00:00.000Z',
        etag: createdEvent.etag,
      }),
    });
    assertEq(updateEventRes.status, 200, 'PUT /api/calendar-sources/:id/events/:uid returns 200');
    const updatedEvent = await updateEventRes.json();
    assert(!!updatedEvent.externalId, 'updateEvent response includes externalId');
    const updatePut = calDavHits.slice(hitsBeforeUpdate).find(h => h.method === 'PUT');
    assert(!!updatePut, 'fake CalDAV received a PUT for the update');
    assert(updatePut && updatePut.body.includes('SUMMARY:Write-back event (updated)'), 'PUT body contains the updated summary');
    assert(updatePut && updatePut.body.includes('UID:' + newUid), 'PUT body preserves the UID');
    // If-Match was sent (we provided an etag).
    assert(updatePut && updatePut.headers['if-match'] === createdEvent.etag, 'PUT carried If-Match with the previous etag');

    // Verify the update appears in the merged feed.
    let updateLanded = false;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`http://127.0.0.1:3092/api/events/merged?from=2026-08-01&to=2026-09-01`, { headers: { Cookie: cookie } });
      const m = await r.json();
      if (m.events.some((e) => e.title === 'Write-back event (updated)')) { updateLanded = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(updateLanded, 'updated event appears in merged feed after update');

    // Delete the event.
    const hitsBeforeDelete = calDavHits.length;
    const deleteEventRes = await fetch(`http://127.0.0.1:3092/api/calendar-sources/${sourceId}/events/${encodeURIComponent(newUid)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assertEq(deleteEventRes.status, 200, 'DELETE /api/calendar-sources/:id/events/:uid returns 200');
    const deleteHit = calDavHits.slice(hitsBeforeDelete).find(h => h.method === 'DELETE');
    assert(!!deleteHit, 'fake CalDAV received a DELETE');

    // Verify the event is gone from the merged feed (after post-delete sync).
    let deleteLanded = false;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`http://127.0.0.1:3092/api/events/merged?from=2026-08-01&to=2026-09-01`, { headers: { Cookie: cookie } });
      const m = await r.json();
      const stillThere = m.events.some((e) => e.title === 'Write-back event' || e.title === 'Write-back event (updated)');
      if (!stillThere) { deleteLanded = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(deleteLanded, 'event is gone from merged feed after delete');

    // No app_password in any captured request payload across the whole flow.
    const fullCaptured = JSON.stringify(calDavHits);
    assert(!fullCaptured.includes(APP_PW), 'plaintext app_password never appears anywhere in captured CalDAV traffic');

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