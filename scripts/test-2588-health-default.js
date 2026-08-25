#!/usr/bin/env node
// PHA-2588 regression: a README-default installation does not need the
// optional CALENDAR_CRED_KEY to serve the core application. Health remains
// green when SQLite is ready while calendarCredKeyReady exposes the feature
// capability independently.

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-health-default-'));
const port = 3198;
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'health-default-admin-pw';
process.env.SESSION_SECRET = 'health-default-session-secret';
process.env.NODE_ENV = 'production';
delete process.env.CALENDAR_CRED_KEY;

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await response.json();
    assert.equal(response.status, 200, 'health endpoint returns 200');
    assert.equal(health.ok, true, 'healthy database keeps core probe true');
    assert.equal(health.db, 'ok', 'fresh database is ready');
    assert.equal(health.calendarCredKeyReady, false, 'optional calendar key remains separately visible');
    console.log('PHA-2588: default-install health contract passes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
