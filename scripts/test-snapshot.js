#!/usr/bin/env node
// PHA-1902 (PHA-1617.9) acceptance tests for the snapshot endpoint.
//
// Covers:
//   * Build shape matches design doc §7 (`user`, `now`, `today`,
//     `today_tasks`, `today_events`, `overdue_tasks`, `upcoming`,
//     `lists`, `activity_recent`).
//   * Today's tasks = assignee IN (user, 'all'), due_date = today,
//     not done.
//   * Overdue tasks = assignee IN (user, 'all'), due_date < today,
//     not done.
//   * Upcoming chores (next 7 days) exclude today (covered by
//     today_tasks) and include tomorrow + days after.
//   * Today's events = native + provider cache (merged feed matrix).
//   * activity_recent falls back to notification_log (v0 source).
//   * Other users' tasks are NOT in the snapshot (scoping).
//   * `done = 1` tasks are NOT in the snapshot (treated as complete).
//   * `lists` is `{}` (no lists table yet) — the contract is "empty
//     object" not "missing key".
//   * Anonymous requests get 401.
//   * `X-Homestead-Tz` header is honored when present (falls back to
//     host TZ otherwise).
//   * Builder is deterministic when `opts.now` is supplied.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const calendarSources = require('../lib/calendar-sources');
const secretBox = require('../lib/secret-box');
const snapshot = require('../lib/snapshot');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-1902 snapshot tests\n');

// ---- Pure builder tests (no HTTP) ----
function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-snapshot-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  process.env.CALENDAR_CRED_KEY = crypto.randomBytes(32).toString('hex');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  userModel.migrate(db);
  calendarSources.migrate(db);
  return { db, tmpDir };
}

