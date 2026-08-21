#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 PHATT TECH LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHA-2208 (PHA-2200.7) acceptance tests for the agent-module gate.
//
// The `agent` module is a deliberate toggle (PHA-2200 design §3):
//   * When ENABLED, the meta-agent drawer (`/api/drawer`) and the
//     Gazette brief endpoint (`/api/gazette/brief`) are reachable
//     AND the SPA drawer FAB is visible.
//   * When DISABLED, both endpoints return 403 AND the SPA FAB
//     carries the `off` class (opacity:0 + pointer-events:none +
//     scale(.7) — invisible AND non-clickable).
//
// What this test covers:
//   1. `lib/user-model.isAgentEnabled` reflects the underlying
//      enabled_set and survives enable/disable round-trips.
//   2. POST /api/drawer: 403 when agent disabled, 200 when enabled.
//      The 200 path is the existing stub (PHA-1617.5) — we only
//      verify the gate doesn't reject enabled callers.
//   3. GET /api/gazette/brief: 403 when agent disabled, 200 when
//      enabled. This endpoint is new in PHA-2208; the 200 body is
//      a placeholder noting the real wire shape will land with
//      PHA-1617's brief-assembly contract.
//   4. /api/me/layout.agentDrawer flips in lockstep with the
//      enabling (already covered by test-modular-layout, but
//      co-located here so the gate test is self-contained).
//   5. public/index.html wires the FAB: source contains the
//      `applyAgentFab` helper, calls it from `boot()`, and exports
//      it on `window` so the add-a-room sheet (PHA-2200.4) can
//      invoke it after a live enable/disable.
//   6. The SPA's wiring is consistent with the CSS: the `off`
//      class is the sole mechanism (no `display:none` on the
//      element itself, no removal from the DOM).
//
// Out of scope (handled by sibling PHAs):
//   * Module enable/disable API surface — PHA-2204 (test-modules-api).
//   * Registry — PHA-2203 (test-modules, test-shared-registry).
//   * SPA add-a-room sheet — PHA-2200.4 (not yet implemented).
//   * Real Gazette brief assembly — PHA-1617 (in_review).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const vm = require('vm');
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-agent-gate-'));
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
  // ---------- Test 1: isAgentEnabled unit ----------
  console.log('Test 1: lib/user-model.isAgentEnabled reflects the enabled set');
  try {
    const { db } = freshStack();
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    assert(brandon, 'precondition: brandon row exists (seeded by migrate)');

    // PHA-2202 migration seeds ALL six modules for existing users so
    // the API surface is consistent on upgrade. For a brand-new user
    // (`provisionOrClaim`), only `wall` is enabled (registry
    // DEFAULT_ENABLED). To simulate the "wall-only" precondition the
    // spec calls out, disable everything except wall here.
    // IMPORTANT: disable dependents first — `chores` requires `lists`,
    // so lists must be disabled AFTER chores, not before. The
    // without-cascade disableModule throws on unmet dependents.
    for (const k of ['chores', 'lists', 'calendar', 'apps', 'agent']) {
      userModel.disableModule(db, brandon.id, k);
    }
    assertEq(userModel.getEnabledModules(db, brandon.id).map(e => e.key),
      ['wall'], 'precondition: only wall is enabled');
    assertEq(userModel.isAgentEnabled(db, brandon.id), false,
      'wall-only user: isAgentEnabled === false');

    // Enable agent.
    userModel.enableModule(db, brandon.id, 'agent');
    assertEq(userModel.isAgentEnabled(db, brandon.id), true,
      'after enableModule(agent): isAgentEnabled === true');

    // Disable agent.
    userModel.disableModule(db, brandon.id, 'agent');
    assertEq(userModel.isAgentEnabled(db, brandon.id), false,
      'after disableModule(agent): isAgentEnabled === false');

    // Idempotent re-disable.
    userModel.disableModule(db, brandon.id, 'agent');
    assertEq(userModel.isAgentEnabled(db, brandon.id), false,
      'idempotent disable: still false');

    // Re-enable then enable of an unrelated module doesn't disturb.
    userModel.enableModule(db, brandon.id, 'agent');
    userModel.enableModule(db, brandon.id, 'lists');
    assertEq(userModel.isAgentEnabled(db, brandon.id), true,
      'after re-enable + unrelated enable: still true');

    teardown(null, db.name && path.dirname(db.name));
  } catch (err) {
    ng('Test 1 crashed', err.stack || err.message);
  }

  // ---------- Test 2: POST /api/drawer gate ----------
  console.log('\nTest 2: POST /api/drawer is gated by the agent module');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    // Reduce to wall-only so the "agent disabled" precondition is met.
    // chores first (it depends on lists), then the rest.
    for (const k of ['chores', 'lists', 'calendar', 'apps', 'agent']) {
      userModel.disableModule(db, brandon.id, k);
    }
    const ep = agentEndpoints.create(db, brandon.id, {
      harnessLabel: 'OpenClaw on phattvip',
      kind: 'drawer',
      url: 'http://phattvip.lan:18789/webhook/homestead-drawer',
    });

    // 2a: agent disabled (fresh user) → 403.
    const r1 = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    }, { message: 'good morning', endpoint_id: ep.id, conversation_id: 'c-gate-1' });
    assertEq(r1.status, 403, 'agent disabled → POST /api/drawer returns 403');
    assertEq(r1.body.error, 'agent_disabled', '403 body.error === "agent_disabled"');

    // 2b: Enable agent → 200 (existing stub path).
    userModel.enableModule(db, brandon.id, 'agent');
    const r2 = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    }, { message: 'good morning', endpoint_id: ep.id, conversation_id: 'c-gate-2' });
    assertEq(r2.status, 200, 'agent enabled → POST /api/drawer returns 200');
    assert(r2.body && r2.body.request_id === 'c-gate-2',
      '200 path still echoes conversation_id (stub behaviour intact)');

    // 2c: Disable agent → 403 again (round-trip).
    userModel.disableModule(db, brandon.id, 'agent');
    const r3 = await request({
      ...base, path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    }, { message: 'second flap', endpoint_id: ep.id, conversation_id: 'c-gate-3' });
    assertEq(r3.status, 403, 'round-trip disable → 403 again');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 2 crashed', err.stack || err.message);
  }

  // ---------- Test 3: GET /api/gazette/brief gate ----------
  console.log('\nTest 3: GET /api/gazette/brief is gated by the agent module');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    for (const k of ['chores', 'lists', 'calendar', 'apps', 'agent']) {
      userModel.disableModule(db, brandon.id, k);
    }

    // 3a: agent disabled → 403.
    const r1 = await request({
      ...base, path: '/api/gazette/brief', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(r1.status, 403, 'agent disabled → GET /api/gazette/brief returns 403');
    assertEq(r1.body.error, 'agent_disabled', '403 body.error === "agent_disabled"');

    // 3b: agent enabled → 200 with placeholder body.
    userModel.enableModule(db, brandon.id, 'agent');
    const r2 = await request({
      ...base, path: '/api/gazette/brief', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(r2.status, 200, 'agent enabled → GET /api/gazette/brief returns 200');
    assertEq(r2.body.ok, true, '200 body.ok === true');
    assertEq(r2.body.agent_enabled, true, '200 body flags agent_enabled');
    assertEq(r2.body.shipped_by, 'PHA-2208', '200 body identifies the gate shim');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 3 crashed', err.stack || err.message);
  }

  // ---------- Test 4: /api/me/layout.agentDrawer flips in lockstep ----------
  console.log('\nTest 4: /api/me/layout.agentDrawer tracks the enabled set');
  try {
    const { db, tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const cookie = await login(request, base, 'brandon');
    const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    for (const k of ['chores', 'lists', 'calendar', 'apps', 'agent']) {
      userModel.disableModule(db, brandon.id, k);
    }

    const r1 = await request({
      ...base, path: '/api/me/layout', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(r1.status, 200, 'layout endpoint 200');
    assertEq(r1.body.agentDrawer, false, 'fresh user → agentDrawer === false');

    userModel.enableModule(db, brandon.id, 'agent');
    const r2 = await request({
      ...base, path: '/api/me/layout', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(r2.body.agentDrawer, true, 'after enable → agentDrawer === true');

    userModel.disableModule(db, brandon.id, 'agent');
    const r3 = await request({
      ...base, path: '/api/me/layout', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(r3.body.agentDrawer, false, 'after disable → agentDrawer === false');

    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 4 crashed', err.stack || err.message);
  }

  // ---------- Test 5: public/index.html wires the FAB ----------
  console.log('\nTest 5: public/index.html wires the drawer FAB via agentDrawer');
  try {
    const indexPath = path.join(__dirname, '..', 'public', 'index.html');
    const html = fs.readFileSync(indexPath, 'utf8');

    assert(html.includes('applyAgentFab'),
      'public/index.html defines/calls applyAgentFab');
    assert(/window\.applyAgentFab\s*=\s*applyAgentFab/.test(html),
      'applyAgentFab is exported on window (add-a-room sheet can re-call)');
    assert(/await\s+applyAgentFab\(\)/.test(html),
      'boot() awaits applyAgentFab (gate fires before redirect)');
    assert(!html.includes('id="drawerFab" style="display:none"'),
      'drawer FAB stays in the DOM (no inline display:none)');
    assert(/#drawerFab\.off\{opacity:0;pointer-events:none/.test(html),
      'CSS hides the FAB via the .off class, not by removing it');

    // Pure-helper test: extract the applyAgentFab block and run it in a
    // sandbox with mocked DOM + fetch. Verifies the toggle logic
    // without standing up a browser.
    const helperMatch = html.match(/async function applyAgentFab\(\)[\s\S]*?\n\}/);
    assert(!!helperMatch, 'applyAgentFab source block is locatable');
    if (helperMatch) {
      let _last = null;
      let _agentDrawer = true;
      const doc = {
        getElementById: (id) => id === 'drawerFab'
          ? { classList: { toggle: (cls, on) => { _last = { id, cls, on }; } } }
          : null,
      };
      const sandbox = {
        doc,
        api: () => Promise.resolve({ agentDrawer: _agentDrawer }),
        $: (sel) => doc.getElementById(sel.replace('#', '')),
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        setTimeout, clearTimeout, console, Promise,
      };
      const ctx = vm.createContext(sandbox);
      // The helper references `$` (id selector) and `api` (REST wrapper).
      // Inline the helper wrapped to expose the toggle target.
      const wrapped = helperMatch[0] + '\n;this.__result = (async () => applyAgentFab())();';
      vm.runInContext(wrapped, ctx);
      const result = await ctx.__result;
      assertEq(result, true, 'applyAgentFab returns true when agentDrawer=true');
      assert(_last && _last.cls === 'off' && _last.on === false,
        'applyAgentFab toggles `off` class OFF when agentDrawer=true');

      _last = null;
      _agentDrawer = false;
      vm.runInContext(wrapped, ctx);
      const result2 = await ctx.__result;
      assertEq(result2, false, 'applyAgentFab returns false when agentDrawer=false');
      assert(_last && _last.cls === 'off' && _last.on === true,
        'applyAgentFab toggles `off` class ON when agentDrawer=false');
    }

    teardown(null, null);
  } catch (err) {
    ng('Test 5 crashed', err.stack || err.message);
  }

  // ---------- Test 6: unauthenticated /api/gazette/brief ----------
  console.log('\nTest 6: /api/gazette/brief rejects unauthenticated requests');
  try {
    const { tmpDir, server } = bootFreshStack();
    const { port, request } = await startServer(server);
    const base = { hostname: '127.0.0.1', port };
    const r = await request({
      ...base, path: '/api/gazette/brief', method: 'GET',
      headers: {},
    });
    assertEq(r.status, 401, 'no cookie → 401 (gate runs after auth middleware)');
    teardown(server, tmpDir);
  } catch (err) {
    ng('Test 6 crashed', err.stack || err.message);
  }

  // ---------- Summary ----------
  console.log(`\n[test-agent-gating] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('[test-agent-gating] top-level crash', err.stack || err.message);
  process.exit(1);
});
