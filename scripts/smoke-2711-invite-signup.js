#!/usr/bin/env node
// PHA-2711 smoke for the public invite-signup vertical path.
//
// Boots an isolated server, mints an invite, walks the full path:
//   1. GET /api/public/invites/:code        → 200 + inviter + remaining
//   2. POST /api/public/invites/:code/signup → 201 + session cookie
//   3. GET /api/me on the session cookie    → user is the new account
//   4. POST /api/logout                     → 200
//   5. GET /api/me on the same cookie       → user is null
//   6. POST /api/public/invites/:code/signin (fresh invite, same user) → 200 + new cookie
//   7. GET /api/me on the new cookie        → user is back
//
// Each step is recorded into verify-out/ alongside the script so the
// artifacts can be attached to the Paperclip closing comment. Exits 0
// if every step returns its expected status; non-zero on any failure.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const walls = require('../lib/walls');
const invites = require('../lib/invites');

const OUT_DIR = path.join(__dirname, '..', 'verify-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

function record(name, payload) {
  const file = path.join(OUT_DIR, name + '.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`[smoke-2711] wrote ${path.relative(process.cwd(), file)}`);
}

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const body = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, opts.headers || {});
    const req = http.request({ host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (buf) { try { parsed = JSON.parse(buf); } catch (_) { parsed = buf; } }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractCookie(setCookie) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    const m = c.match(/connect\.sid=([^;]+)/);
    if (m) return 'connect.sid=' + m[1];
  }
  return null;
}

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`  ✗ ${label} — expected ${e}, got ${a}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2711-'));
  const dbPath = path.join(tmpDir, 'life.db');

  // Migrate the DB so we have an admin user + walls + invites tables.
  const db = new Database(dbPath);
  userModel.migrate(db);
  walls.migrate(db);
  walls.seed(db);
  invites.migrate(db);
  // Set admin's pass_hash to something known so we can sign in as
  // admin to mint the invite (the admin API requires requireAdmin).
  const adminId = db.prepare('SELECT id FROM users WHERE username = ?').get('admin').id;
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('admin-pass-2026', 10);
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, adminId);
  // And the local_credentials row needs the same hash.
  db.prepare('INSERT OR REPLACE INTO local_credentials (user_id, password_hash) VALUES (?, ?)').run(adminId, hash);
  db.close();

  const port = 34000 + Math.floor(Math.random() * 30000);
  const env = { ...process.env, DATA_DIR: tmpDir, PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: 'pha-2711-smoke-secret', ALLOW_HEADER_TRUST: '0' };
  const child = require('child_process').spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  // Wait for boot.
  for (let i = 0; i < 80; i++) {
    try {
      const r = await request(port, { path: '/api/health' });
      if (r.status === 200) break;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    // 1. Login as admin to mint the invite.
    const loginAdmin = await request(port, { method: 'POST', path: '/api/login', body: { username: 'admin', password: 'admin-pass-2026' } });
    assertEq(loginAdmin.status, 200, 'admin login → 200');
    const adminCookie = extractCookie(loginAdmin.headers['set-cookie']);
    if (!adminCookie) { console.error('no session cookie from admin login'); throw new Error('no_admin_cookie'); }

    // 2. Mint a fresh household invite (max_uses=2 so we can signin as the new user later with a fresh invite too).
    const newInv = await request(port, { method: 'POST', path: '/api/invites', headers: { cookie: adminCookie }, body: { wall_slug: 'household', expires_in_days: 7, max_uses: 2, note: 'PHA-2711 smoke' } });
    assertEq(newInv.status, 201, 'mint invite → 201');
    const code = newInv.body.id;
    record('smoke-2711-invite-mint', newInv.body);

    // 3. Public peek.
    const peek = await request(port, { path: '/api/public/invites/' + code });
    assertEq(peek.status, 200, 'public peek → 200');
    assertEq(peek.body.wall_slug, 'household', 'peek returns wall_slug');
    assertEq(peek.body.note, 'PHA-2711 smoke', 'peek returns admin note');
    assertEq(peek.body.remaining, 2, 'peek returns remaining');
    record('smoke-2711-peek', peek.body);

    // 4. Signup.
    const signup = await request(port, { method: 'POST', path: '/api/public/invites/' + code + '/signup', body: { username: 'smokeuser', display: 'Smoke User', password: 'smoke-pass-1234' } });
    assertEq(signup.status, 201, 'signup → 201');
    assertEq(signup.body.wall_slug, 'household', 'signup returns wall_slug');
    assertEq(signup.body.first_run, true, 'signup returns first_run=true');
    const cookie = extractCookie(signup.headers['set-cookie']);
    if (!cookie) { console.error('no session cookie from signup'); throw new Error('no_signup_cookie'); }
    record('smoke-2711-signup', { status: signup.status, user: signup.body.user, wall_slug: signup.body.wall_slug, first_run: signup.body.first_run, redirect: signup.body.redirect });

    // 5. /api/me on the signup cookie.
    const meSigned = await request(port, { path: '/api/me', headers: { cookie } });
    assertEq(meSigned.status, 200, '/api/me on signup cookie → 200');
    assertEq(meSigned.body.user.username, 'smokeuser', '/api/me session resolves to smokeuser');

    // 6. Logout.
    const logout = await request(port, { method: 'POST', path: '/api/logout', headers: { cookie }, body: {} });
    assertEq(logout.status, 200, 'logout → 200');

    // 7. /api/me on the now-cleared cookie.
    const meCleared = await request(port, { path: '/api/me', headers: { cookie } });
    assertEq(meCleared.body.user, null, '/api/me after logout → user null');

    // 8. Re-signin via the public path with a fresh invite.
    const newInv2 = await request(port, { method: 'POST', path: '/api/invites', headers: { cookie: adminCookie }, body: { wall_slug: 'household', expires_in_days: 7, max_uses: 1, note: 'PHA-2711 re-signin' } });
    assertEq(newInv2.status, 201, 'mint second invite → 201');
    const code2 = newInv2.body.id;
    const signin = await request(port, { method: 'POST', path: '/api/public/invites/' + code2 + '/signin', body: { username: 'smokeuser', password: 'smoke-pass-1234' } });
    assertEq(signin.status, 200, 're-signin → 200');
    const cookie2 = extractCookie(signin.headers['set-cookie']);
    if (!cookie2) { console.error('no session cookie from signin'); throw new Error('no_signin_cookie'); }
    record('smoke-2711-signin', { status: signin.status, user: signin.body.user, wall_slug: signin.body.wall_slug });

    // 9. /api/me on the re-signin cookie.
    const meAgain = await request(port, { path: '/api/me', headers: { cookie: cookie2 } });
    assertEq(meAgain.status, 200, '/api/me on re-signin cookie → 200');
    assertEq(meAgain.body.user.username, 'smokeuser', 're-signed in as smokeuser');

    // 10. Verify wall_membership row landed.
    const verifyDb = new Database(dbPath, { readonly: true });
    const userRow = verifyDb.prepare('SELECT id FROM users WHERE username = ?').get('smokeuser');
    const wallRow = verifyDb.prepare(`SELECT 1 FROM wall_memberships wm JOIN walls w ON w.id = wm.wall_id WHERE wm.user_id = ? AND w.slug = ?`).get(userRow.id, 'household');
    assertEq(!!wallRow, true, 'wall_memberships row inserted for smokeuser');
    const redemptionCount = verifyDb.prepare('SELECT COUNT(*) c FROM invite_redemptions WHERE user_id = ?').get(userRow.id).c;
    assertEq(redemptionCount >= 2, true, 'invite_redemptions rows recorded (>=2)');
    const localCred = verifyDb.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(userRow.id);
    assertEq(!!(localCred && localCred.password_hash && localCred.password_hash.length > 20), true, 'local_credentials row written with bcrypt hash');
    verifyDb.close();

    if (process.exitCode) {
      console.error('[smoke-2711] FAILED');
    } else {
      console.log('[smoke-2711] PASSED');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(2); });