(function testBuilderShape() {
  console.log('Test 1: builder delivers the §7 envelope');
  const { db, tmpDir } = freshDb();
  const fixed = new Date('2026-08-12T15:00:00Z');
  const out = snapshot.build(db, 'brandon', { tz: 'America/New_York', now: fixed });
  const expectedTop = ['user', 'now', 'today', 'today_tasks', 'today_events',
    'overdue_tasks', 'upcoming', 'lists', 'activity_recent'];
  assertEq(Object.keys(out).sort(), expectedTop.sort(), 'top-level keys match §7');
  assertEq(Object.keys(out.upcoming).sort(), ['chores_due_next_7_days', 'events_next_7_days'],
    'upcoming block has events + chores sections');
  assertEq(out.user.username, 'brandon', 'user.username is brandon');
  assertEq(out.user.tz, 'America/New_York', 'tz is forwarded');
  assertEq(out.today, '2026-08-12', 'today is the local date at the supplied `now`');
  assertEq(out.now, '2026-08-12T15:00:00.000Z', 'now is the supplied instant (ISO)');
  assert(Array.isArray(out.today_tasks), 'today_tasks is an array');
  assert(Array.isArray(out.today_events), 'today_events is an array');
  assert(Array.isArray(out.overdue_tasks), 'overdue_tasks is an array');
  assert(Array.isArray(out.upcoming.events_next_7_days), 'upcoming.events_next_7_days is an array');
  assert(Array.isArray(out.upcoming.chores_due_next_7_days), 'upcoming.chores_due_next_7_days is an array');
  // PHA-2586: lists primitive now ships; lib/snapshot.js returns
  // { list_count, open_item_count, active_lists: [...] } via safeListsStats.
  // Even a freshly migrated-but-empty DB still gets an object, never {}.
  assert(out.lists && typeof out.lists === 'object' && !Array.isArray(out.lists), 'lists is an object envelope');
  assertEq(out.lists.list_count, 0, 'fresh DB has list_count=0');
  assertEq(out.lists.open_item_count, 0, 'fresh DB has open_item_count=0');
  assert(Array.isArray(out.lists.active_lists), 'fresh DB active_lists is an array');
  assertEq(out.lists.active_lists.length, 0, 'fresh DB active_lists is empty');
  assert(Array.isArray(out.activity_recent), 'activity_recent is an array');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testIsoDateLocal() {
  console.log('Test 2: isoDateLocal uses local-time components');
  const local = snapshot.isoDateLocal(new Date('2026-08-12T23:30:00').getTime());
  if (local === '2026-08-12' || local === '2026-08-13') {
    ok(`isoDateLocal respects local TZ (${local})`);
  } else {
    ng('isoDateLocal respects local TZ', `unexpected ${local}`);
  }
})();

(function testScoping() {
  console.log('Test 3: snapshot only contains tasks for the requested user');
  const { db, tmpDir } = freshDb();
  const today = '2026-08-12';
  const yesterday = '2026-08-11';
  // Tasks assigned to brandon — should appear.
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Take out trash', 'brandon', today);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Wash dishes', 'brandon', today);
  // Tasks assigned to emily — should NOT appear.
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'emily')`).run('Emily-only task', 'emily', today);
  // Tasks assigned to 'all' — should appear.
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Everyone sweeps', 'all', today);
  // Done task — should NOT appear.
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, done_by, created_by)
              VALUES (?, ?, ?, 1, 'brandon', 'brandon')`).run('Already done', 'brandon', today);
  // Overdue for brandon — should appear in overdue_tasks.
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Forgot last week', 'brandon', yesterday);

  const fixed = new Date('2026-08-12T15:00:00Z');
  const out = snapshot.build(db, 'brandon', { tz: 'America/New_York', now: fixed });
  const titleSet = (arr) => new Set(arr.map(t => t.title));
  const todayTitles = titleSet(out.today_tasks);
  assert(todayTitles.has('Take out trash'), 'brandon task due today appears');
  assert(todayTitles.has('Wash dishes'), 'second brandon task appears');
  assert(todayTitles.has('Everyone sweeps'), 'everyone task appears');
  assert(!todayTitles.has('Emily-only task'), 'emily-only task does NOT appear');
  assert(!todayTitles.has('Already done'), 'done task does NOT appear');

  const overdueTitles = titleSet(out.overdue_tasks);
  assert(overdueTitles.has('Forgot last week'), 'overdue task appears');

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testUpcomingChoresWindow() {
  console.log('Test 4: upcoming.chores_due_next_7_days excludes today, includes +1..+7');
  const { db, tmpDir } = freshDb();
  const today = '2026-08-12';
  const inTwo = '2026-08-14';
  const inEight = '2026-08-20';
  const yesterday = '2026-08-11';
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Today', 'brandon', today);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('In two days', 'brandon', inTwo);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('In eight days', 'brandon', inEight);
  db.prepare(`INSERT INTO tasks (title, assignee, due_date, done, created_by)
              VALUES (?, ?, ?, 0, 'brandon')`).run('Yesterday', 'brandon', yesterday);

  const fixed = new Date('2026-08-12T15:00:00Z');
  const out = snapshot.build(db, 'brandon', { tz: 'America/New_York', now: fixed });
  const upcomingTitles = new Set(out.upcoming.chores_due_next_7_days.map(t => t.title));
  assert(!upcomingTitles.has('Today'), 'today does NOT appear in upcoming chores');
  assert(upcomingTitles.has('In two days'), 'in-two-days appears');
  assert(!upcomingTitles.has('In eight days'), 'in-eight-days (+8) does NOT appear');
  assert(!upcomingTitles.has('Yesterday'), 'yesterday does NOT appear in upcoming chores');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testActivityFallback() {
  console.log('Test 5: activity_recent pulls from notification_log');
  const { db, tmpDir } = freshDb();
  // notification_log is created inline in server.js, not via a migrate().
  // Create the schema here so the test exercises the table explicitly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      tag TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      skipped_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  // Insert OLDER first, then NEWER so the order assertion is meaningful.
  db.prepare(`INSERT INTO notification_log (user_id, category, title, body, delivered)
              VALUES (?, ?, ?, ?, 0)`).run(brandon.id, 'push.sent', 'Reminder', 'Trash tomorrow');
  db.prepare(`INSERT INTO notification_log (user_id, category, title, body, url, tag, delivered)
              VALUES (?, ?, ?, ?, ?, ?, 1)`).run(brandon.id, 'task.created', 'New task', 'Take out trash', '/tasks/1', 'task-1');
  const out = snapshot.build(db, 'brandon', { tz: 'America/New_York', now: new Date() });
  assertEq(out.activity_recent.length, 2, 'two notification_log entries become activity_recent');
  assertEq(out.activity_recent[0].category, 'task.created', 'first entry is the most recent');
  assertEq(out.activity_recent[0].title, 'New task', 'activity_recent title surfaces');
  assertEq(out.activity_recent[0].url, '/tasks/1', 'activity_recent url surfaces');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testMergedEventsFor() {
  console.log('Test 6: merged day returns native + provider-cached events');
  const { db, tmpDir } = freshDb();
  // Native event today.
  db.prepare(`INSERT INTO events (title, date, time, notes, owner, created_by)
              VALUES (?, ?, ?, ?, ?, 'brandon')`).run('Standup', '2026-08-12', '09:00', 'Daily', 'brandon');
  // Provider event (calendar_event_cache) — needs a row in calendar_sources.
  const credBlob = secretBox.encryptString(JSON.stringify({ app_password: 'pw' }));
  const r = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, enabled, created_by)
    VALUES (NULL, 'caldav_nextcloud', 'brandon', 'https://nc.example/dav/personal', 'https://nc.example/dav', 'Nextcloud', '#7c9eb8', ?, 1, 'brandon')`).run(credBlob);
  const srcId = r.lastInsertRowid;
  db.prepare(`INSERT INTO calendar_event_cache
    (source_id, external_id, title, description, start_at, end_at, all_day, location)
    VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`).run(srcId, 'evt-1', 'Provider event', 'Cached',
    '2026-08-12T10:00:00Z', '2026-08-12T11:00:00Z');
  const merged = snapshot.mergedEventsFor(db, '2026-08-12', '2026-08-12');
  const origins = merged.map(e => e.origin).sort();
  assertEq(origins, ['native', 'provider:caldav_nextcloud'], 'merged feed has native + provider');
  assert(merged.some(e => e.title === 'Standup'), 'native event surfaced');
  assert(merged.some(e => e.title === 'Provider event'), 'provider event surfaced');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(function testResolveTzHeader() {
  console.log('Test 7: resolveTz honors X-Homestead-Tz');
  const req = { get: (h) => h === 'x-homestead-tz' ? 'Europe/Berlin' : null };
  assertEq(snapshot.resolveTz(req), 'Europe/Berlin', 'explicit header wins');
  const req2 = { get: () => null };
  const tz = snapshot.resolveTz(req2);
  assert(typeof tz === 'string' && tz.length > 0, 'fallback to host TZ is a non-empty string');
});

(function testBuilderThrowsOnUnknownUser() {
  console.log('Test 8: builder throws on unknown user');
  const { db, tmpDir } = freshDb();
  let threw = false;
  try { snapshot.build(db, 'nobody', { tz: 'UTC' }); }
  catch (e) { threw = /user not found/.test(e.message); }
  assert(threw, 'unknown user triggers a defensive throw');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ---- HTTP test (boots server.js in-process) ----
function bootServerAndLogin() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-snapshot-http-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '3098';
  process.env.ADMIN_PASSWORD = 'snap-admin-pw';
  process.env.BRANDON_PASSWORD = 'snap-brandon-pw';
  process.env.SESSION_SECRET = 'snap-secret-' + crypto.randomBytes(4).toString('hex');
  process.env.NODE_ENV = 'production';
  process.env.CALENDAR_CRED_KEY = crypto.randomBytes(32).toString('hex');
  // Stub the caldav adapter so the http test doesn't touch the network.
  calendarSources.registerAdapter('caldav', () => ({
    kind: 'caldav',
    listCalendars: async () => [],
    listEvents: async () => [],
    createEvent: async () => { throw new Error('not impl'); },
    updateEvent: async () => { throw new Error('not impl'); },
    deleteEvent: async () => { throw new Error('not impl'); },
  }));
  require('../server.js');
  // server.js only calls app.listen() when invoked as `node server.js`.
  // When required as a module (test bootstrap), wrap it in a plain
  // http.Server so we can pick the port and feed it a request.
  const app = require('../server.js');
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(parseInt(process.env.PORT, 10), '127.0.0.1', () => {
      const req = http.request({
        method: 'POST',
        host: '127.0.0.1',
        port: parseInt(process.env.PORT, 10),
        path: '/api/login',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        const data = [];
        res.on('data', (c) => data.push(c));
        res.on('end', () => {
          const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('connect.sid='));
          if (!cookie) throw new Error('no session cookie');
          const sid = cookie.split(';')[0];
          resolve({ sid, base: `http://127.0.0.1:${process.env.PORT}`, server });
        });
      });
      req.end(JSON.stringify({ username: 'brandon', password: 'snap-brandon-pw' }));
    });
    server.on('error', reject);
  });
}

