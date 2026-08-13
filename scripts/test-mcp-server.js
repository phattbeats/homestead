#!/usr/bin/env node
// PHA-1617.8 acceptance tests for lib/mcp-server.js.
//
// Drives the MCP server end-to-end against a live server.js instance on
// an ephemeral port. Coverage:
//   * JSON-RPC 2.0 envelope + protocolVersion in initialize
//   * tools/list shape (names, inputSchema, descriptions)
//   * tools/call round-trip: create_task → list_tasks → toggle_task → update_task
//   * resources/list shape (uri, name, mimeType)
//   * resources/read round-trip: homestead://me + homestead://calendar/merged.ics
//   * resources/read for PHA-1622-deferred homestead://activity/recent
//   * Bearer PAT auth (no session cookie) — exercises the loopback's
//     Authorization header forwarding
//   * Validation: missing required field, invalid enum, unknown method,
//     unknown tool, unknown resource
//   * Notification handling (no id → no response, 202 Accepted on
//     all-notification batch)
//   * Method not allowed for GET /api/mcp (405)
//   * Unauthenticated request returns 401 (auth middleware runs first)
//
// No mocking. Uses the same supertest-free http.request pattern as the
// other test-*.js scripts.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { if (fail === 0) console.log(); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---- Per-test server lifecycle -------------------------------------------

function startServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-mcp-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  // Clean any cached server module so the process.env takes effect.
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const server = http.createServer(app);
  // Register the bound server with the MCP loopback so internal
  // /api/mcp tool calls can reach the same instance.
  app.__setLoopbackServer(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, tmpDir, app });
    });
  });
}

