#!/usr/bin/env node
// PHA-2643 acceptance test for the admin "delegate apps to users" endpoint
// (PUT /api/admin/services/:id/owner). Live server.js smoke test, same
// boot/login pattern as scripts/test-feed-component.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const PORT = 3194;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-delegate-apps-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'delegate-test-admin-pw';
process.env.EMILY_PASSWORD = 'delegate-test-emily-pw';
process.env.SESSION_SECRET = 'delegate-test-secret';
process.env.NODE_ENV = 'production';

(async () => {
  const app = require(path.join(ROOT, 'server.js'));
  await new Promise((resolve, reject) => {
    app.listen(PORT, '127.0.0.1', () => { console.log(`[delegate-apps] homestead on :${PORT}`); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  try {
    const adminCookie = await login('admin', 'delegate-test-admin-pw');
    const emilyCookie = await login('emily', 'delegate-test-emily-pw');

    // Seed a tile via the existing self-serve endpoint (unchanged by this
    // change — any authed user, admin or not, can still create their own).
    const createRes = await fetch(`${BASE}/api/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: emilyCookie },
      body: JSON.stringify({ name: 'SillyTavern', url: 'https://st.example', owner: 'all' }),
    });
    assertEq(createRes.status, 200, 'non-admin can still create a tile via the existing self-serve endpoint');
    const svc = await createRes.json();
    assertEq(svc.owner, 'all', 'created tile owner defaults to all');

    // Non-admin must not be able to delegate ownership through the new
    // admin-only path.
    const forbidden = await fetch(`${BASE}/api/admin/services/${svc.id}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: emilyCookie },
      body: JSON.stringify({ owner: 'emily' }),
    });
    assertEq(forbidden.status, 403, 'non-admin gets 403 from the admin delegate-owner route');

    // Admin can reassign.
    const reassign = await fetch(`${BASE}/api/admin/services/${svc.id}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ owner: 'emily' }),
    });
    assertEq(reassign.status, 200, 'admin can PUT the admin delegate-owner route');
    const reassigned = await reassign.json();
    assertEq(reassigned.owner, 'emily', 'response reflects the new owner');

    const listRes = await fetch(`${BASE}/api/services`, { headers: { Cookie: adminCookie } });
    const list = await listRes.json();
    const persisted = list.find((s) => s.id === svc.id);
    assertEq(persisted && persisted.owner, 'emily', 'reassignment persisted (GET /api/services reflects it)');

    // Unknown owner is rejected.
    const badOwner = await fetch(`${BASE}/api/admin/services/${svc.id}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ owner: 'nobody-by-this-name' }),
    });
    assertEq(badOwner.status, 400, 'unknown owner is rejected with 400');

    // Unknown tile id 404s.
    const missing = await fetch(`${BASE}/api/admin/services/999999/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ owner: 'emily' }),
    });
    assertEq(missing.status, 404, 'unknown tile id 404s');

    console.log(`\n[delegate-apps] ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('[delegate-apps] error:', e && e.stack || e);
    process.exit(1);
  }
})();

async function login(username, password) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}
