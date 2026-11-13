#!/usr/bin/env node
// Arcade delete/export hooks (PHA-4102): signature checks, export, forget.
'use strict';

const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const userModel = require('../lib/user-model');
const identity = require('../lib/identity');
const hooks = require('../lib/arcade-hooks');

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`); } };

const db = new Database(':memory:');
userModel.migrate(db); identity.migrate(db);
const ISS = 'https://auth.phatt.vip/application/o/homestead/';
const A = '11111111-aaaa-4aaa-8aaa-111111111111'; // stand-in member
const B = '22222222-bbbb-4bbb-8bbb-222222222222'; // real Homestead account
const ins = db.prepare("INSERT INTO users (username, display, pass_hash, auth_provider, provider_subject, avatar_url) VALUES (?,?,?,?,?,?)");
const a = ins.run('ann', 'Ann', '', 'phatt_id', A, '/a.png').lastInsertRowid;
const b = ins.run('bob', 'Bob', 'hash', 'local', null, null).lastInsertRowid;
identity.linkIdentity(db, a, 'authentik', ISS, A);
identity.linkIdentity(db, b, 'authentik', ISS, B);

const env = { ARCADE_HOOK_SECRETS: JSON.stringify({ k1: 'test-secret' }) };
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { if (buf.length) req.rawBody = buf.toString('utf8'); } }));
app.use('/hooks', hooks.router({ db, env }));
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/hooks`;
const hdr = (data, { secret = 'test-secret', kid = 'k1', ts = Math.floor(Date.now() / 1000) } = {}) =>
  ({ 'content-type': 'application/json', 'x-arcade-kid': kid, 'x-arcade-ts': String(ts), 'x-arcade-sig': hooks.sign(secret, String(ts), data) });
const forget = (sub, o) => { const body = JSON.stringify({ sub }); return fetch(`${base}/forget`, { method: 'POST', headers: hdr(body, o), body }); };

(async () => {
  ok((await forget(A, { secret: 'wrong' })).status === 401, 'wrong secret -> 401');
  ok((await forget(A, { kid: 'k9' })).status === 401, 'unknown kid -> 401');
  ok((await forget(A, { ts: Math.floor(Date.now() / 1000) - 3600 })).status === 401, 'stale timestamp -> 401');
  const unc = express(); unc.use(express.json()); unc.use('/hooks', hooks.router({ db, env: {} }));
  const s2 = unc.listen(0);
  const r0 = await fetch(`http://127.0.0.1:${s2.address().port}/hooks/forget`, { method: 'POST', headers: hdr('{}'), body: '{}' });
  ok(r0.status === 503, 'unconfigured -> 503'); s2.close();

  const ex = await fetch(`${base}/export?sub=${A}`, { headers: hdr(`sub=${A}`) }).then((r) => r.json());
  ok(ex.users.length === 1 && ex.users[0].username === 'ann' && ex.users[0].links.length === 1, 'export lists the linked user and link');

  const fa = await forget(A).then((r) => r.json());
  ok(fa.ok && fa.unlinked === 1 && fa.anonymised === 1, 'forget stand-in: unlinked + anonymised', JSON.stringify(fa));
  const ua = db.prepare('SELECT * FROM users WHERE id=?').get(a);
  ok(ua.username === `former-${a}` && ua.display === 'Former member' && ua.avatar_url === null && ua.provider_subject === null, 'stand-in user is anonymised');
  ok(!identity.listIdentityLinks(db, a).length, 'stand-in has no links left');

  const fb = await forget(B).then((r) => r.json());
  ok(fb.unlinked === 1 && fb.anonymised === 0, 'forget real account: unlinked only');
  ok(db.prepare('SELECT username FROM users WHERE id=?').get(b).username === 'bob', 'real account keeps its name');

  const again = await forget(A).then((r) => r.json());
  ok(again.ok && again.unlinked === 0, 'forget is idempotent');
  const ex2 = await fetch(`${base}/export?sub=${A}`, { headers: hdr(`sub=${A}`) }).then((r) => r.json());
  ok(ex2.users.length === 0, 'export after forget is empty');

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
