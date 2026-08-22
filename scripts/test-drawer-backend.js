#!/usr/bin/env node
// PHA-1617.6 acceptance tests for the drawer backend (HMAC-signed
// outbound POST + SSE/JSON consumer + retry/backoff + circuit breaker)
// at /api/drawer, design doc §6.2–6.5.
//
// Tests:
//   1. The dispatcher module exposes the right shape (constants,
//      signPayload, parseSseBlock).
//   2. signPayload matches HMAC_SHA256(secret, ts + "." + body).
//   3. SSE reply: a fake harness that streams text/event-stream
//      produces chunk + done events; signature header validates
//      against the stored secret; conversation_id is echoed.
//   4. JSON reply: a fake harness that returns application/json gets
//      the same wire shape and signature.
//   5. Retry/backoff: harness returns 500 three times then 200;
//      dispatcher succeeds after the third retry. Bookkeeping shows
//      the failed attempts.
//   6. Circuit breaker: 5 consecutive failures (5x 500) trip the
//      breaker; endpoint.enabled flips to 0; the route returns 503
//      with `error: "circuit_broken"`.
//   7. Cross-user endpoint refusal preserved (404, no leak).
//   8. Events-kind and disabled endpoints refused (404).
//   9. Endpoint offline (all 4 retries exhausted) returns 502 with
//      `error: "endpoint_offline"` and the per-route bookkeeping
//      shows the last status code.
//  10. The /api/drawer route includes a fresh morning-brief
//      `snapshot` payload (via lib/snapshot.build) in the signed
//      outbound POST body.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentEndpoints = require('../lib/agent-endpoints');
const drawerDispatch = require('../lib/drawer-dispatch');
const snapshot = require('../lib/snapshot');

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-drawer-backend-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  agentEndpoints.migrate(db);
  // Seed a few extra tables snapshot.build expects (tasks, events,
  // user_groups, etc.) so the morning-brief envelope is non-empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, title TEXT, notes TEXT, assignee TEXT,
      alt_assignee TEXT, due_date TEXT, recur TEXT, rotate INTEGER,
      done INTEGER DEFAULT 0, done_by TEXT, done_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, title TEXT, date TEXT, time TEXT, notes TEXT,
      owner TEXT, source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
      display_name TEXT, source_provider TEXT DEFAULT 'manual',
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_groups (
      user_id INTEGER NOT NULL, group_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, group_id)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY, actor TEXT, verb TEXT, target TEXT,
      ts TEXT DEFAULT (datetime('now')), payload TEXT
    );
    INSERT OR IGNORE INTO groups (id, name, display_name)
      VALUES (1, 'admins', 'Admins');
    INSERT OR IGNORE INTO groups (id, name, display_name)
      VALUES (2, 'homestead-users', 'Users');
  `);
  // Match snapshot.build's local-time definition of "today". SQLite's
  // date('now') is UTC and diverges near local midnight.
  const today = snapshot.isoDateLocal(Date.now());
  db.prepare(`INSERT OR IGNORE INTO tasks (id, title, assignee, due_date, done)
    VALUES (1, 'Take out trash', 'brandon', ?, 0)`).run(today);
  db.prepare(`INSERT OR IGNORE INTO events (id, title, date, time, owner)
    VALUES (1, 'Movie night', ?, '20:00', 'all')`).run(today);
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(1, 2);
  return { db, tmpDir };
}

function bootFreshStack() {
  const { db, tmpDir } = freshStack();
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  // Reset the in-memory streak map so each test starts at 0.
  if (app.locals && app.locals.drawerStreakMap) app.locals.drawerStreakMap.clear();
  const server = http.createServer(app);
  return { db, tmpDir, server, app };
}

function teardown(server, tmpDir) {
  try { server.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const request = (opts, body, raw) => new Promise((resolveReq, rejectReq) => {
        const req = http.request(opts, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(data); } catch (_) { /* not json */ }
            resolveReq({ status: res.statusCode, headers: res.headers, body: json, raw: data, chunks });
          });
        });
        req.on('error', rejectReq);
        if (body && !raw) req.write(JSON.stringify(body));
        else if (raw) req.write(raw);
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

// ---------- fake harness ----------
// A tiny HTTP server that replays a scripted response. The script is
// a list of entries; each entry is either:
//   { status: 500, body: 'no' }      → respond with that status
//   { kind: 'sse', chunks, done }    → respond with text/event-stream
//   { kind: 'json', body }           → respond with application/json
// Each entry is consumed in order; after the script is exhausted, the
// server starts returning 500 (so tests that need more responses than
// scripted will fail loudly).
function makeFakeHarness(script) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
        const entry = script.shift();
        if (!entry) {
          res.statusCode = 500;
          res.end('exhausted');
          return;
        }
        if (entry.status) {
          res.statusCode = entry.status;
          res.setHeader('Content-Type', 'text/plain');
          res.end(entry.body || '');
          return;
        }
        if (entry.kind === 'sse') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          const chunks = entry.chunks || [];
          for (const chunk of chunks) {
            res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
          }
          res.write(`event: done\ndata: ${JSON.stringify(entry.done || { request_id: 'unknown' })}\n\n`);
          res.end();
          return;
        }
        if (entry.kind === 'json') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(entry.body || {}));
          return;
        }
        res.statusCode = 500;
        res.end('unknown_script_entry');
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/webhook/drawer`,
        seen,
        close: () => new Promise(r => srv.close(r)),
      });
    });
  });
}