function stopServer({ server, tmpDir }) {
  return new Promise(resolve => {
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

function rawHttp({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const hdrs = Object.assign({ 'Accept': 'application/json' }, headers || {});
    if (data) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: hdrs }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, headers: res.headers, raw: chunks });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function mcpJsonRpc({ port, id, method, params, extraHeaders = {} }) {
  const msg = { jsonrpc: '2.0' };
  if (id !== undefined) msg.id = id;
  msg.method = method;
  if (params !== undefined) msg.params = params;
  return rawHttp({
    port, path: '/api/mcp', method: 'POST',
    headers: Object.assign({ 'Accept': 'application/json, text/event-stream' }, extraHeaders),
    body: msg,
  });
}

// ---- begin tests ---------------------------------------------------------

console.log('PHA-1617.8 MCP server tests\n');

async function run() {
  const ctx = await startServer();
  const { port } = ctx;

  // Log in once and reuse the cookie for every test that needs auth.
  const login = await rawHttp({
    port, path: '/api/login', method: 'POST',
    body: { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' },
  });
  assertEq(login.status, 200, 'login as brandon succeeds');
  const cookie = (login.headers['set-cookie'] || [])[0];
  assert(!!cookie, 'session cookie set');
  const authHeaders = { Cookie: cookie };

  // ---- Test 1: initialize handshake -------------------------------------
  {
    console.log('Test 1: initialize handshake');
    const res = await mcpJsonRpc({ port, id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    }, extraHeaders: authHeaders });
    assertEq(res.status, 200, 'HTTP 200');
    assertEq(res.body.jsonrpc, '2.0', 'envelope is jsonrpc 2.0');
    assertEq(res.body.id, 1, 'response id matches request id');
    assertEq(res.body.result.protocolVersion, '2025-06-18', 'protocolVersion matches');
    assertEq(res.body.result.serverInfo.name, 'homestead', 'serverInfo.name = homestead');
    assert(!!res.body.result.serverInfo.version, 'serverInfo.version present');
    assert(!!res.body.result.capabilities.tools, 'capabilities.tools present');
    assert(!!res.body.result.capabilities.resources, 'capabilities.resources present');
  }

  // ---- Test 2: tools/list shape -----------------------------------------
  {
    console.log('\nTest 2: tools/list shape');
    const res = await mcpJsonRpc({ port, id: 2, method: 'tools/list', extraHeaders: authHeaders });
    assertEq(res.status, 200, 'HTTP 200');
    const tools = res.body.result.tools;
    const names = tools.map(t => t.name).sort();
    assertEq(names, [
      'homestead_create_event',
      'homestead_create_task',
      'homestead_get_me',
      'homestead_list_events',
      'homestead_list_services',
      'homestead_list_tasks',
      'homestead_toggle_task',
      'homestead_update_task',
    ], 'all 8 tools present in expected order');
    const createTask = tools.find(t => t.name === 'homestead_create_task');
    assertEq(createTask.inputSchema.required, ['title'], 'create_task requires title');
    assertEq(createTask.inputSchema.properties.assignee.type, 'string', 'create_task assignee is string');
    assertEq(createTask.inputSchema.properties.recur.enum, ['daily', 'weekly', 'monthly'], 'create_task recur enum');
  }

  // ---- Test 3: resources/list shape -------------------------------------
  {
    console.log('\nTest 3: resources/list shape');
    const res = await mcpJsonRpc({ port, id: 3, method: 'resources/list', extraHeaders: authHeaders });
    assertEq(res.status, 200, 'HTTP 200');
    const uris = res.body.result.resources.map(r => r.uri).sort();
    assertEq(uris, [
      'homestead://activity/recent',
      'homestead://calendar/merged.ics',
      'homestead://me',
    ], 'all 3 resources present');
    const ics = res.body.result.resources.find(r => r.uri === 'homestead://calendar/merged.ics');
    assertEq(ics.mimeType, 'text/calendar', 'merged.ics mimeType = text/calendar');
  }

  // ---- Test 4: notifications/initialized → 202 with no body -------------
  {
    console.log('\nTest 4: notifications/initialized returns 202 with empty body');
    const res = await mcpJsonRpc({ port, method: 'notifications/initialized', extraHeaders: authHeaders });
    assertEq(res.status, 202, 'HTTP 202');
    assertEq(res.raw, '', 'no response body for notifications');
  }

  // ---- Test 5: unknown method -------------------------------------------
  {
    console.log('\nTest 5: unknown method returns METHOD_NOT_FOUND');
    const res = await mcpJsonRpc({ port, id: 99, method: 'tools/wat', params: {}, extraHeaders: authHeaders });
    assertEq(res.status, 200, 'still HTTP 200 (JSON-RPC convention)');
    assertEq(res.body.error.code, -32601, 'error code = -32601 (METHOD_NOT_FOUND)');
    assert(res.body.error.message.includes('unknown method'), 'message names the method');
  }

  // ---- Test 6: homestead_get_me + create/list/toggle/update round-trip -
  {
    console.log('\nTest 6: homestead_get_me + create/list/toggle/update round-trip');
    const meRes = await mcpJsonRpc({
      port, id: 10, method: 'tools/call',
      params: { name: 'homestead_get_me', arguments: {} },
      extraHeaders: authHeaders,
    });
    assertEq(meRes.status, 200, 'get_me HTTP 200');
    assertEq(meRes.body.jsonrpc, '2.0', 'jsonrpc 2.0 envelope');
    const meText = meRes.body.result.content[0].text;
    const me = JSON.parse(meText);
    assertEq(me.user.username, 'brandon', 'get_me returns brandon');

    const createRes = await mcpJsonRpc({
      port, id: 11, method: 'tools/call',
      params: { name: 'homestead_create_task', arguments: {
        title: 'MCP test chore', assignee: 'brandon', due_date: '2026-08-20',
      }},
      extraHeaders: authHeaders,
    });
    assertEq(createRes.status, 200, 'create_task HTTP 200');
    const created = JSON.parse(createRes.body.result.content[0].text);
    assertEq(created.title, 'MCP test chore', 'created task has the right title');
    assertEq(created.assignee, 'brandon', 'created task assigned to brandon');
    assertEq(created.done, 0, 'new task starts not-done');
    const taskId = created.id;

    const listRes = await mcpJsonRpc({
      port, id: 12, method: 'tools/call',
      params: { name: 'homestead_list_tasks', arguments: { assignee: 'brandon', include_done: false }},
      extraHeaders: authHeaders,
    });
    const listed = JSON.parse(listRes.body.result.content[0].text);
    assert(listed.some(t => t.id === taskId), 'list_tasks includes the new task');
    assert(listed.every(t => !t.done), 'include_done=false filters out done tasks');

    const toggleRes = await mcpJsonRpc({
      port, id: 13, method: 'tools/call',
      params: { name: 'homestead_toggle_task', arguments: { id: taskId }},
      extraHeaders: authHeaders,
    });
    const toggled = JSON.parse(toggleRes.body.result.content[0].text);
    assertEq(toggled.done, 1, 'toggle flips done to 1');

    const updateRes = await mcpJsonRpc({
      port, id: 14, method: 'tools/call',
      params: { name: 'homestead_update_task', arguments: { id: taskId, notes: 'updated by MCP' }},
      extraHeaders: authHeaders,
    });
    const updated = JSON.parse(updateRes.body.result.content[0].text);
    assertEq(updated.notes, 'updated by MCP', 'update_task notes patch landed');
  }

  // ---- Test 7: homestead_list_events + create_event --------------------
  {
    console.log('\nTest 7: homestead_create_event + homestead_list_events');
    const createRes = await mcpJsonRpc({
      port, id: 20, method: 'tools/call',
      params: { name: 'homestead_create_event', arguments: {
        title: 'MCP test event', date: '2026-08-25', time: '19:00', notes: 'dinner',
      }},
      extraHeaders: authHeaders,
    });
    assertEq(createRes.status, 200, 'create_event HTTP 200');
    const created = JSON.parse(createRes.body.result.content[0].text);
    assertEq(created.title, 'MCP test event', 'event created');
    assertEq(created.time, '19:00', 'event time round-trips');

    const listRes = await mcpJsonRpc({
      port, id: 21, method: 'tools/call',
      params: { name: 'homestead_list_events', arguments: { from: '2026-08-25', to: '2026-08-25' }},
      extraHeaders: authHeaders,
    });
    const events = JSON.parse(listRes.body.result.content[0].text);
    assert(events.some(e => e.title === 'MCP test event'), 'list_events includes the new event');
  }

  // ---- Test 8: homestead_list_services visibility filter ----------------
  {
    console.log('\nTest 8: homestead_list_services with visibility filter');
    const res = await mcpJsonRpc({
      port, id: 30, method: 'tools/call',
      params: { name: 'homestead_list_services', arguments: { visibility: 'all' }},
      extraHeaders: authHeaders,
    });
    assertEq(res.status, 200, 'list_services HTTP 200');
    const services = JSON.parse(res.body.result.content[0].text);
    assert(Array.isArray(services), 'returns an array');
  }

  // ---- Test 9: resource read round-trip --------------------------------
  {
    console.log('\nTest 9: resources/read round-trip — homestead://me and homestead://calendar/merged.ics');
    const meRes = await mcpJsonRpc({
      port, id: 40, method: 'resources/read',
      params: { uri: 'homestead://me' },
      extraHeaders: authHeaders,
    });
    assertEq(meRes.status, 200, 'resources/read HTTP 200');
    const meContent = meRes.body.result.contents[0];
    assertEq(meContent.uri, 'homestead://me', 'content uri matches');
    assertEq(meContent.mimeType, 'application/json', 'mimeType application/json');
    const me = JSON.parse(meContent.text);
    assertEq(me.user.username, 'brandon', 'homestead://me returns brandon');

    const icsRes = await mcpJsonRpc({
      port, id: 41, method: 'resources/read',
      params: { uri: 'homestead://calendar/merged.ics' },
      extraHeaders: authHeaders,
    });
    assertEq(icsRes.status, 200, 'merged.ics HTTP 200');
    const icsContent = icsRes.body.result.contents[0];
    assertEq(icsContent.mimeType, 'text/calendar', 'mimeType text/calendar');
    assert(icsContent.text.includes('BEGIN:VCALENDAR'), 'output starts with BEGIN:VCALENDAR');
    assert(icsContent.text.includes('END:VCALENDAR'), 'output ends with END:VCALENDAR');
    assert(icsContent.text.includes('PRODID:'), 'output has PRODID');
    assert(icsContent.text.includes('VERSION:2.0'), 'output has VERSION:2.0');
    // The event from test 7 should be in the default +90 day window.
    assert(icsContent.text.includes('MCP test event'), 'merged.ics includes the test event');
  }

  // ---- Test 10: homestead://activity/recent (deferred / PHA-1622) -----
  {
    console.log('\nTest 10: homestead://activity/recent returns structured placeholder');
    const res = await mcpJsonRpc({
      port, id: 50, method: 'resources/read',
      params: { uri: 'homestead://activity/recent' },
      extraHeaders: authHeaders,
    });
    assertEq(res.status, 200, 'activity/recent HTTP 200');
    const payload = JSON.parse(res.body.result.contents[0].text);
    assertEq(payload.events, [], 'events is empty');
    assert(payload.note.includes('PHA-1622'), 'note names the dependency');
  }

  // ---- Test 11: PAT bearer auth (no session cookie) --------------------
  {
    console.log('\nTest 11: Bearer PAT auth end-to-end (no session cookie)');
    const issueRes = await rawHttp({
      port, path: '/api/agent-tokens', method: 'POST',
      headers: { Cookie: cookie },
      body: { label: 'mcp-test' },
    });
    const plaintext = issueRes.body && issueRes.body.token_plaintext;
    assert(!!plaintext, 'PAT issued');

    const meRes = await mcpJsonRpc({
      port, id: 60, method: 'tools/call',
      params: { name: 'homestead_get_me', arguments: {} },
      extraHeaders: { Authorization: `Bearer ${plaintext}` },
    });
    assertEq(meRes.status, 200, 'get_me with PAT HTTP 200');
    const me = JSON.parse(meRes.body.result.content[0].text);
    assertEq(me.user.username, 'brandon', 'get_me via PAT returns brandon');

    const icsRes = await mcpJsonRpc({
      port, id: 61, method: 'resources/read',
      params: { uri: 'homestead://me' },
      extraHeaders: { Authorization: `Bearer ${plaintext}` },
    });
    assertEq(icsRes.status, 200, 'resources/read with PAT HTTP 200');
    const meFromIcs = JSON.parse(icsRes.body.result.contents[0].text);
    assertEq(meFromIcs.user.username, 'brandon', 'resource read via PAT returns brandon');
  }

  // ---- Test 12: validation errors ---------------------------------------
  {
    console.log('\nTest 12: validation errors');
    const missing = await mcpJsonRpc({
      port, id: 70, method: 'tools/call',
      params: { name: 'homestead_create_task', arguments: { notes: 'no title' }},
      extraHeaders: authHeaders,
    });
    assertEq(missing.body.error.code, -32602, 'missing required field → INVALID_PARAMS');
    assert(missing.body.error.message.includes('title'), 'error names the missing field');

    const badEnum = await mcpJsonRpc({
      port, id: 71, method: 'tools/call',
      params: { name: 'homestead_create_task', arguments: { title: 'x', recur: 'yearly' }},
      extraHeaders: authHeaders,
    });
    assertEq(badEnum.body.error.code, -32602, 'bad enum → INVALID_PARAMS');

    const unknownTool = await mcpJsonRpc({
      port, id: 72, method: 'tools/call',
      params: { name: 'homestead_wat', arguments: {} },
      extraHeaders: authHeaders,
    });
    assertEq(unknownTool.body.error.code, -32601, 'unknown tool → METHOD_NOT_FOUND');

    const unknownRes = await mcpJsonRpc({
      port, id: 73, method: 'resources/read',
      params: { uri: 'homestead://nope' },
      extraHeaders: authHeaders,
    });
    assertEq(unknownRes.body.error.code, -32002, 'unknown resource → RESOURCE_NOT_FOUND');
  }

  // ---- Test 13: tool execution error surfaces as isError:true ----------
  {
    console.log('\nTest 13: tool execution failure surfaces as isError');
    const res = await mcpJsonRpc({
      port, id: 80, method: 'tools/call',
      params: { name: 'homestead_toggle_task', arguments: { id: 999999 }},
      extraHeaders: authHeaders,
    });
    assertEq(res.status, 200, 'HTTP 200 even on tool error');
    assertEq(res.body.result.isError, true, 'result.isError = true');
    assert(res.body.result.content[0].text.includes('not found'), 'error message mentions not found');
  }

  // ---- Test 14: GET /api/mcp is 405 ------------------------------------
  {
    console.log('\nTest 14: GET /api/mcp is 405 with Allow: POST');
    const res = await rawHttp({ port, path: '/api/mcp', method: 'GET', headers: authHeaders });
    assertEq(res.status, 405, 'GET → 405');
    assertEq(res.headers.allow, 'POST', 'Allow header is POST');
  }

  // ---- Test 15: malformed JSON-RPC envelope ----------------------------
  {
    console.log('\nTest 15: malformed JSON-RPC envelope');
    const res = await rawHttp({
      port, path: '/api/mcp', method: 'POST',
      headers: authHeaders,
      body: { junk: true },
    });
    assertEq(res.body.error.code, -32600, 'non-jsonrpc envelope → INVALID_REQUEST');
  }

  // ---- Test 16: batch requests (one notification + one call) -----------
  {
    console.log('\nTest 16: batch requests');
    const res = await rawHttp({
      port, path: '/api/mcp', method: 'POST',
      headers: authHeaders,
      body: [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'homestead_get_me', arguments: {} }},
      ],
    });
    assertEq(res.status, 200, 'batch HTTP 200');
    assert(Array.isArray(res.body), 'batch returns array');
    assertEq(res.body.length, 1, 'only the response-with-id came back');
    assertEq(res.body[0].id, 90, 'response id matches');
  }

  // ---- Test 17: unauthenticated request returns 401 --------------------
  {
    console.log('\nTest 17: unauthenticated POST /api/mcp is 401');
    const res = await rawHttp({
      port, path: '/api/mcp', method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    assertEq(res.status, 401, 'no auth → 401');
  }

  await stopServer(ctx);
  finish();
}

run().catch(err => {
  console.error('test crashed:', err.stack || err.message);
  ng('run() crashed', err.stack || err.message);
  process.exit(1);
});
