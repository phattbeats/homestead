#!/usr/bin/env node
// PHA-3218 regression: a standalone post-login smoke must boot a real
// Homestead instance and retain the post-login session while it loads the
// SPA. PHA-3200 made production cookies Secure; the smoke talks to its
// scratch instance over plain HTTP and therefore sets the explicit
// test-only transport opt-out before requiring server.js.

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const smokePath = path.join(__dirname, 'smoke-postlogin-screenshot.js');
const smokeSource = fs.readFileSync(smokePath, 'utf8');

const insecureOptOut = "process.env.HOMESTEAD_INSECURE_TEST_COOKIES = '1';";
assert.match(
  smokeSource,
  new RegExp(insecureOptOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'standalone post-login smoke explicitly opts out of Secure cookies for its plain-HTTP scratch instance',
);
assert.match(
  smokeSource,
  /waitForResponse\([\s\S]*?\/api\/login[\s\S]*?const loginResponse = await loginResponsePromise[\s\S]*?loginResponse\.ok\(\)/,
  'post-login smoke requires a successful login response before waiting for the authenticated app shell',
);

const ciSmokeFiles = [
  'smoke-spa-pageerrors.js',
  'smoke-postlogin-screenshot.js',
  'smoke-entity-deeplink.js',
  'smoke-2498-install-coach-deferral.js',
  'smoke-2498-fab-pileup.js',
  'smoke-2498-preauth-drawer.js',
  'smoke-2585-home-always-visible.js',
  'smoke-2586-lists-ui.js',
  'smoke-2707-invite-welcome.js',
];
for (const file of ciSmokeFiles) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  assert.match(
    source,
    new RegExp(insecureOptOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `${file} explicitly opts out of Secure cookies for its plain-HTTP scratch server`,
  );
}

let server;

async function startServer() {
  const app = require('../server.js');
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not expose an ephemeral port');
  return { server, port: address.port };
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-3218-'));
  process.env.PORT = '0';
  process.env.ADMIN_PASSWORD = 'test-admin-password';
  process.env.BRANDON_PASSWORD = 'test-brandon-password';
  process.env.SESSION_SECRET = 'test-session-secret-padding-to-meet-min-32-chars';
  process.env.NODE_ENV = 'production';
  process.env.HOMESTEAD_INSECURE_TEST_COOKIES = '1';

  assert.doesNotMatch(
    smokeSource,
    /process\.env\.NODE_ENV\s*=\s*'production'[\s\S]{0,120}process\.env\.HOMESTEAD_INSECURE_TEST_COOKIES\s*=\s*'0'/,
    'test must not deliberately disable the required test-cookie opt-out',
  );

  const running = await startServer();
  try {
    const login = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ username: 'admin', password: 'test-admin-password' });
      const request = http.request({
        hostname: '127.0.0.1',
        port: running.port,
        path: '/api/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data }));
      });
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(login.status, 200, 'real production-mode login round-trip succeeds');
    assert.match(login.headers['set-cookie']?.[0] || '', /HttpOnly/i, 'session cookie remains HttpOnly');
    assert.doesNotMatch(login.headers['set-cookie']?.[0] || '', /Secure/i, 'scratch HTTP login emits a non-Secure cookie');

    const followed = await new Promise((resolve, reject) => {
      const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
      const request = http.request({
        hostname: '127.0.0.1', port: running.port, path: '/api/me', method: 'GET', headers: { Cookie: cookie },
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(followed.status, 200, 'scratch HTTP session follows login');
    assert.equal(followed.body.user.username, 'admin', 'cookie restores the authenticated user');
  } finally {
    await stopServer();
  }

  console.log('PHA-3218: post-login session transport contract passes');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
