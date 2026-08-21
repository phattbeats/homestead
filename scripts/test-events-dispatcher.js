#!/usr/bin/env node
// PHA-1617.7 acceptance tests for the events webhook outbound
// dispatcher (design doc §6.1/6.5) — task/chore/event/push category
// fan-out to per-user, per-harness `kind='events'` agent_endpoints,
// gated by `event_filter` opt-in, with the same HMAC signing +
// retry/circuit-breaker mechanics as the drawer dispatcher.
//
// Tests:
//   1. Module surface (constants, sign, buildEventBody, etc.)
//   2. sign() matches HMAC_SHA256(secret, ts + "." + body)
//   3. Category opt-in: only endpoints with event_filter[category]===true
//      receive that category; others are silently skipped.
//   4. POST /api/tasks fires 'task_created' (fire-and-forget) with a
//      correctly signed body.
//   5. Toggling a recurring+rotating task fires 'chore_rotated' to the
//      NEW assignee, not 'task_completed'.
//   6. Toggling a plain (non-recurring) task fires 'task_completed' /
//      'task_uncompleted'.
//   7. POST /api/events fires 'event_created'; owner='all' fans out to
//      every user's opted-in endpoints.
//   8. A push notification (POST /api/notify) mirrors out as a 'push'
//      category event.
//   9. Retry/backoff: harness returns 500 twice then 200; dispatch
//      succeeds after retries.
//  10. Circuit breaker: 5 consecutive failures auto-disables the
//      endpoint (enabled=0), independent of the drawer's streak map.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentEndpoints = require('../lib/agent-endpoints');
const eventsDispatch = require('../lib/events-dispatch');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

// ---------- helpers ----------

function freshStack() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-events-dispatcher-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db); // seeds admin/brandon/emily + tasks/events tables
  agentEndpoints.migrate(db);
  db.close();
  return { tmpDir };
}

function bootFreshStack() {
  const { tmpDir } = freshStack();
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const db = new Database(path.join(tmpDir, 'life.db'));
  if (app.locals && app.locals.eventsStreakMap) app.locals.eventsStreakMap.clear();
  const server = http.createServer(app);
  return { db, tmpDir, server, app };
}

function teardown(db, server, tmpDir) {
  try { server.close(); } catch (_) {}
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const request = (opts, body) => new Promise((resolveReq, rejectReq) => {
        const req = http.request(opts, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(data); } catch (_) { /* not json */ }
            resolveReq({ status: res.statusCode, headers: res.headers, body: json, raw: data });
          });
        });
        req.on('error', rejectReq);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
      resolve({ port, request });
    });
  });
}

async function login(request, base, username) {
  const r = await request({
    ...base, path: '/api/login', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { username, password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' });
  if (r.status !== 200) throw new Error(`login failed for ${username}: ${JSON.stringify(r.body)}`);
  return (r.headers['set-cookie'] || [])[0];
}

// Fire-and-forget dispatch means the triggering HTTP response can land
// before the webhook POST does. Poll instead of asserting immediately.
function waitFor(check, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function tick() {
      let result;
      try { result = check(); } catch (_) { result = false; }
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'));
      setTimeout(tick, intervalMs);
    })();
  });
}

