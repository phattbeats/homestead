#!/usr/bin/env node
// PHA-1867 merge-layer smoke test: end-to-end against a live server.js.
//
//   1. Boot server.js in-process with CALENDAR_CRED_KEY + a fake CalDAV.
//   2. Add a calendar source + sync it.
//   3. Hit /api/events/merged over the smoke month.
//   4. Verify:
//        * smoke event appears with origin='provider:caldav_nextcloud'
//        * a seeded multi-day event overlaps the window and shows up
//        * a disabled source's event is absent
//        * the response payload never contains cred_blob / app_password /
//          access_token / refresh_token / client_secret
//        * the response is valid JSON (no HTML fallback)
//
// Run after `npm test`:
//   CALENDAR_CRED_KEY=$(openssl rand -hex 32) \
//     node scripts/smoke-merge-layer.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-merge-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3093';
process.env.ADMIN_PASSWORD = 'smoke-merge-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-merge-brandon-pw';
process.env.SESSION_SECRET = 'smoke-merge-secret';
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke-merge] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

let pass = 0, fail = 0;
function ok(label){pass++;console.log(`  ✓ ${label}`);}
function ng(label,detail){fail++;console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);}
function assert(cond,label,detail){if(cond)ok(label);else ng(label,detail);}
function assertEq(actual,expected,label){
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---- fake CalDAV serving a smoke event + a multi-day event -----------
const fakeCalDavPort = 4099;
let calDavHits = [];
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
      // Serve a smoke event for 2026-08-15 + a multi-day event that
      // crosses the calendar boundary (covers the overlap case).
      const smokeIcal =
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' +
        'BEGIN:VEVENT\r\nUID:merge-smoke@fake\r\nDTSTART:20260815T100000Z\r\nDTEND:20260815T110000Z\r\nSUMMARY:Merge smoke event\r\nEND:VEVENT\r\n' +
        // Multi-day event spanning Aug 18 → Aug 22 (5 days, all-day).
        'BEGIN:VEVENT\r\nUID:merge-multiday@fake\r\nDTSTART;VALUE=DATE:20260818\r\nDTEND;VALUE=DATE:20260823\r\nSUMMARY:Multi-day conference\r\nEND:VEVENT\r\n' +
        'END:VCALENDAR';
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<multistatus xmlns="DAV:">' +
        `<response><href>/cal/personal/a.ics</href><propstat><prop><getetag>"e1"</getetag><calendar-data>${smokeIcal}</calendar-data></prop></propstat></response>` +
        '</multistatus>'
      );
      return;
    }
    res.writeHead(404); res.end();
  });
});

