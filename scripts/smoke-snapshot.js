#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1902 (PHA-1617.9) smoke test: end-to-end against a live server.js.
//
//   1. Boot server.js in-process against a fresh DATA_DIR.
//   2. Seed a few tasks/events/notification_log entries for brandon.
//   3. GET /api/me/snapshot authenticated as brandon.
//   4. Verify:
//      * §7 envelope shape is intact
//      * A task due today is in today_tasks
//      * A task assigned to emily is NOT in brandon's snapshot
//      * A done task is NOT in today_tasks
//      * A task due tomorrow is in upcoming.chores_due_next_7_days
//      * An event today is in today_events
//      * An event in 3 days is in upcoming.events_next_7_days
//      * `X-Homestead-Tz` header flips the published tz
//      * Anonymous call returns 401
//      * The payload never contains credential field names
//      * The response is valid JSON (not HTML SPA fallback)
//
// Run after `npm test`:
//   CALENDAR_CRED_KEY=*** rand -hex 32) \
//     node scripts/smoke-snapshot.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-snapshot-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3097';
process.env.ADMIN_PASSWORD = 'smoke-snap-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-snap-brandon-pw';
process.env.SESSION_SECRET = 'smoke-snap-secret-' + crypto.randomBytes(4).toString('hex');
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke-snapshot] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const Database = require('better-sqlite3');
const calendarSources = require('../lib/calendar-sources');

// Stub the caldav adapter so the smoke can't touch the network.
calendarSources.registerAdapter('caldav', () => ({
  kind: 'caldav',
  listCalendars: async () => [],
  listEvents: async () => [],
  createEvent: async () => { throw new Error('not impl'); },
  updateEvent: async () => { throw new Error('not impl'); },
  deleteEvent: async () => { throw new Error('not impl'); },
}));

// Boot server.js and capture the Express app.
const app = require('../server.js');
const server = http.createServer(app);

function localIsoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function postJson(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      method: 'POST',
      host: '127.0.0.1',
      port: parseInt(process.env.PORT, 10),
      path,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function getJson(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET',
      host: '127.0.0.1',
      port: parseInt(process.env.PORT, 10),
      path,
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // Open the DB and seed test rows. The server.js migration has already
  // run against tmpDir/life.db via the require() above.
  const db = new Database(path.join(tmpDir, 'life.db'));
  const brandon = db.prepare('SELECT id, username FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id, username FROM users WHERE username = ?').get('emily');
  if (!brandon || !emily) {
    ng('seed users exist', `brandon=${!!brandon} emily=${!!emily}`);
    process.exit(1);
  }

  // Tasks
  const today = localIsoDate(0);
  const tomorrow = localIsoDate(1);
  const inThreeDays = localIsoDate(3);
  const inFourteenDays = localIsoDate(14);
  const yesterday = localIsoDate(-1);

  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Take out trash', 'brandon', today);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Wash dishes', 'brandon', today);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Pay electric bill', 'brandon', tomorrow);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Replace light bulb', 'brandon', inThreeDays);
  // Out of window (should NOT appear)
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Plan vacation', 'brandon', inFourteenDays);
  // Overdue (should appear in overdue_tasks)
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Submit expense report', 'brandon', yesterday);
  // Done (should NOT appear)
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, done_by, created_by)
              VALUES (?, ?, ?, 1, 'brandon', 'brandon')`).run('Already done task', 'brandon', today);
  // Emily-only (should NOT appear for brandon)
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'emily')`).run('Emily lineup', 'emily', today);

  // Events
  db.prepare(`INSERT INTO events (title, date, time, notes, owner, created_by)
              VALUES (?, ?, ?, ?, ?, 'brandon')`).run('Standup', today, '09:00', 'Daily', 'brandon');
  db.prepare(`INSERT INTO events (title, date, time, notes, owner, created_by)
              VALUES (?, ?, ?, ?, ?, 'brandon')`).run('Movie night', today, '20:00', '', 'all');
  db.prepare(`INSERT INTO events (title, date, time, notes, owner, created_by)
              VALUES (?, ?, ?, ?, ?, 'brandon')`).run('Dentist', inThreeDays, '14:00', '', 'brandon');
  db.prepare(`INSERT INTO events (title, date, time, notes, owner, created_by)
              VALUES (?, ?, ?, ?, ?, 'brandon')`).run('Vacation start', inFourteenDays, '', '', 'brandon');

  // Notification log (activity_recent source)
  db.prepare(`INSERT INTO notification_log (user_id, category, title, body, url, tag, delivered)
              VALUES (?, 'task.created', 'New task assigned', 'Take out trash', '/tasks/1', 'task-1', 1)`).run(brandon.id);
  db.prepare(`INSERT INTO notification_log (user_id, category, title, body, delivered)
              VALUES (?, 'push.sent', 'Reminder', 'Trash tomorrow', 0)`).run(brandon.id);

  // Wait for listen().
  await new Promise((resolve, reject) => {
    server.listen(parseInt(process.env.PORT, 10), '127.0.0.1', resolve);
    server.on('error', reject);
  });

  // Anonymous call.
  const anon = await getJson('/api/me/snapshot');
  assertEq(anon.status, 401, 'anonymous GET /api/me/snapshot is 401');

  // Login as brandon.
  const login = await postJson('/api/login', { username: 'brandon', password: 'smoke-snap-brandon-pw' });
  assertEq(login.status, 200, 'login as brandon (200)');
  const cookie = (login.headers['set-cookie'] || []).find(c => c.startsWith('connect.sid='));
  if (!cookie) {
    ng('session cookie set', `headers=${JSON.stringify(login.headers)}`);
    process.exit(1);
  }
  const sid = cookie.split(';')[0];

  // Get the snapshot.
  const snap = await getJson('/api/me/snapshot', { cookie: sid });
  assertEq(snap.status, 200, 'authenticated GET /api/me/snapshot is 200');
  let body;
  try {
    body = JSON.parse(snap.body);
  } catch (e) {
    ng('snapshot body is valid JSON', `body=${snap.body.slice(0, 200)}`);
    process.exit(1);
  }
  ok('snapshot body is valid JSON');

  // No credential field names appear in the payload (the publicView
  // contract carries through to the snapshot too).
  const serialized = snap.body;
  if (/(cred_blob|app_password|access_token|refresh_token|client_secret)/i.test(serialized)) {
    ng('snapshot payload has no credential field names', `sensitive token present in body`);
  } else {
    ok('snapshot payload has no credential field names');
  }

  // §7 envelope
  const expectedTop = ['user', 'now', 'today', 'today_tasks', 'today_events',
    'overdue_tasks', 'upcoming', 'lists', 'activity_recent'];
  const keys = Object.keys(body).sort();
  assertEq(keys, expectedTop.sort(), 'snapshot envelope matches §7');

  // user
  assertEq(body.user.username, 'brandon', 'snapshot.user.username is brandon');
  assert(Array.isArray(body.user.groups), 'snapshot.user.groups is an array');

  // today_tasks
  const todayTitles = body.today_tasks.map(t => t.title).sort();
  assert(todayTitles.includes('Take out trash'), 'today_tasks has Take out trash');
  assert(todayTitles.includes('Wash dishes'), 'today_tasks has Wash dishes');
  assert(!todayTitles.includes('Already done task'), 'today_tasks excludes done task');
  assert(!todayTitles.includes('Emily lineup'), 'today_tasks excludes emily-only task');
  assert(!todayTitles.includes('Pay electric bill'), 'today_tasks excludes tomorrow (upcoming chores)');
  assert(!todayTitles.includes('Submit expense report'), 'today_tasks excludes overdue (overdue_tasks)');

  // overdue_tasks
  const overdueTitles = body.overdue_tasks.map(t => t.title);
  assert(overdueTitles.includes('Submit expense report'), 'overdue_tasks has Submit expense report');

  // upcoming.chores_due_next_7_days
  const upcomingChores = body.upcoming.chores_due_next_7_days.map(t => t.title);
  assert(upcomingChores.includes('Pay electric bill'), 'upcoming.chores_due_next_7_days has Pay electric bill (+1)');
  assert(upcomingChores.includes('Replace light bulb'), 'upcoming.chores_due_next_7_days has Replace light bulb (+3)');
  assert(!upcomingChores.includes('Plan vacation'), 'upcoming.chores_due_next_7_days excludes +14');
  assert(!upcomingChores.includes('Take out trash'), 'upcoming.chores_due_next_7_days excludes today');

  // today_events
  const todayEventTitles = body.today_events.map(e => e.title).sort();
  assert(todayEventTitles.includes('Standup'), 'today_events has Standup');
  assert(todayEventTitles.includes('Movie night'), 'today_events has Movie night');
  assert(!todayEventTitles.includes('Dentist'), 'today_events excludes +3 day');

  // upcoming.events_next_7_days
  const upcomingEventTitles = body.upcoming.events_next_7_days.map(e => e.title);
  assert(upcomingEventTitles.includes('Standup'), 'upcoming.events_next_7_days includes today (Standup)');
  assert(upcomingEventTitles.includes('Dentist'), 'upcoming.events_next_7_days has Dentist (+3)');
  assert(!upcomingEventTitles.includes('Vacation start'), 'upcoming.events_next_7_days excludes +14');

  // activity_recent
  assert(body.activity_recent.length >= 2, `activity_recent has at least 2 entries (got ${body.activity_recent.length})`);
  const cats = body.activity_recent.map(a => a.category);
  assert(cats.includes('task.created'), 'activity_recent includes task.created');
  assert(cats.includes('push.sent'), 'activity_recent includes push.sent');

  // lists
  assertEq(body.lists, {}, 'lists is `{}` (no lists table yet)');

  // X-Homestead-Tz header flips the published tz.
  const snapTz = await getJson('/api/me/snapshot', { cookie: sid, 'x-homestead-tz': 'Asia/Tokyo' });
  assertEq(snapTz.status, 200, 'snapshot with X-Homestead-Tz is 200');
  const bodyTz = JSON.parse(snapTz.body);
  assertEq(bodyTz.user.tz, 'Asia/Tokyo', 'X-Homestead-Tz is honored');

  // ---- summary ----
  console.log(`\n[smoke-snapshot] ${pass} pass, ${fail} fail`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
})();