// Same scripted fake harness as test-drawer-backend.js: a tiny HTTP
// server that replays a scripted list of {status} responses in order.
function makeFakeHarness(script) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
        const entry = script.shift() || { status: 200 };
        res.statusCode = entry.status || 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(entry.body || { ack: true }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/webhook/events`,
        seen,
        close: () => new Promise(r => srv.close(r)),
      });
    });
  });
}

function verifySignature(signatureHeader, secret, ts, body) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- tests ----------

async function main() {
  // ---------- Test 1: module surface ----------
  console.log('Test 1: events dispatcher module exposes the right shape');
  try {
    assertEq(eventsDispatch.KIND_EVENTS, 'events', 'KIND_EVENTS = "events"');
    assertEq(typeof eventsDispatch.dispatchEvent, 'function', 'dispatchEvent is a function');
    assertEq(typeof eventsDispatch.dispatchEventForAssignee, 'function', 'dispatchEventForAssignee is a function');
    assertEq(typeof eventsDispatch.sign, 'function', 'sign is exported');
    assertEq(typeof eventsDispatch.buildEventBody, 'function', 'buildEventBody is exported');
    assertEq(typeof eventsDispatch.isCategoryEnabled, 'function', 'isCategoryEnabled is exported');
    assertEq(eventsDispatch.MAX_RETRIES, 4, 'MAX_RETRIES = 4 (parity with drawer)');
    assertEq(eventsDispatch.CIRCUIT_FAILURE_THRESHOLD, 5, 'CIRCUIT_FAILURE_THRESHOLD = 5 (parity with drawer)');
    assertEq(JSON.stringify(eventsDispatch.BACKOFF_MS), JSON.stringify([1000, 4000, 16000, 60000]), 'backoff schedule matches drawer');
  } catch (err) {
    ng('Test 1 crashed', err.stack || err.message);
  }

  // ---------- Test 2: sign payload contract ----------
  console.log('\nTest 2: sign() matches HMAC_SHA256(secret, ts + "." + body)');
  try {
    const secret = 'homestead_aes_topsecret1234567890abcdef';
    const ts = '2026-08-21T14:23:01.123Z';
    const body = '{"event":{"category":"task_created"}}';
    const sig = eventsDispatch.sign(secret, ts, body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
    assertEq(sig, expected, 'sign() output matches manual HMAC computation');
  } catch (err) {
    ng('Test 2 crashed', err.stack || err.message);
  }

  // ---------- Test 3: category opt-in gating ----------
  console.log('\nTest 3: category opt-in — only event_filter[category]===true endpoints receive it');
  let h3a, h3b;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { request } = await startServer(server);
    const brandon = db.prepare('SELECT id, username, display, color FROM users WHERE username = ?').get('brandon');

    h3a = await makeFakeHarness([{ status: 200 }]);
    h3b = await makeFakeHarness([{ status: 200 }]);
    agentEndpoints.create(db, brandon.id, { harnessLabel: 'opted-in', kind: 'events', url: h3a.url, eventFilter: { task_created: true } });
    agentEndpoints.create(db, brandon.id, { harnessLabel: 'not-opted-in', kind: 'events', url: h3b.url, eventFilter: { chore_rotated: true } });

    await eventsDispatch.dispatchEvent(db, new Map(), brandon, 'task_created', { task: { id: 1 } });
    assertEq(h3a.seen.length, 1, 'opted-in endpoint received the dispatch');
    assertEq(h3b.seen.length, 0, 'endpoint without task_created in its filter did NOT receive it');

    teardown(db, server, tmpDir);
    await h3a.close(); await h3b.close();
  } catch (err) {
    ng('Test 3 crashed', err.stack || err.message);
    if (h3a) await h3a.close(); if (h3b) await h3b.close();
  }

  // ---------- Test 4: POST /api/tasks fires task_created ----------
  console.log('\nTest 4: POST /api/tasks fires a signed task_created event');
  let h4;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    h4 = await makeFakeHarness([{ status: 200 }]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'events-hook', kind: 'events', url: h4.url,
      eventFilter: { task_created: true },
    });

    const res = await request({
      ...base, path: '/api/tasks', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { title: 'Take out trash', assignee: 'brandon' });
    assertEq(res.status, 200, 'POST /api/tasks still returns 200 synchronously');

    await waitFor(() => h4.seen.length === 1);
    const seen = h4.seen[0];
    assertEq(seen.headers['x-homestead-user'], 'brandon', 'X-Homestead-User = brandon');
    assertEq(seen.headers['x-homestead-event-category'], 'task_created', 'X-Homestead-Event-Category = task_created');
    const epRow = db.prepare('SELECT secret FROM agent_endpoints WHERE id = ?').get(ep.id);
    assert(verifySignature(seen.headers['x-homestead-signature'], epRow.secret, seen.headers['x-homestead-timestamp'], seen.body),
      'X-Homestead-Signature validates against stored secret');
    const parsed = JSON.parse(seen.body);
    assertEq(parsed.user.username, 'brandon', 'body.user.username = target user');
    assertEq(parsed.event.category, 'task_created', 'body.event.category = task_created');
    assertEq(parsed.event.data.task.title, 'Take out trash', 'body.event.data.task echoes the created task');
    assertEq(typeof parsed.event.id, 'string', 'body.event.id is a request id');

    const after = db.prepare('SELECT last_status_code FROM agent_endpoints WHERE id = ?').get(ep.id);
    assertEq(after.last_status_code, 200, 'last_status_code = 200 after success');

    teardown(db, server, tmpDir);
    await h4.close();
  } catch (err) {
    ng('Test 4 crashed', err.stack || err.message);
    if (h4) await h4.close();
  }

  // ---------- Test 5: chore rotation fires chore_rotated to the NEW assignee ----------
  console.log('\nTest 5: toggling a rotating chore fires chore_rotated to the new assignee only');
  let h5brandon, h5emily;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');

    h5brandon = await makeFakeHarness([{ status: 200 }, { status: 200 }]);
    h5emily = await makeFakeHarness([{ status: 200 }, { status: 200 }]);
    agentEndpoints.create(db, brandon.id, { harnessLabel: 'b', kind: 'events', url: h5brandon.url, eventFilter: { chore_rotated: true, task_created: true } });
    agentEndpoints.create(db, emily.id, { harnessLabel: 'e', kind: 'events', url: h5emily.url, eventFilter: { chore_rotated: true } });

    const created = await request({
      ...base, path: '/api/tasks', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { title: 'Dishes', assignee: 'brandon', alt_assignee: 'emily', recur: 'weekly', rotate: 1 });
    await waitFor(() => h5brandon.seen.length === 1); // task_created

    const toggled = await request({
      ...base, path: `/api/tasks/${created.body.id}/toggle`, method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {});
    assertEq(toggled.body.assignee, 'emily', 'rotation flips assignee to emily');

    await waitFor(() => h5emily.seen.length === 1);
    const parsed = JSON.parse(h5emily.seen[0].body);
    assertEq(parsed.event.category, 'chore_rotated', "emily's endpoint received chore_rotated");
    assertEq(parsed.event.data.previous_assignee, 'brandon', 'data.previous_assignee = brandon');
    assertEq(parsed.event.data.task.assignee, 'emily', 'data.task.assignee = emily (post-rotation)');
    // brandon's endpoint is opted into chore_rotated too, but the event
    // targets the NEW assignee (emily) — brandon should NOT get a second hit.
    assertEq(h5brandon.seen.length, 1, "brandon's endpoint stays at 1 (only task_created, no chore_rotated)");

    teardown(db, server, tmpDir);
    await h5brandon.close(); await h5emily.close();
  } catch (err) {
    ng('Test 5 crashed', err.stack || err.message);
    if (h5brandon) await h5brandon.close(); if (h5emily) await h5emily.close();
  }

  // ---------- Test 6: plain task toggle fires task_completed/task_uncompleted ----------
  console.log('\nTest 6: toggling a plain (non-recurring) task fires task_completed / task_uncompleted');
  let h6;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    h6 = await makeFakeHarness([{ status: 200 }, { status: 200 }, { status: 200 }]);
    agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'events-hook', kind: 'events', url: h6.url,
      eventFilter: { task_completed: true, task_uncompleted: true },
    });
    const created = db.prepare(
      "INSERT INTO tasks (title, assignee, done) VALUES ('Water plants', 'brandon', 0)"
    ).run();
    const taskId = created.lastInsertRowid;

    await request({
      ...base, path: `/api/tasks/${taskId}/toggle`, method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {});
    await waitFor(() => h6.seen.length === 1);
    assertEq(JSON.parse(h6.seen[0].body).event.category, 'task_completed', 'first toggle fires task_completed');

    await request({
      ...base, path: `/api/tasks/${taskId}/toggle`, method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {});
    await waitFor(() => h6.seen.length === 2);
    assertEq(JSON.parse(h6.seen[1].body).event.category, 'task_uncompleted', 'second toggle fires task_uncompleted');

    teardown(db, server, tmpDir);
    await h6.close();
  } catch (err) {
    ng('Test 6 crashed', err.stack || err.message);
    if (h6) await h6.close();
  }

  // ---------- Test 7: POST /api/events fires event_created, owner='all' fans out ----------
  console.log("\nTest 7: POST /api/events fires event_created; owner='all' fans out to every user");
  let h7brandon, h7emily;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');

    h7brandon = await makeFakeHarness([{ status: 200 }]);
    h7emily = await makeFakeHarness([{ status: 200 }]);
    agentEndpoints.create(db, brandon.id, { harnessLabel: 'b', kind: 'events', url: h7brandon.url, eventFilter: { event_created: true } });
    agentEndpoints.create(db, emily.id, { harnessLabel: 'e', kind: 'events', url: h7emily.url, eventFilter: { event_created: true } });

    await request({
      ...base, path: '/api/events', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { title: 'Movie night', date: '2026-09-01', owner: 'all' });

    await waitFor(() => h7brandon.seen.length === 1 && h7emily.seen.length === 1);
    assertEq(JSON.parse(h7brandon.seen[0].body).event.category, 'event_created', "brandon's endpoint got event_created");
    assertEq(JSON.parse(h7emily.seen[0].body).event.category, 'event_created', "emily's endpoint got event_created too (owner='all')");

    teardown(db, server, tmpDir);
    await h7brandon.close(); await h7emily.close();
  } catch (err) {
    ng('Test 7 crashed', err.stack || err.message);
    if (h7brandon) await h7brandon.close(); if (h7emily) await h7emily.close();
  }

  // ---------- Test 8: push notification mirrors as a 'push' category event ----------
  console.log("\nTest 8: POST /api/notify mirrors out as a 'push' category event");
  let h8;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    h8 = await makeFakeHarness([{ status: 200 }]);
    agentEndpoints.create(db, brandon.id, { harnessLabel: 'events-hook', kind: 'events', url: h8.url, eventFilter: { push: true } });
    // A push_subscriptions row (even a fake endpoint) is required for
    // notify() to reach the delivery loop instead of short-circuiting
    // on "no_subscription".
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
                VALUES (?, 'https://example.invalid/push/abc', 'p256dh-stub', 'auth-stub')`).run(brandon.id);

    await request({
      ...base, path: '/api/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { userId: brandon.id, payload: { title: 'Chore due', body: 'Take out trash', category: 'chore_due' }, force: true });

    await waitFor(() => h8.seen.length === 1);
    const parsed = JSON.parse(h8.seen[0].body);
    assertEq(parsed.event.category, 'push', "event.category = 'push'");
    assertEq(parsed.event.data.title, 'Chore due', 'data.title forwarded from the push payload');
    assertEq(parsed.event.data.category, 'chore_due', 'data.category carries the underlying push category');

    teardown(db, server, tmpDir);
    await h8.close();
  } catch (err) {
    ng('Test 8 crashed', err.stack || err.message);
    if (h8) await h8.close();
  }

  // ---------- Test 9: retry/backoff ----------
  console.log('\nTest 9: retry/backoff — 2x 500 then 200 succeeds');
  let h9;
  try {
    const origBackoff = eventsDispatch.BACKOFF_MS.slice();
    eventsDispatch.__test__.BACKOFF_MS[0] = 10;
    eventsDispatch.__test__.BACKOFF_MS[1] = 10;

    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    h9 = await makeFakeHarness([{ status: 500 }, { status: 500 }, { status: 200 }]);
    const ep = agentEndpoints.create(db, brandon.id, { harnessLabel: 'flaky', kind: 'events', url: h9.url, eventFilter: { task_created: true } });

    await request({
      ...base, path: '/api/tasks', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { title: 'Retry me', assignee: 'brandon' });

    await waitFor(() => h9.seen.length === 3, { timeoutMs: 5000 });
    const after = db.prepare('SELECT last_status_code, enabled FROM agent_endpoints WHERE id = ?').get(ep.id);
    assertEq(after.last_status_code, 200, 'last_status_code = 200 after the retry succeeds');
    assertEq(after.enabled, 1, 'endpoint stays enabled (streak reset on success)');

    eventsDispatch.__test__.BACKOFF_MS[0] = origBackoff[0];
    eventsDispatch.__test__.BACKOFF_MS[1] = origBackoff[1];

    teardown(db, server, tmpDir);
    await h9.close();
  } catch (err) {
    ng('Test 9 crashed', err.stack || err.message);
    if (h9) await h9.close();
  }

  // ---------- Test 10: circuit breaker ----------
  console.log('\nTest 10: circuit breaker — 5 consecutive failures auto-disable, independent of drawer streak');
  let h10;
  try {
    const origBackoff = eventsDispatch.BACKOFF_MS.slice();
    eventsDispatch.__test__.BACKOFF_MS[0] = 5;
    eventsDispatch.__test__.BACKOFF_MS[1] = 5;
    eventsDispatch.__test__.BACKOFF_MS[2] = 5;
    eventsDispatch.__test__.BACKOFF_MS[3] = 5;

    const { db, tmpDir, server, app } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    h10 = await makeFakeHarness(Array.from({ length: 10 }, () => ({ status: 500 })));
    const ep = agentEndpoints.create(db, brandon.id, { harnessLabel: 'dead', kind: 'events', url: h10.url, eventFilter: { task_created: true } });

    await request({
      ...base, path: '/api/tasks', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { title: 'Doomed', assignee: 'brandon' });

    await waitFor(() => {
      const row = db.prepare('SELECT enabled FROM agent_endpoints WHERE id = ?').get(ep.id);
      return row && row.enabled === 0;
    }, { timeoutMs: 5000 });
    assertEq(h10.seen.length, 5, '5 attempts (initial + 4 retries) before the breaker trips');
    const after = db.prepare('SELECT enabled, last_error FROM agent_endpoints WHERE id = ?').get(ep.id);
    assertEq(after.enabled, 0, 'endpoint.enabled flipped to 0 (auto-disable)');
    assert(after.last_error && after.last_error.startsWith('circuit_broken:'), 'last_error records circuit_broken');
    assertEq(app.locals.drawerStreakMap.get(ep.id), undefined, "drawer's streak map is untouched by events dispatch");

    eventsDispatch.__test__.BACKOFF_MS[0] = origBackoff[0];
    eventsDispatch.__test__.BACKOFF_MS[1] = origBackoff[1];
    eventsDispatch.__test__.BACKOFF_MS[2] = origBackoff[2];
    eventsDispatch.__test__.BACKOFF_MS[3] = origBackoff[3];

    teardown(db, server, tmpDir);
    await h10.close();
  } catch (err) {
    ng('Test 10 crashed', err.stack || err.message);
    if (h10) await h10.close();
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
