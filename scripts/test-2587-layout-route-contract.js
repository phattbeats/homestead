#!/usr/bin/env node
// PHA-2587 acceptance — layout-route contract live evidence.
//
// Issue body requires:
//   "curl of /api/me/layout plus GET of each advertised route
//    (all 200 or route is null). SHA in main."
//
// This script: boots a fresh Homestead server on an ephemeral port,
// logs in, ENSURES all 6 modules are enabled (via enable + cascade),
// GETs /api/me/layout, then probes every advertised route.
//
// Contract on main @ 23a777e (PR #75):
//   * Only /porch.html is ever advertised as a non-null route.
//   * The other frame-mode built-ins (lists/calendar/chores/apps) and
//     drawer-mode (agent) emit route:null because they're SPA-only.
//   * Empty layout (0 modules enabled) emits defaultRoute:null
//     (NOT /onboarding.html which would 404).
//
// The legacy 404 paths (/lists.html, /calendar.html, /chores.html,
// /apps.html, /onboarding.html) still 404 — they're no longer
// advertised in /api/me/layout, so a client following layout.route
// never sees them.

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3187;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-2587-XXXXXX'));
const ADMIN_PASSWORD = 'verify-admin-pw';
const SESSION_SECRET = 'verify-secret-2587';
const HOST = '127.0.0.1';

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log('  \u001b[32m✓\u001b[0m', msg);
    passed++;
  } else {
    console.log('  \u001b[31m✗\x1b[0m', msg);
    failures.push(msg);
    failed++;
  }
}

const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    ADMIN_PASSWORD,
    BRANDON_PASSWORD: ADMIN_PASSWORD,
    SESSION_SECRET,
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
serverProc.stdout.on('data', () => {});
serverProc.stderr.on('data', () => {});

async function waitForBoot() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/api/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not boot within 25s');
}

async function login(username, password) {
  const r = await fetch(`http://${HOST}:${PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${username}: ${r.status}`);
  // Use WHATWG getSetCookie() to extract each cookie cleanly.
  let pairs = [];
  if (typeof r.headers.getSetCookie === 'function') {
    pairs = r.headers.getSetCookie().map(s => s.split(';')[0]);
  } else {
    const sc = r.headers.get('set-cookie') || '';
    pairs = sc.split(/, (?=[a-zA-Z0-9_]+=)/).map(s => s.split(';')[0]);
  }
  const sid = pairs.find(p => p.startsWith('connect.sid='));
  if (!sid) throw new Error(`no connect.sid for ${username}: ${pairs.join('|')}`);
  return sid;
}

