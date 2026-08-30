#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2657 smoke: the backend feed contract for the new self-delete
// affordance. Boots server.js on an ephemeral port against a fresh
// DATA_DIR, logs in as brandon, creates a post, verifies the post
// surfaces with canDelete=true (author view), logs in as emily and
// verifies the same post surfaces with canDelete=false (non-author,
// non-admin view), then exercises DELETE as the author and confirms
// the post disappears from the listing. Curl transcript is the
// durable evidence the issue's DoD requires.
//
// This is intentionally a backend smoke — the frontend wire-up
// (window.confirm + onDeletePostClick handler + CSS) is verified
// separately by the feed-component test. If anyone needs to extend
// the affordance later (e.g. show last-edited state, add an undo),
// extend this smoke and the unit tests in scripts/test-walls.js
// together.
//
// Usage: node scripts/smoke-2657-self-delete.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2657-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3096';
process.env.ADMIN_PASSWORD = 'smoke-2657-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-2657-brandon-pw';
process.env.EMILY_PASSWORD = 'smoke-2657-emily-pw';
process.env.SESSION_SECRET = 'smoke-2657-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3096, '127.0.0.1', () => { console.log('[smoke-2657] homestead on :3096'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for /api/health.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3096/api/health');
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  async function login(username, password) {
    const r = await fetch('http://127.0.0.1:3096/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assertEq(r.status, 200, `login as ${username} returns 200`);
    return r.headers.get('set-cookie').split(';')[0];
  }

  const brandonCookie = await login('brandon', 'smoke-2657-brandon-pw');
  const emilyCookie = await login('emily', 'smoke-2657-emily-pw');

  // ---- Brandon creates a post on the seeded household wall ----
  const createRes = await fetch('http://127.0.0.1:3096/api/walls/household/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
    body: JSON.stringify({ kind: 'text', text_body: '[PHA-2657] smoke test post' }),
  });
  assertEq(createRes.status, 200, 'POST /api/walls/household/posts returns 200');
  const created = await createRes.json();
  assert(typeof created.id === 'string' && created.id.length > 0, 'created post has an id');
  assertEq(created.canDelete, true, 'created post payload carries canDelete=true (author view)');

  // ---- Brandon lists the wall — the new post must show canDelete=true ----
  const brandonListRes = await fetch('http://127.0.0.1:3096/api/walls/household/posts', {
    headers: { Cookie: brandonCookie },
  });
  assertEq(brandonListRes.status, 200, 'GET posts as author returns 200');
  const brandonList = await brandonListRes.json();
  const brandonView = (brandonList.posts || []).find((p) => p.id === created.id);
  assert(!!brandonView, 'author sees their own post in the listing');
  assertEq(brandonView.canDelete, true, 'author sees canDelete=true on their own post');

  // ---- Emily lists the same wall — non-author, non-admin -> canDelete=false ----
  const emilyListRes = await fetch('http://127.0.0.1:3096/api/walls/household/posts', {
    headers: { Cookie: emilyCookie },
  });
  assertEq(emilyListRes.status, 200, 'GET posts as emily returns 200');
  const emilyList = await emilyListRes.json();
  const emilyView = (emilyList.posts || []).find((p) => p.id === created.id);
  assert(!!emilyView, 'emily sees the brandon-authored post in the listing');
  assertEq(emilyView.canDelete, false, 'emily sees canDelete=false (non-author, non-admin)');
  assertEq(emilyView.text, '[PHA-2657] smoke test post', 'emily still sees the post body');

  // ---- Emily cannot delete brandon's post (gate enforced) ----
  const emilyDeleteRes = await fetch(`http://127.0.0.1:3096/api/walls/household/posts/${encodeURIComponent(created.id)}`, {
    method: 'DELETE',
    headers: { Cookie: emilyCookie },
  });
  assertEq(emilyDeleteRes.status, 403, 'emily cannot delete brandon post (403)');

  // ---- Brandon deletes his own post ----
  const brandonDeleteRes = await fetch(`http://127.0.0.1:3096/api/walls/household/posts/${encodeURIComponent(created.id)}`, {
    method: 'DELETE',
    headers: { Cookie: brandonCookie },
  });
  assertEq(brandonDeleteRes.status, 200, 'author DELETE returns 200');

  // ---- After delete, post is gone from both views ----
  const brandonListAfterRes = await fetch('http://127.0.0.1:3096/api/walls/household/posts', {
    headers: { Cookie: brandonCookie },
  });
  const brandonListAfter = await brandonListAfterRes.json();
  assert(!(brandonListAfter.posts || []).some((p) => p.id === created.id),
    'deleted post no longer in author listing');

  const emilyListAfterRes = await fetch('http://127.0.0.1:3096/api/walls/household/posts', {
    headers: { Cookie: emilyCookie },
  });
  const emilyListAfter = await emilyListAfterRes.json();
  assert(!(emilyListAfter.posts || []).some((p) => p.id === created.id),
    'deleted post no longer in emily listing');

  // ---- Second DELETE on the now-gone post returns 404 (idempotent fail) ----
  const reDeleteRes = await fetch(`http://127.0.0.1:3096/api/walls/household/posts/${encodeURIComponent(created.id)}`, {
    method: 'DELETE',
    headers: { Cookie: brandonCookie },
  });
  assertEq(reDeleteRes.status, 404, 'second DELETE on missing post returns 404');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