(async () => {
  await new Promise((r) => fakeCalDav.listen(fakeCalDavPort, '127.0.0.1', r));
  console.log(`[smoke-merge] fake CalDAV on :${fakeCalDavPort}`);

  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3093, '127.0.0.1', () => { console.log('[smoke-merge] homestead on :3093'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for ready.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3093/api/health');
      if (r.ok && (await r.json()).calendarCredKeyReady === true) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots and reports calendarCredKeyReady=true');

  try {
    const loginRes = await fetch('http://127.0.0.1:3093/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'smoke-merge-admin-pw' }),
    });
    assertEq(loginRes.status, 200, 'admin login returns 200');
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const APP_PW = 'merge-super-secret-NEVER-LEAK';
    // Source 1: enabled Nextcloud pointing at the fake CalDAV.
    const create1 = await fetch('http://127.0.0.1:3093/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'caldav_nextcloud',
        account_id: 'smoketest',
        calendar_id: `http://127.0.0.1:${fakeCalDavPort}/cal/personal/`,
        base_url: `http://127.0.0.1:${fakeCalDavPort}/remote.php/dav`,
        display_name: 'Smoke Merge',
        color: '#7c9eb8',
        app_password: APP_PW,
      }),
    });
    assertEq(create1.status, 200, 'POST /api/calendar-sources (enabled) returns 200');
    const src1 = await create1.json();
    assert(!('cred_blob' in src1), 'create response does NOT contain cred_blob');
    assert(!JSON.stringify(src1).includes(APP_PW), 'create response does NOT contain plaintext app_password');

    // Source 2: DISABLED source — events from this one must be invisible.
    const create2 = await fetch('http://127.0.0.1:3093/api/calendar-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'caldav_nextcloud',
        account_id: 'disabled-acct',
        calendar_id: 'https://nc.example/disabled/',
        base_url: 'https://nc.example/remote.php/dav',
        display_name: 'Disabled',
        color: '#aa3322',
        app_password: 'NEVER-LEAK-DISABLED',
      }),
    });
    assertEq(create2.status, 200, 'POST /api/calendar-sources (disabled) returns 200');
    const src2 = await create2.json();
    // Disable source 2.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tmpDir, 'life.db'));
    db.prepare(`UPDATE calendar_sources SET enabled = 0 WHERE id = ?`).run(src2.id);
    db.close();

    // Refresh source 1.
    const refreshRes = await fetch(`http://127.0.0.1:3093/api/calendar-sources/${src1.id}/refresh`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assertEq(refreshRes.status, 200, 'POST /api/calendar-sources/:id/refresh returns 200');

    for (let i = 0; i < 30; i++) {
      if (calDavHits.length >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(calDavHits.length >= 1, `fake CalDAV received ${calDavHits.length} request(s)`);

    // Fetch /api/events/merged over Aug 2026.
    const mergedRes = await fetch('http://127.0.0.1:3093/api/events/merged?from=2026-08-01&to=2026-08-31', {
      headers: { Cookie: cookie },
    });
    assertEq(mergedRes.status, 200, 'GET /api/events/merged returns 200');
    const mergedBody = await mergedRes.text();
    const merged = JSON.parse(mergedBody);

    const smoke = (merged.events || []).find((e) => e.title === 'Merge smoke event');
    const multiday = (merged.events || []).find((e) => e.title === 'Multi-day conference');
    assert(!!smoke, 'Merge smoke event present in merged feed');
    assert(!!multiday, 'Multi-day conference present in merged feed');

    if (smoke) {
      assertEq(smoke.origin, 'provider:caldav_nextcloud', 'smoke event tagged provider:caldav_nextcloud');
      assert(!('cred_blob' in smoke), 'smoke event does NOT contain cred_blob');
      assert(!mergedBody.includes(APP_PW), 'merged response does NOT contain plaintext app_password');
      assert(!mergedBody.includes('NEVER-LEAK-DISABLED'), 'merged response does NOT contain disabled-source password');
      assertEq(smoke.stale, false, 'just-synced source has stale=false');
      assertEq(smoke.color, '#7c9eb8', 'smoke event carries source color');
      assert(typeof smoke.source_id === 'number', 'smoke event has source_id');
    }

    if (multiday) {
      assert(typeof multiday.start === 'string' && multiday.start < multiday.end, 'multi-day event has start < end');
      // allDay detection for VALUE=DATE multi-day events is broken in the
      // caldav iCal parser (PHA-1620): it parses the date into a full ISO
      // timestamp, losing the date-only signal. The merge layer faithfully
      // passes through whatever allDay the source adapter reports; the fix
      // belongs in lib/caldav-source.js's parseICalDate (separate PR).
      // What the merge layer guarantees is that multi-day events SURFACE in
      // the window they overlap — that is what we just verified above.
      console.log(`  · note: multi-day allDay=${multiday.allDay} (upstream parser bug, not a merge-layer bug)`);
    }

    // Disabled source must not leak any of its events.
    const disabledHits = (merged.events || []).filter((e) => e.source_id === src2.id);
    assertEq(disabledHits.length, 0, 'disabled source events excluded from merged feed');

    // full credential leak contract.
    assert(!mergedBody.includes('cred_blob'), 'merged response does NOT contain cred_blob');
    assert(!mergedBody.includes('access_token'), 'merged response does NOT contain access_token');
    assert(!mergedBody.includes('refresh_token'), 'merged response does NOT contain refresh_token');
    assert(!mergedBody.includes('client_secret'), 'merged response does NOT contain client_secret');

    // Confirm response is JSON (not HTML) — defensive against accidental
    // SPA fallthrough when routes are missing.
    assert(mergedBody.startsWith('{'), 'response is JSON (not HTML)');

    console.log(`\n${pass} pass, ${fail} fail`);
  } finally {
    fakeCalDav.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[smoke-merge] FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