async function getAs(cookie, urlPath) {
  return fetch(`http://${HOST}:${PORT}${urlPath}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });
}

function listAdvertisedRoutes(layout) {
  const out = [];
  for (const [k, v] of [['defaultRoute', layout.defaultRoute]]) {
    if (typeof v === 'string') out.push({ from: k, value: v });
  }
  for (const t of (layout.tabs || [])) {
    if (typeof t.route === 'string') out.push({ from: `tabs[${t.key}]`, value: t.route });
  }
  for (const p of (layout.pages || [])) {
    if (typeof p.route === 'string') out.push({ from: `pages[${p.key}]`, value: p.route });
  }
  return out;
}

async function enable(cookie, key, body) {
  const r = await fetch(`http://${HOST}:${PORT}/api/me/modules/${key}/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : '{}',
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function disable(cookie, key, body) {
  const r = await fetch(`http://${HOST}:${PORT}/api/me/modules/${key}/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : '{}',
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  console.log('=== PHA-2587 layout-route contract — live evidence ===');
  console.log(`SHA in main: 23a777e (PR #75, pha-2587-layout-contract)`);
  console.log(`DATA_DIR:   ${DATA_DIR}`);
  await waitForBoot();
  console.log(`booted:     http://${HOST}:${PORT}/api/health → ok\n`);

  // Login as admin, then ensure ALL 6 modules are enabled (the seed
  // may have granted different defaults across DB versions). We use
  // enable + withRequirements:true to satisfy the cascade.
  const cookie = await login('admin', ADMIN_PASSWORD);
  const meInit = await (await getAs(cookie, '/api/me')).json();
  console.log(`admin initial state: enabled_modules=${JSON.stringify(meInit.enabled_modules)}`);
  // Always reset to all-6 enabled. Enable order: requirements first,
  // then dependents.
  for (const k of ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent']) {
    const r = await enable(cookie, k, { withRequirements: true });
    if (r.status !== 200) console.log(`  enable ${k} → ${r.status} ${JSON.stringify(r.body).slice(0,160)}`);
  }
  const meAfter = await (await getAs(cookie, '/api/me')).json();
  console.log(`admin after enable-all: enabled_modules=${JSON.stringify(meAfter.enabled_modules)}\n`);

  // === Required contract: GET /api/me/layout ===
  console.log('--- GET /api/me/layout (admin, all 6 enabled) ---');
  const layoutRaw = await getAs(cookie, '/api/me/layout');
  assert(layoutRaw.status === 200, `GET /api/me/layout → ${layoutRaw.status}`);
  const layout = await layoutRaw.json();
  console.log(`  layout: ${layout.layout}, defaultRoute: ${layout.defaultRoute}, ` +
              `tabs: ${(layout.tabs || []).length}, pages: ${(layout.pages || []).length}, ` +
              `addRoomVisible: ${layout.addRoomVisible}, agentDrawer: ${layout.agentDrawer}`);
  const tabs = (layout.tabs || []).map(t => ({ key: t.key, route: t.route }));
  for (const t of tabs) console.log(`    tab ${t.key.padEnd(10)} → route: ${t.route === null ? 'null' : t.route}`);

  // Contract assertions.
  assert(typeof layout.defaultRoute === 'string', 'layout.defaultRoute is a string when modules are enabled');
  assert(layout.defaultRoute === '/porch.html', `layout.defaultRoute === "/porch.html" (got ${layout.defaultRoute})`);
  const wallTile = tabs.find(t => t.key === 'wall');
  assert(wallTile && wallTile.route === '/porch.html', 'wall tab route === "/porch.html" (the only real HTML route)');
  for (const k of ['lists', 'calendar', 'chores', 'apps']) {
    const t = tabs.find(x => x.key === k);
    assert(t && t.route === null, `${k} (frame-mode SPA-only) emits route:null`);
  }
  const agentTile = tabs.find(t => t.key === 'agent');
  assert(agentTile && agentTile.route === null, 'agent (drawer-mode) emits route:null');

  // === Required contract: probe every advertised route ===
  const advertised = listAdvertisedRoutes(layout);
  console.log(`\n--- advertised (non-null) routes: ${advertised.length} ---`);
  for (const a of advertised) console.log(`    ${a.from.padEnd(20)} → ${a.value}`);
  for (const a of advertised) {
    const r = await getAs(cookie, a.value);
    assert(r.status === 200, `GET ${a.value} (${a.from}) → ${r.status}`);
  }

  // === Required contract: empty layout → defaultRoute:null ===
  console.log('\n--- empty layout (all 6 disabled) ---');
  // Dependency-graph order: leaves first, then requirees.
  // chores requires lists; lists requires wall. So disable chore → lists → wall.
  for (const k of ['agent', 'apps', 'calendar', 'chores']) {
    const r = await disable(cookie, k);
    if (r.status !== 200) console.log(`  disable ${k} → ${r.status} ${JSON.stringify(r.body).slice(0,160)}`);
  }
  // chores has dependents? No. Now disable lists (cascades to chore, but chore is gone).
  const listsR = await disable(cookie, 'lists', { withDependents: true });
  console.log(`  disable lists (withDependents) → ${listsR.status} ${JSON.stringify(listsR.body).slice(0,160)}`);
  const wallR = await disable(cookie, 'wall');
  console.log(`  disable wall → ${wallR.status} ${JSON.stringify(wallR.body).slice(0,160)}`);
  const meEmpty = await (await getAs(cookie, '/api/me')).json();
  console.log(`  final enabled_modules: ${JSON.stringify(meEmpty.enabled_modules)}`);

  const emptyRaw = await getAs(cookie, '/api/me/layout');
  const empty = await emptyRaw.json();
  console.log(`  empty layout: layout=${empty.layout}, defaultRoute=${empty.defaultRoute}, tabs=${(empty.tabs || []).length}`);
  assert(emptyRaw.status === 200, 'GET /api/me/layout (empty) → 200');
  assert(empty.layout === 'empty', `empty layout type === "empty" (got ${empty.layout})`);
  assert(empty.defaultRoute === null, `empty layout defaultRoute === null (got ${empty.defaultRoute})`);
  assert((empty.tabs || []).length === 0, `empty layout has 0 tabs (got ${(empty.tabs || []).length})`);

  // === Informational only: the legacy 404 paths still 404 but are no
  // longer advertised. ===
  console.log('\n--- legacy 404 PROBES (originally advertised, now unadvertised) ---');
  // Re-enable wall so /porch.html probe at the end still works.
  await enable(cookie, 'wall');
  for (const url of ['/lists.html', '/calendar.html', '/chores.html', '/apps.html', '/onboarding.html']) {
    try {
      const r = await getAs(cookie, url);
      console.log(`    GET ${url.padEnd(20)} → ${r.status} (informational; was originally advertised before PR #75)`);
    } catch (_) {
      console.log(`    GET ${url.padEnd(20)} → ERROR`);
    }
  }
  const porchProbe = await getAs(cookie, '/porch.html');
  assert(porchProbe.status === 200, `GET /porch.html → ${porchProbe.status} (only legitimate advertised HTML route)`);

  console.log('\n=== Summary ===');
  console.log(`${passed} passed, ${failed} failed`);
  // Tear down the child server and exit explicitly — the SPAExpress
  // child opens background timers (scheduler, health checker) that
  // keep Node from exiting on its own. SIGKILL if SIGTERM doesn't
  // take within 2s.
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise(r => setTimeout(r, 2500));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
}

process.on('exit', () => {
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

main().catch(err => {
  console.error('FATAL:', err.stack || err);
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
