#!/usr/bin/env node
// PHA-2201.2 (PHA-2230) smoke test: boot server.js on an ephemeral port
// and exercise the third-party app consent screen surface — that
// lib/scope-display.js is served to the browser at /lib/scope-display.js
// (the one file from lib/ that's public), that public/consent.html /
// consent.js wire up the design note §4 copy structure, and that the
// scope → phrase mapping used by the screen matches the accepted
// scopes[] vocabulary end to end.
//
// This doesn't drive a real browser (no build/test-runner DOM available
// here), so — same as scripts/smoke-porch-ui.js — it asserts the
// HTML/JS source the browser would load contains the markup/wiring the
// design note calls for, plus drives lib/scope-display.js directly for
// the data-shaping half (already covered in depth by
// scripts/test-scope-display.js; this file only checks the consent
// screen actually reaches for it).
//
// Run after `npm test`: node scripts/smoke-consent-ui.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-consent-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3101';
process.env.ADMIN_PASSWORD = 'smoke-consent-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-consent-brandon-pw';
process.env.SESSION_SECRET = 'smoke-consent-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3101, '127.0.0.1', () => { console.log('[smoke-consent] homestead on :3101'); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3101/api/health');
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  try {
    // ---- 1. Static assets exist and reference the right pieces. ----
    const htmlPath = path.join(__dirname, '..', 'public', 'consent.html');
    const jsPath = path.join(__dirname, '..', 'public', 'consent.js');
    const cssPath = path.join(__dirname, '..', 'public', 'consent.css');
    const libPath = path.join(__dirname, '..', 'lib', 'scope-display.js');
    assert(fs.existsSync(htmlPath), 'public/consent.html exists');
    assert(fs.existsSync(jsPath), 'public/consent.js exists');
    assert(fs.existsSync(cssPath), 'public/consent.css exists');
    assert(fs.existsSync(libPath), 'lib/scope-display.js exists');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    assert(html.includes('consent.css'), 'consent.html links consent.css');
    assert(html.includes('consent.js'), 'consent.html loads consent.js');
    assert(html.includes('/lib/scope-display.js'), 'consent.html loads the shared scope mapping from /lib/scope-display.js');
    assert(html.includes('id="appName"'), 'consent.html has a manifest name slot');
    assert(html.includes('id="appAuthorVersion"'), 'consent.html has an author/version slot');
    assert(html.includes('id="appDescription"'), 'consent.html has a description slot');
    assert(html.includes('id="willList"'), 'consent.html has a "will be able to" list');
    assert(html.includes('id="willNotList"'), 'consent.html has a "will NOT be able to" list');
    assert(html.includes('id="cancelBtn"'), 'consent.html has a Cancel button');
    assert(html.includes('id="installBtn"'), 'consent.html has an Install button');
    assert(!html.toLowerCase().includes('trust'), 'consent.html has no "I trust this author" checkbox copy (design note §4 exclusion)');
    assert(!html.includes('<pre') && !html.includes('JSON.stringify'), 'consent.html does not render raw manifest JSON (design note §4 exclusion)');

    assert(js.includes('window.ScopeDisplay'), 'consent.js reads the shared mapping off window.ScopeDisplay');
    assert(js.includes('renderConsentScreen'), 'consent.js exposes the reusable render function for PHA-2229 to call directly');
    assert(js.includes('See any other walls'), 'consent.js carries the verbatim §4 "will NOT" copy — other walls');
    assert(js.includes('private notes, lists, or calendar'), 'consent.js carries the verbatim §4 "will NOT" copy — private data');
    assert(js.includes('Act as you to other users'), 'consent.js carries the verbatim §4 "will NOT" copy — no impersonation');
    assert(js.includes('Run code inside Homestead'), 'consent.js carries the verbatim §4 "will NOT" copy — no code execution');
    assert(js.includes('Settings'), 'consent.js references the Settings → Apps revoke path from the §4 footer copy');
    assert(!js.includes('token_plaintext') && !js.includes('token_value'), 'consent.js never surfaces a token value (design note §4 exclusion)');

    // ---- 2. GET /consent.html and /lib/scope-display.js are actually served. ----
    let r = await fetch('http://127.0.0.1:3101/consent.html');
    assert(r.status === 200, 'GET /consent.html returns 200');
    let served = await r.text();
    assert(served.includes('consent.js'), 'served consent.html references consent.js');

    r = await fetch('http://127.0.0.1:3101/lib/scope-display.js');
    assert(r.status === 200, 'GET /lib/scope-display.js returns 200');
    const servedLib = await r.text();
    const onDisk = fs.readFileSync(libPath, 'utf8');
    assert(servedLib === onDisk, 'served /lib/scope-display.js matches lib/scope-display.js on disk (single source of truth)');
    assert((r.headers.get('content-type') || '').includes('javascript'), '/lib/scope-display.js is served with a JS content type');

    // Unknown non-/api paths fall through to the SPA catch-all
    // (index.html) — same behavior as any other unmapped path in this
    // app. What matters is that no OTHER lib/ file's actual source is
    // served: only /lib/scope-display.js gets an explicit route.
    r = await fetch('http://127.0.0.1:3101/lib/agent-tokens.js');
    const otherLibBody = await r.text();
    assert(!otherLibBody.includes('token_hash'), 'other lib/ files are NOT exposed to the browser (only scope-display.js has an explicit route)');

    // ---- 3. The mapping the consent screen depends on actually works,
    //         end to end, for a manifest shape matching §4's example. ----
    const scopeDisplay = require('../lib/scope-display');
    const scopes = ['read:me', 'read:walls', 'write:walls:post', 'write:votes'];
    const phrases = scopeDisplay.describeScopes(scopes, { entityKinds: ['movie', 'vote'] });
    assert(phrases.length === scopes.length, 'every scope in a realistic manifest maps to a phrase');
    assert(phrases.every((p) => typeof p === 'string' && p.length > 0), 'no empty phrases');
    assert(!phrases.some((p) => scopes.includes(p)), 'no phrase is just the raw scope string echoed back');
  } catch (err) {
    ng('unexpected error', err.stack || err.message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
