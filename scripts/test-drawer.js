#!/usr/bin/env node
// PHA-1617.5 acceptance tests for the meta-agent chat drawer stub at
// /api/drawer (frontend-only shell — design doc §6.3).
//
// The frontend composer in public/index.html POSTs {message, endpoint_id,
// conversation_id} here and parses either:
//   * text/event-stream with `event: chunk` / `event: done` (default), or
//   * application/json with {request_id, text, ...} (when Accept: application/json).
//
// What this test covers:
//   1. SSE-shaped reply for an enabled drawer endpoint. `done.request_id`
//      echoes the conversation_id; bookkeeping (last_used_at,
//      last_status_code) is recorded.
//   2. JSON reply when the caller sends Accept: application/json.
//   3. 401 on unauthenticated POST.
//   4. 400 on malformed input (missing message, missing/bad endpoint_id).
//   5. Cross-user endpoint refusal — caller can't operate on someone
//      else's endpoint (404, no leak).
//   6. Events-kind + disabled endpoints refused (404).
//   7. public/index.html ships the drawer markup + JS wiring for the
//      SSE/JSON consumer and the /api/drawer fetch.
//   8. SSE block parser contract — events/data/comment lines parse to the
//      shape the frontend consumer expects.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentEndpoints = require('../lib/agent-endpoints');

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

function freshStack() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-drawer-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  agentEndpoints.migrate(db);
  return { db, tmpDir };
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const request = (opts, body) => new Promise((resolve, reject) => {
        const req = http.request(opts, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(data); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data, chunks });
          });
        });
        req.on('error', reject);
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

function bootFreshStack() {
  const { db, tmpDir } = freshStack();
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const server = http.createServer(app);
  return { db, tmpDir, server };
}