// Validate an X-Homestead-Signature header against a secret + body.
function verifySignature(signatureHeader, secret, ts, body) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
  // Constant-time compare
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- tests ----------

async function main() {
  // ---------- Test 1: module surface ----------
  console.log('Test 1: dispatcher module exposes the right shape');
  try {
    assertEq(typeof drawerDispatch.dispatchDrawer, 'function', 'dispatchDrawer is a function');
    assertEq(typeof drawerDispatch.sign, 'function', 'sign is exported');
    assertEq(typeof drawerDispatch.parseSseBlock, 'function', 'parseSseBlock is exported');
    assertEq(typeof drawerDispatch.buildBody, 'function', 'buildBody is exported');
    assertEq(typeof drawerDispatch.httpPostOnce, 'function', 'httpPostOnce is exported');
    assertEq(drawerDispatch.MAX_RETRIES, 4, 'MAX_RETRIES = 4');
    assertEq(drawerDispatch.CIRCUIT_FAILURE_THRESHOLD, 5, 'CIRCUIT_FAILURE_THRESHOLD = 5');
    assertEq(JSON.stringify(drawerDispatch.BACKOFF_MS), JSON.stringify([1000, 4000, 16000, 60000]), 'backoff schedule = 1s/4s/16s/60s');
  } catch (err) {
    ng('Test 1 crashed', err.stack || err.message);
  }

  // ---------- Test 2: sign payload contract ----------
  console.log('\nTest 2: sign() matches HMAC_SHA256(secret, ts + "." + body)');
  try {
    const secret = 'homestead_aes_topsecret1234567890abcdef';
    const ts = '2026-08-09T14:23:01.123Z';
    const body = '{"hello":"world"}';
    const sig = drawerDispatch.sign(secret, ts, body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
    assertEq(sig, expected, 'sign() output matches manual HMAC computation');
  } catch (err) {
    ng('Test 2 crashed', err.stack || err.message);
  }

  // ---------- Test 3: SSE reply ----------
  console.log('\nTest 3: SSE reply (text/event-stream) — fake harness streams chunks');
  let harness;
  try {
    const { db, tmpDir, server, app } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    harness = await makeFakeHarness([{
      kind: 'sse',
      chunks: ['You have ', '3 tasks today.'],
      done: { request_id: 'will-be-overwritten', tokens_in: 12, tokens_out: 7, duration_ms: 80 },
    }]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Laptop OpenClaw',
      kind: 'drawer',
      url: harness.url,
    });

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {
      message: "what's on my plate?",
      endpoint_id: ep.id,
      conversation_id: 'c-sse-1',
    });
    assertEq(res.status, 200, 'POST /api/drawer returns 200');
    assertEq(res.headers['content-type'].toLowerCase().includes('text/event-stream'),
             true, 'SSE Content-Type is text/event-stream');
    assertEq(res.headers['x-homestead-request-id'].length > 0, true,
             'response carries X-Homestead-Request-Id');

    const body = Buffer.concat(res.chunks).toString('utf8');
    assert(body.includes('event: chunk'), 'SSE body has `event: chunk`');
    assert(body.includes('event: done'), 'SSE body has terminal `event: done`');
    assert(body.includes('You have'), 'first chunk arrived');
    assert(body.includes('3 tasks today.'), 'second chunk arrived');
    const doneMatch = body.match(/event: done\ndata: (\{.*?\})\n\n/);
    assert(!!doneMatch, '`done` event present and parseable');
    if (doneMatch) {
      const doneData = JSON.parse(doneMatch[1]);
      assertEq(doneData.conversation_id, 'c-sse-1', 'done.conversation_id echoes request');
      assertEq(typeof doneData.request_id, 'string', 'done.request_id is a string');
      assertEq(doneData.tokens_in, 12, 'done.tokens_in forwarded from harness');
      assertEq(doneData.tokens_out, 7, 'done.tokens_out forwarded from harness');
    }

    // The fake harness saw exactly one POST with our headers.
    assertEq(harness.seen.length, 1, 'fake harness received exactly 1 request');
    if (harness.seen.length === 1) {
      const seen = harness.seen[0];
      assertEq(seen.method, 'POST', 'method = POST');
      assertEq(seen.headers['x-homestead-user'], 'brandon', 'X-Homestead-User header');
      assertEq(typeof seen.headers['x-homestead-request-id'], 'string', 'X-Homestead-Request-Id present');
      assertEq(typeof seen.headers['x-homestead-timestamp'], 'string', 'X-Homestead-Timestamp present');
      assertEq(seen.headers['x-homestead-conversation-id'], 'c-sse-1', 'X-Homestead-Conversation-Id = c-sse-1');
      assertEq(seen.headers['content-type'], 'application/json', 'Content-Type = application/json');
      // Verify HMAC against the stored secret.
      const epRow = db.prepare('SELECT secret FROM agent_endpoints WHERE id = ?').get(ep.id);
      const ok = verifySignature(seen.headers['x-homestead-signature'],
        epRow.secret,
        seen.headers['x-homestead-timestamp'],
        seen.body);
      assert(ok, 'X-Homestead-Signature validates against stored secret');
      // Validate the signed body shape.
      let parsed;
      try { parsed = JSON.parse(seen.body); } catch (_) { parsed = null; }
      assert(parsed !== null, 'signed body is valid JSON');
      if (parsed) {
        assertEq(parsed.message, "what's on my plate?", 'body.message = input');
        assertEq(parsed.user.username, 'brandon', 'body.user.username = caller');
        assert(Array.isArray(parsed.user.groups), 'body.user.groups is an array');
        assertEq(parsed.context.conversation_id, 'c-sse-1', 'body.context.conversation_id matches');
        assert(parsed.snapshot && Array.isArray(parsed.snapshot.today_tasks),
               'body.snapshot.today_tasks is an array');
      }
    }

    // Bookkeeping: last_status_code = 200, last_error = null.
    const after = db.prepare(
      'SELECT last_status_code, last_error FROM agent_endpoints WHERE id = ?'
    ).get(ep.id);
    assertEq(after.last_status_code, 200, 'last_status_code = 200 after SSE success');
    assertEq(after.last_error, null, 'last_error stays null on success');

    teardown(server, tmpDir);
    await harness.close();
  } catch (err) {
    ng('Test 3 crashed', err.stack || err.message);
    if (harness) await harness.close();
  }

  // ---------- Test 4: JSON reply ----------
  console.log('\nTest 4: JSON reply (application/json)');
  let harness2;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    harness2 = await makeFakeHarness([{
      kind: 'json',
      body: {
        request_id: 'will-be-overwritten',
        text: 'Done — 3 tasks.',
        actions: [{ type: 'navigate', to: '/tasks' }],
        tokens_in: 10,
        tokens_out: 5,
      },
    }]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Phone automation',
      kind: 'drawer',
      url: harness2.url,
    });

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    }, {
      message: 'summary please',
      endpoint_id: ep.id,
      conversation_id: 'c-json-1',
    });
    assertEq(res.status, 200, 'JSON POST returns 200');
    assertEq(res.headers['content-type'].toLowerCase().includes('application/json'),
             true, 'JSON Content-Type is application/json');
    assertEq(res.body.text, 'Done — 3 tasks.', 'JSON text forwarded');
    assertEq(res.body.conversation_id, 'c-json-1', 'JSON conversation_id echoed');
    assertEq(typeof res.body.request_id, 'string', 'JSON request_id present');
    assertEq(res.body.tokens_in, 10, 'JSON tokens_in forwarded');
    assertEq(res.body.tokens_out, 5, 'JSON tokens_out forwarded');
    assertEq(res.body.actions && res.body.actions[0].to, '/tasks', 'JSON actions forwarded');

    teardown(server, tmpDir);
    await harness2.close();
  } catch (err) {
    ng('Test 4 crashed', err.stack || err.message);
    if (harness2) await harness2.close();
  }

  // ---------- Test 5: retry/backoff ----------
  console.log('\nTest 5: retry/backoff — 3x 500 then 200 succeeds');
  let harness3;
  try {
    // Slow the test by using shorter backoffs (the dispatcher's real
    // backoff is 1s/4s/16s/60s — too slow for tests). We monkey-patch
    // BACKOFF_MS via the module exports.
    const origBackoff = drawerDispatch.BACKOFF_MS.slice();
    drawerDispatch.__test__.BACKOFF_MS[0] = 10;
    drawerDispatch.__test__.BACKOFF_MS[1] = 10;
    drawerDispatch.__test__.BACKOFF_MS[2] = 10;

    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    harness3 = await makeFakeHarness([
      { status: 500, body: 'boom1' },
      { status: 500, body: 'boom2' },
      { status: 500, body: 'boom3' },
      { kind: 'sse', chunks: ['finally!'], done: { request_id: 'x', tokens_in: 0, tokens_out: 1, duration_ms: 1 } },
    ]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Flaky harness',
      kind: 'drawer',
      url: harness3.url,
    });

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {
      message: 'please work',
      endpoint_id: ep.id,
      conversation_id: 'c-retry-1',
    });
    assertEq(res.status, 200, 'returns 200 after retries succeed');
    const body = Buffer.concat(res.chunks).toString('utf8');
    assert(body.includes('finally!'), 'late-success chunk arrived');
    assertEq(harness3.seen.length, 4, 'fake harness received 4 attempts (3 fail + 1 success)');

    // Bookkeeping: last_status_code = 200 (final success overwrites).
    const after = db.prepare(
      'SELECT last_status_code, last_error FROM agent_endpoints WHERE id = ?'
    ).get(ep.id);
    assertEq(after.last_status_code, 200, 'last_status_code = 200 after final success');

    // Restore backoff.
    drawerDispatch.__test__.BACKOFF_MS[0] = origBackoff[0];
    drawerDispatch.__test__.BACKOFF_MS[1] = origBackoff[1];
    drawerDispatch.__test__.BACKOFF_MS[2] = origBackoff[2];

    teardown(server, tmpDir);
    await harness3.close();
  } catch (err) {
    ng('Test 5 crashed', err.stack || err.message);
    if (harness3) await harness3.close();
  }

  // ---------- Test 6: circuit breaker ----------
  console.log('\nTest 6: circuit breaker — 5 consecutive failures auto-disable');
  let harness4;
  try {
    const origBackoff = drawerDispatch.BACKOFF_MS.slice();
    drawerDispatch.__test__.BACKOFF_MS[0] = 5;
    drawerDispatch.__test__.BACKOFF_MS[1] = 5;
    drawerDispatch.__test__.BACKOFF_MS[2] = 5;
    drawerDispatch.__test__.BACKOFF_MS[3] = 5;

    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    // Script: 5x 500 (exhausts all retries + the streak counter).
    harness4 = await makeFakeHarness([
      { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
      { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
      { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
      { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
    ]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Dead endpoint',
      kind: 'drawer',
      url: harness4.url,
    });

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {
      message: 'hello?',
      endpoint_id: ep.id,
      conversation_id: 'c-cb-1',
    });
    assertEq(res.status, 503, 'circuit-broken returns 503');
    assertEq(res.body.error, 'circuit_broken', 'error = circuit_broken');
    assert(res.body.message.includes('auto-disabled'),
           'message mentions auto-disable');
    assertEq(harness4.seen.length, 5, '5 attempts (initial + 4 retries, last one is the breaker trip)');

    // Endpoint.enabled should be 0 now.
    const after = db.prepare('SELECT enabled FROM agent_endpoints WHERE id = ?').get(ep.id);
    assertEq(after.enabled, 0, 'endpoint.enabled flipped to 0 (auto-disable)');

    // Subsequent calls return 404 (endpoint not enabled).
    const res2 = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {
      message: 'still there?',
      endpoint_id: ep.id,
      conversation_id: 'c-cb-2',
    });
    assertEq(res2.status, 404, 'subsequent call returns 404 (endpoint disabled)');

    // Restore backoff.
    drawerDispatch.__test__.BACKOFF_MS[0] = origBackoff[0];
    drawerDispatch.__test__.BACKOFF_MS[1] = origBackoff[1];
    drawerDispatch.__test__.BACKOFF_MS[2] = origBackoff[2];
    drawerDispatch.__test__.BACKOFF_MS[3] = origBackoff[3];

    teardown(server, tmpDir);
    await harness4.close();
  } catch (err) {
    ng('Test 6 crashed', err.stack || err.message);
    if (harness4) await harness4.close();
  }

  // ---------- Test 7: cross-user endpoint refusal ----------
  console.log('\nTest 7: cross-user endpoint refusal (404, no leak)');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const brandonCookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: "Brandon's harness",
      kind: 'drawer',
      url: 'http://brandon-host/drawer',
    });
    const emilyCookie = await login(request, base, 'emily');

    const r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: emilyCookie },
    }, { message: 'hi', endpoint_id: ep.id });
    assertEq(r.status, 404, "Emily calling Brandon's endpoint returns 404 (no leak)");

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 7 crashed', err.stack || err.message);
  }

  // ---------- Test 8: events-kind + disabled endpoints refused ----------
  console.log('\nTest 8: events-kind + disabled endpoints refused (404)');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

    const eventsEp = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Events hook',
      kind: 'events',
      url: 'http://brandon-host/events',
    });
    let r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { message: 'hi', endpoint_id: eventsEp.id });
    assertEq(r.status, 404, 'events-kind endpoint refused by /api/drawer');

    const drawerEp = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Disabled drawer',
      kind: 'drawer',
      url: 'http://brandon-host/drawer',
    });
    agentEndpoints.update(db, drawerEp.id, { enabled: false }, { ownerUserId: brandon.id });
    r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { message: 'hi', endpoint_id: drawerEp.id });
    assertEq(r.status, 404, 'disabled drawer endpoint refused');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 8 crashed', err.stack || err.message);
  }

  // ---------- Test 9: endpoint offline (all retries exhausted, below threshold) ----------
  console.log('\nTest 9: endpoint offline (all retries exhausted, < threshold)');
  let harness9;
  try {
    const origBackoff = drawerDispatch.BACKOFF_MS.slice();
    drawerDispatch.__test__.BACKOFF_MS[0] = 5;
    drawerDispatch.__test__.BACKOFF_MS[1] = 5;
    drawerDispatch.__test__.BACKOFF_MS[2] = 5;
    drawerDispatch.__test__.BACKOFF_MS[3] = 5;

    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    // Just one attempt fails, then the streak resets on the next call.
    // Actually, the dispatcher increments the streak per dispatch call,
    // so we need to call /api/drawer exactly once and have all 5
    // attempts fail. The breaker trips at consecutiveFailures >= 5
    // AFTER the dispatch. With 5 failed attempts in one dispatch, the
    // streak map ends at 5 → breaker trips → circuit_broken.
    // To test the "endpoint_offline" path, we need fewer attempts. We
    // monkey-patch MAX_RETRIES via the test export.
    drawerDispatch.__test__.MAX_RETRIES = 1;
    harness9 = await makeFakeHarness([
      { status: 500 }, { status: 500 }, { status: 500 },
    ]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Mid-flaky harness',
      kind: 'drawer',
      url: harness9.url,
    });

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {
      message: 'try once',
      endpoint_id: ep.id,
      conversation_id: 'c-offline-1',
    });
    assertEq(res.status, 502, 'returns 502 endpoint_offline');
    assertEq(res.body.error, 'endpoint_offline', 'error = endpoint_offline');
    assertEq(typeof res.body.last_status, 'number', 'last_status is numeric');
    assertEq(harness9.seen.length, 2, '2 attempts (initial + 1 retry with MAX_RETRIES=1)');
    // Endpoint should still be enabled (we only had 1 dispatch call, streak=1).
    const after = db.prepare('SELECT enabled FROM agent_endpoints WHERE id = ?').get(ep.id);
    assertEq(after.enabled, 1, 'endpoint stays enabled after a single offline attempt');

    // Restore.
    drawerDispatch.__test__.MAX_RETRIES = 4;
    drawerDispatch.__test__.BACKOFF_MS[0] = origBackoff[0];
    drawerDispatch.__test__.BACKOFF_MS[1] = origBackoff[1];
    drawerDispatch.__test__.BACKOFF_MS[2] = origBackoff[2];
    drawerDispatch.__test__.BACKOFF_MS[3] = origBackoff[3];

    teardown(server, tmpDir);
    await harness9.close();
  } catch (err) {
    ng('Test 9 crashed', err.stack || err.message);
    if (harness9) await harness9.close();
  }

  // ---------- Test 10: snapshot is included in signed body ----------
  console.log('\nTest 10: signed body includes the morning-brief snapshot');
  let harness10;
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    harness10 = await makeFakeHarness([{
      kind: 'json',
      body: { request_id: 'x', text: 'ok', tokens_in: 1, tokens_out: 1 },
    }]);
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Snapshot-check',
      kind: 'drawer',
      url: harness10.url,
    });

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    }, {
      message: 'morning brief',
      endpoint_id: ep.id,
      conversation_id: 'c-snap-1',
    });
    assertEq(res.status, 200, 'returns 200');

    assertEq(harness10.seen.length, 1, 'fake harness received 1 POST');
    const seenBody = JSON.parse(harness10.seen[0].body);
    assertEq(seenBody.snapshot.today_tasks.length >= 1, true,
             'snapshot.today_tasks includes the seeded "Take out trash" task');
    assertEq(seenBody.snapshot.today_events.length >= 1, true,
             'snapshot.today_events includes the seeded "Movie night" event');
    assertEq(Array.isArray(seenBody.snapshot.overdue_tasks), true,
             'snapshot.overdue_tasks is an array');
    assertEq(typeof seenBody.snapshot.active_lists, 'object',
             'snapshot.active_lists is an object');
    assertEq(Array.isArray(seenBody.snapshot.recent_activity), true,
             'snapshot.recent_activity is an array');

    teardown(server, tmpDir);
    await harness10.close();
  } catch (err) {
    ng('Test 10 crashed', err.stack || err.message);
    if (harness10) await harness10.close();
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