(async () => {
  console.log('Test 9: anonymous GET /api/me/snapshot returns 401');
  const sess = await bootServerAndLogin();
  await new Promise((resolve) => {
    const req = http.request({ method: 'GET', host: '127.0.0.1', port: parseInt(process.env.PORT, 10), path: '/api/me/snapshot' }, (res) => {
      assertEq(res.statusCode, 401, 'anonymous snapshot is 401');
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.end();
  });

  console.log('Test 10: authenticated GET /api/me/snapshot returns §7 envelope');
  await new Promise((resolve) => {
    const req = http.request({
      method: 'GET', host: '127.0.0.1', port: parseInt(process.env.PORT, 10),
      path: '/api/me/snapshot',
      headers: { cookie: sess.sid },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assertEq(res.statusCode, 200, '200 OK');
        assertEq(body.user.username, 'brandon', 'user.username is brandon');
        assert(Array.isArray(body.today_tasks), 'today_tasks is array');
        assert(Array.isArray(body.today_events), 'today_events is array');
        assert(Array.isArray(body.overdue_tasks), 'overdue_tasks is array');
        assert(body.lists && typeof body.lists === 'object' && !Array.isArray(body.lists), 'lists is an object envelope');
        assertEq(typeof body.lists.list_count, 'number', 'lists.list_count is a number');
        assertEq(typeof body.lists.open_item_count, 'number', 'lists.open_item_count is a number');
        assert(Array.isArray(body.lists.active_lists), 'lists.active_lists is an array');
        assert(/^\d{4}-\d{2}-\d{2}$/.test(body.today), 'today is YYYY-MM-DD');
        resolve();
      });
    });
    req.end();
  });

  console.log('Test 11: X-Homestead-Tz header is honored');
  await new Promise((resolve) => {
    const req = http.request({
      method: 'GET', host: '127.0.0.1', port: parseInt(process.env.PORT, 10),
      path: '/api/me/snapshot',
      headers: { cookie: sess.sid, 'x-homestead-tz': 'Asia/Tokyo' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assertEq(body.user.tz, 'Asia/Tokyo', 'tz comes from the header');
        resolve();
      });
    });
    req.end();
  });

  // Done. The HTTP server keeps the event loop alive, so exit.
  process.exit(fail > 0 ? 1 : 0);
})();