function teardown(server, tmpDir) {
  try { server.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

async function main() {
  // ---------- Test 1: SSE reply ----------
  console.log('Test 1: SSE reply for an enabled drawer endpoint');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Laptop OpenClaw',
      kind: 'drawer',
      url: 'http://phattvip.lan:18789/webhook/homestead-drawer',
    });
    const before = db.prepare(
      'SELECT last_used_at, last_status_code FROM agent_endpoints WHERE id = ?'
    ).get(ep.id);
    assertEq(before.last_used_at, null, 'pre-call last_used_at is null');
    assertEq(before.last_status_code, null, 'pre-call last_status_code is null');

    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, {
      message: "what's on my plate today?",
      endpoint_id: ep.id,
      conversation_id: 'c-test-1',
    });
    assertEq(res.status, 200, 'POST /api/drawer returns 200');
    assertEq(res.headers['content-type'].toLowerCase().includes('text/event-stream'),
             true, 'SSE Content-Type is text/event-stream');
    assertEq(res.headers['cache-control'], 'no-cache, no-transform', 'no-cache header set');

    const body = Buffer.concat(res.chunks).toString('utf8');
    assert(body.includes('event: chunk'), 'SSE body has `event: chunk`');
    assert(body.includes('event: done'), 'SSE body has terminal `event: done`');
    assert(body.includes('Stub reply'), 'first chunk includes the stub prefix');
    assert(body.includes('PHA-1617.5'), 'chunk references the PHA-1617.5 scope');
    assert(body.includes('PHA-1617.6'), 'chunk points forward to PHA-1617.6');
    const doneMatch = body.match(/event: done\ndata: (\{.*?\})\n\n/);
    assert(!!doneMatch, '`done` event present and parseable');
    if (doneMatch) {
      const doneData = JSON.parse(doneMatch[1]);
      assertEq(doneData.request_id, 'c-test-1', 'done.request_id echoes conversation_id');
      assertEq(typeof doneData.tokens_in, 'number', 'done.tokens_in is numeric');
      assertEq(typeof doneData.duration_ms, 'number', 'done.duration_ms is numeric');
    }

    const after = db.prepare(
      'SELECT last_used_at, last_status_code, last_error FROM agent_endpoints WHERE id = ?'
    ).get(ep.id);
    assert(!!after.last_used_at, 'last_used_at populated after SSE call');
    assertEq(after.last_status_code, 200, 'last_status_code = 200 on SSE success');
    assertEq(after.last_error, null, 'last_error stays null on SSE success');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 1 crashed', err.stack || err.message);
  }

  // ---------- Test 2: JSON reply ----------
  console.log('\nTest 2: JSON reply when Accept: application/json');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'Phone automation',
      kind: 'drawer',
      url: 'http://phone.local:9000/hook',
    });
    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    }, {
      message: 'summarise my week',
      endpoint_id: ep.id,
      conversation_id: 'c-test-2',
    });
    assertEq(res.status, 200, 'JSON POST returns 200');
    assertEq(res.headers['content-type'].toLowerCase().includes('application/json'),
             true, 'JSON Content-Type is application/json');
    assertEq(res.body.request_id, 'c-test-2', 'JSON request_id echoes conversation_id');
    assert(res.body.text.includes('Phone automation'), 'JSON text mentions the harness label');
    assert(res.body.text.includes('PHA-1617.5'), 'JSON text identifies the stub scope');
    assertEq(typeof res.body.tokens_in, 'number', 'JSON tokens_in is numeric');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 2 crashed', err.stack || err.message);
  }

  // ---------- Test 3: 401 on unauthenticated ----------
  console.log('\nTest 3: unauthenticated POST is 401');
  try {
    const { tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const res = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { message: 'hello', endpoint_id: 1, conversation_id: 'c-test-3' });
    assertEq(res.status, 401, 'unauthenticated POST returns 401');
    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 3 crashed', err.stack || err.message);
  }

  // ---------- Test 4: malformed inputs ----------
  console.log('\nTest 4: 400/404 on malformed input');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'X', kind: 'drawer', url: 'http://x.example/x',
    });

    let r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { endpoint_id: ep.id });
    assertEq(r.status, 400, 'missing message returns 400');

    r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { message: '   ', endpoint_id: ep.id });
    assertEq(r.status, 400, 'whitespace-only message returns 400');

    r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { message: 'hi' });
    assertEq(r.status, 400, 'missing endpoint_id returns 400');

    r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { message: 'hi', endpoint_id: 'one' });
    assertEq(r.status, 400, 'non-integer endpoint_id returns 400');

    r = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { message: 'hi', endpoint_id: 99999 });
    assertEq(r.status, 404, 'unknown endpoint_id returns 404');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 4 crashed', err.stack || err.message);
  }

  // ---------- Test 5: cross-user endpoint refusal ----------
  console.log('\nTest 5: cross-user endpoint refusal');
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

    const ok2 = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
    }, { message: 'hi', endpoint_id: ep.id });
    assertEq(ok2.status, 200, 'Brandon can still call his own endpoint');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 5 crashed', err.stack || err.message);
  }

  // ---------- Test 6: events kind + disabled endpoints ----------
  console.log('\nTest 6: events-kind + disabled endpoints are refused');
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
      harnessLabel: 'Soon-disabled',
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
    ng('Test 6 crashed', err.stack || err.message);
  }

  // ---------- Test 7: HTML smoke ----------
  console.log('\nTest 7: public/index.html ships the drawer markup + JS wiring');
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    // Markup
    assert(html.includes('id="drawer"'), 'drawer container present');
    assert(html.includes('id="drawerFab"'), 'drawer FAB trigger present');
    assert(html.includes('id="drawerForm"'), 'composer form present');
    assert(html.includes('id="drawerInput"'), 'composer textarea present');
    assert(html.includes('id="drawerSend"'), 'send button present');
    assert(html.includes('id="drawerMsgs"'), 'messages area present');
    assert(html.includes('id="drawerHarness"'), 'harness selector slot present');

    // Styling
    assert(html.includes('#drawer{'), 'drawer CSS rules present');
    assert(html.includes('.drawer-msg.user{'), 'user bubble style present');
    assert(html.includes('.drawer-msg.agent{'), 'agent bubble style present');
    assert(html.includes('@keyframes typeBounce'), 'typing-dots keyframes present');

    // JS wiring
    assert(html.includes("'/api/drawer'"), 'POST /api/drawer in client code');
    assert(html.includes('loadDrawerEndpoints'), 'endpoint loader wired');
    assert(html.includes('consumeSseStream'), 'SSE consumer wired');
    assert(html.includes('parseSseBlock'), 'SSE block parser wired');
    assert(html.includes('event: chunk'), 'frontend references `event: chunk`');
    assert(html.includes("fetch('/api/agent-endpoints'"), 'endpoint list fetched from agent_endpoints API');
    assert(html.includes('text/event-stream'), 'frontend recognizes text/event-stream Content-Type');
    assert(html.includes('application/json'), 'frontend recognizes application/json Content-Type');
    assert(html.includes('openDrawer'), 'openDrawer function wired to FAB');

    // Stub/frontend contract: the stub emits `event: chunk` then `event: done`,
    // and the frontend handles both to stream chunks and close cleanly.
    assert(html.includes("ev.event === 'chunk'"), 'frontend handles `event: chunk`');
    assert(html.includes("ev.event === 'done'"), 'frontend handles `event: done` (stream close)');
  } catch (err) {
    ng('Test 7 crashed', err.stack || err.message);
  }

  // ---------- Test 8: SSE parser contract ----------
  console.log('\nTest 8: SSE block parser produces the right shape');
  try {
    const sample1 = 'event: chunk\ndata: {"text":"hello"}\n\nevent: chunk\ndata: {"text":" world"}\n\nevent: done\ndata: {"request_id":"c-1"}\n\n';
    const blocks = sample1.split('\n\n').filter(Boolean);
    assertEq(blocks.length, 3, 'sample SSE splits into 3 blocks');
    const ev1 = parseSseForTest(blocks[0]);
    assertEq(ev1.event, 'chunk', 'block 1 event = chunk');
    assertEq(ev1.data, { text: 'hello' }, 'block 1 data = {text: hello}');
    const ev2 = parseSseForTest(blocks[1]);
    assertEq(ev2.event, 'chunk', 'block 2 event = chunk');
    assertEq(ev2.data.text, ' world', 'block 2 data.text = " world"');
    const ev3 = parseSseForTest(blocks[2]);
    assertEq(ev3.event, 'done', 'block 3 event = done');
    assertEq(ev3.data.request_id, 'c-1', 'block 3 data.request_id = c-1');

    // Multi-line data (joined with \n per SSE spec).
    const multi = 'event: message\ndata: line1\ndata: line2\n\n';
    const ev4 = parseSseForTest(multi);
    assertEq(ev4.data, 'line1\nline2', 'multi-line data is joined with \\n');

    // Comment lines are skipped.
    const commented = ': keepalive\nevent: chunk\ndata: {"text":"x"}\n\n';
    const ev5 = parseSseForTest(commented);
    assertEq(ev5.event, 'chunk', 'comment lines are skipped');
  } catch (err) {
    ng('Test 8 crashed', err.stack || err.message);
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

function parseSseForTest(block) {
  let event = 'message';
  const dataLines = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? '' : line.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') dataLines.push(val);
  }
  const joined = dataLines.join('\n');
  let parsed;
  try { parsed = JSON.parse(joined); } catch (_) { parsed = joined; }
  return { event, data: parsed };
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
