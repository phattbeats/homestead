#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2223 policy tests.  The donation surface has one fixed external link
// and may retain only one unattributed total -- never an event history or
// time-bucketed analytics.
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const EXPECTED_URL = 'https://github.com/sponsors/phattbeats';

function freshDonations() {
  delete require.cache[require.resolve('../lib/donations')];
  return require('../lib/donations');
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, raw, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const donations = freshDonations();
  assert.deepStrictEqual(donations.getLink(), { url: EXPECTED_URL, label: 'Support Homestead' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-donations-'));
  let server;
  try {
    const db = new Database(path.join(tmpDir, 'counter.db'));
    donations.migrate(db);
    const columns = db.prepare("PRAGMA table_info('donation_counter')").all().map(row => row.name);
    assert.deepStrictEqual(columns, ['id', 'count'], 'counter schema must not hold identity or event data');
    assert.strictEqual(donations.getCount().count, 0);
    donations.recordClick();
    donations.recordClick();
    assert.strictEqual(donations.getCount().count, 2, 'counter increments without an event history');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM donation_counter').get().n, 1, 'exactly one counter row');
    db.close();

    process.env.DATA_DIR = tmpDir;
    process.env.PORT = '0';
    process.env.ADMIN_PASSWORD = 'donations-admin-pw';
    process.env.BRANDON_PASSWORD = 'donations-brandon-pw';
    process.env.SESSION_SECRET = 'donations-test-secret';
    process.env.NODE_ENV = 'production';
    delete require.cache[require.resolve('../server.js')];
    const app = require('../server.js');
    server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = { hostname: '127.0.0.1', port: server.address().port };

    const link = await request({ ...base, path: '/api/donation-link', method: 'GET' });
    assert.strictEqual(link.status, 200);
    assert.deepStrictEqual(link.json, { url: EXPECTED_URL, label: 'Support Homestead' });
    const click = await request({ ...base, path: '/api/donation-click', method: 'POST' });
    assert.strictEqual(click.status, 204);
    assert.strictEqual(click.raw, '');
    const login = await request({ ...base, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, { username: 'admin', password: 'donations-admin-pw' });
    const cookie = login.headers['set-cookie'][0];
    const count = await request({ ...base, path: '/api/admin/donation-count', method: 'GET', headers: { Cookie: cookie } });
    assert.strictEqual(count.status, 200);
    assert.deepStrictEqual(Object.keys(count.json), ['count'], 'admin endpoint exposes only the plain count');
    assert.strictEqual(count.json.count, 1);

    const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert(html.includes('id="f-about"') && html.includes('/api/donation-link') && html.includes('/api/donation-click'));
    assert(html.includes("window.open(link.url,'_blank','noopener,noreferrer')"));
    assert(readme.includes(EXPECTED_URL));
    assert.strictEqual(pkg.funding.url, EXPECTED_URL, 'package metadata uses the same one link');
    assert(!html.includes('donation surface not configured'), 'the selected provider is always available');
    console.log('PHA-2223 donation policy checks passed.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
