#!/usr/bin/env node
// PHA-2811 regression: POST/PUT /api/tasks must reject when the caller's
// household doesn't have the `chores` module enabled. Before this fix
// the row was written to the DB but never rendered anywhere (no nav
// tab, no home task list) — a silent orphan.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-taskgate-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3192';
process.env.ADMIN_PASSWORD = 'taskgate-test-pw';
process.env.BRANDON_PASSWORD = 'taskgate-test-pw';
process.env.SESSION_SECRET = 'taskgate-test-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const HEAD = {
  'x-authentik-username': 'brandon',
  'x-authentik-groups': 'household',
};
const POST = (urlPath, body) => fetch('http://127.0.0.1:3192' + urlPath, {
  method: 'POST',
  headers: { ...HEAD, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const PUT = (urlPath, body) => fetch('http://127.0.0.1:3192' + urlPath, {
  method: 'PUT',
  headers: { ...HEAD, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const GET = (urlPath) => fetch('http://127.0.0.1:3192' + urlPath, { headers: HEAD });

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3192, '127.0.0.1', () => { console.log('[test-2811-task-module-gate] homestead on :3192'); resolve(); });
    process.on('uncaughtException', reject);
  });
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('http://127.0.0.1:3192/api/health'); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  ok('server boots');

  // Disable lists (cascades to chores, per requires: [lists]).
  await (await POST('/api/me/modules/lists/disable', { withDependents: true })).json();
  const enabled = await (await GET('/api/me')).json();
  if (enabled.enabled_modules.includes('chores')) ng('precondition: chores disabled', 'chores still enabled');
  else ok('precondition: chores disabled');

  console.log('\nTest 1: POST /api/tasks rejected when chores is disabled');
  {
    const r = await POST('/api/tasks', { title: 'orphan chore', assignee: 'all' });
    assertEq(r.status, 403, 'POST /api/tasks -> 403');
    const body = await r.json();
    assertEq(body.error, 'module_not_enabled', 'error === "module_not_enabled"');
    const tasks = await (await GET('/api/tasks')).json();
    assertEq(tasks.length, 0, 'no task row was written');
  }

  console.log('\nTest 2: POST /api/tasks succeeds once chores is enabled');
  {
    await (await POST('/api/me/modules/chores/enable', { withRequirements: true })).json();
    const r = await POST('/api/tasks', { title: 'real chore', assignee: 'all' });
    assertEq(r.status, 200, 'POST /api/tasks -> 200 once chores is enabled');
    const created = await r.json();

    console.log('\nTest 3: PUT /api/tasks/:id rejected once chores is disabled again');
    await (await POST('/api/me/modules/lists/disable', { withDependents: true })).json();
    const put = await PUT(`/api/tasks/${created.id}`, { title: 'edited orphan' });
    assertEq(put.status, 403, 'PUT /api/tasks/:id -> 403');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
