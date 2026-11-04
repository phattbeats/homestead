#!/usr/bin/env node
// Acceptance: Homestead's hub client + router against a stub hub (HTTP). Proves owner mapping,
// that grant/revoke permission calls carry the right owner header, and that the router 404s when unconfigured.
'use strict';
const http = require('http');
const express = require('express');
const hubClient = require('../lib/hub-client');
const agentHubRouter = require('../routes/agent-hub');
const Database = require('better-sqlite3');

let fail = 0;
const check = (c, l) => { console.log(`  ${c ? '✓' : '✗'} ${l}`); if (!c) fail++; };
const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });

(async () => {
  const seen = [];
  const stub = express();
  stub.use((req, res) => { seen.push(`${req.method} ${req.url} owner=${req.get('x-hub-owner')} auth=${req.get('authorization')}`); res.json({ id: 41, status: 'active', permissions: [] }); });
  const hubSrv = await listen(stub);
  const hub = hubClient.createClient({ url: `http://127.0.0.1:${hubSrv.address().port}`, key: 'k' });

  const db = new Database(':memory:');
  db.exec(`CREATE TABLE identity_links (id INTEGER PRIMARY KEY, user_id INT, provider TEXT, issuer TEXT, provider_subject TEXT)`);
  db.prepare('INSERT INTO identity_links(user_id,provider,issuer,provider_subject) VALUES (3,?,?,?)').run('oidc', 'https://id', 'sub-3');
  check(hubClient.ownerFor(db, 3) === 'sub-3', 'linked user maps to PHATT ID subject');
  check(hubClient.ownerFor(db, 9) === 'legacy:homestead:9', 'unlinked user maps to legacy owner');
  check(hubClient.config({}) === null, 'unconfigured → null');

  const userModel = { getMe: () => ({ id: 3 }) };
  const app = express();
  app.use((req, _r, next) => { req.session = { user: { username: 'u' } }; next(); });
  app.use('/api/agent-hub', agentHubRouter({ db, auth: (_q, _s, n) => n(), userModel, hub }));
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}/api/agent-hub`;
  await fetch(`${base}/connections/41/permissions/homestead:read`, { method: 'PUT' });
  await fetch(`${base}/connections/41/permissions/homestead:read`, { method: 'DELETE' });
  check(seen[0] === 'PUT /api/v1/connections/41/permissions/homestead%3Aread owner=sub-3 auth=Bearer k', `grant forwarded (${seen[0]})`);
  check(seen[1].startsWith('DELETE ') && seen[1].includes('owner=sub-3'), 'revoke forwarded');

  const app2 = express();
  app2.use((req, _r, next) => { req.session = { user: { username: 'u' } }; next(); });
  app2.use('/api/agent-hub', agentHubRouter({ db, auth: (_q, _s, n) => n(), userModel, hub: null }));
  const srv2 = await listen(app2);
  const r2 = await fetch(`http://127.0.0.1:${srv2.address().port}/api/agent-hub/connections`);
  check(r2.status === 404, 'router 404s when hub not configured');
  [hubSrv, srv, srv2].forEach((s) => s.close());
  console.log(fail ? `FAIL (${fail})` : 'PASS'); process.exit(fail ? 1 : 0);
})();
