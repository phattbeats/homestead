#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2219 acceptance tests for the install-coach pure helpers.
//
// The helpers under test (isInstalled, installPlatform,
// installCoachShouldPrompt, renderInstallChip) are inlined in
// public/index.html because Homestead has no build step. We extract
// them here by reading the HTML, parsing out the relevant function
// declarations, and exec'ing them inside a vm context with a
// fully-mocked navigator/window/Notification/Storage surface.
//
// What we test:
//   1. isInstalled() recognises iOS standalone, Android Chrome
//      standalone, and desktop fullscreen / minimal-ui display modes
//      and returns false for plain browser tab.
//   2. installPlatform() classifies iPhone, iPad (incl. iPadOS-on-Mac),
//      Android, desktop Chrome, and unknown correctly.
//   3. installCoachShouldPrompt() returns false when installed,
//      when dismissed, when prompted once already, when the platform
//      doesn't support install, or when Notification.permission is
//      already granted.
//   4. installCoachInstructions() returns a non-empty HTML string
//      with an <ol> for iOS and Android, and falls back to a
//      generic <p> for desktop/unknown.
//   5. The install_funnel_events server route accepts all closed-enum
//      steps and rejects an unknown step with 400.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

// Read index.html and extract the install-coach function block.
// We slice from the install-coach marker comment to the entity-graph
// marker comment (the next /\* ---- */ block in source order).
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function extractCoach() {
  const startMarker = '/* ---- PHA-2219: PWA install coach ----';
  const endMarker = '/* ---- PHA-1872: entity graph';
  const start = HTML.indexOf(startMarker);
  const end = HTML.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('install-coach block not found in index.html');
  return HTML.slice(start, end);
}

// Build a vm sandbox that mocks browser globals just enough for the
// install-coach helpers to evaluate. The DOM helpers (openSheet,
// closeSheet, $, #modal) are mocked so we don't crash on access.
function buildSandbox(opts) {
  const o = opts || {};
  const ls = o.ls || {};
  const notificationState = o.notification || 'default';
  const navigator = Object.assign({
    userAgent: o.ua || 'Mozilla/5.0 (Linux; Android 13)',
    platform: o.platform || 'Linux armv81',
    standalone: false,
    maxTouchPoints: 0,
  }, o.navigator || {});
  const sandbox = {
    navigator,
    window: {
      matchMedia(q) {
        return { matches: !!(o.matchMedia && o.matchMedia[q]), media: q };
      },
    },
    Notification: notificationState === 'none' ? undefined : { permission: notificationState },
    localStorage: {
      _data: Object.assign({}, ls),
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
    },
    document: { addEventListener() {}, visibilityState: 'visible' },
    setTimeout, clearTimeout,
    // DOM stubs for openSheet/closeSheet ($ shortcut + #sheet/#modal)
    $: () => null,
    openSheet: () => {},
    closeSheet: () => {},
    // funnelEmit posts to /api/funnel/install — stub the api() helper
    api: () => Promise.resolve({ ok: true }),
    // buildCoachInstructions reads installPlatform() which needs navigator; we let it use the sandbox navigator.
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

// eval the coach block in a fresh sandbox. Returns the sandbox
// (so the caller can assert against the captured LS state).
function evalCoach(opts) {
  const src = extractCoach();
  const sandbox = buildSandbox(opts);
  vm.runInContext(src, sandbox, { filename: 'install-coach-inline.js' });
  return sandbox;
}

console.log('PHA-2219 install-coach tests\n');

// ---- Test 1: isInstalled() recognizes iOS standalone ----
{
  console.log('Test 1: isInstalled() detects iOS Safari standalone (navigator.standalone=true)');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    navigator: { standalone: true, userAgent: '', platform: '' },
  });
  assert(s.isInstalled() === true, 'navigator.standalone=true → isInstalled=true');
}

// ---- Test 2: isInstalled() detects Android Chrome standalone ----
{
  console.log('\nTest 2: isInstalled() detects Android Chrome display-mode=standalone');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (Linux; Android 13)',
    platform: 'Linux armv81',
    matchMedia: { '(display-mode: standalone)': true },
  });
  assert(s.isInstalled() === true, 'display-mode:standalone → isInstalled=true');
}

// ---- Test 3: isInstalled() detects desktop fullscreen/minimal-ui ----
{
  console.log('\nTest 3: isInstalled() detects display-mode=fullscreen and minimal-ui');
  const s1 = evalCoach({ matchMedia: { '(display-mode: fullscreen)': true } });
  assert(s1.isInstalled() === true, 'display-mode:fullscreen → isInstalled=true');
  const s2 = evalCoach({ matchMedia: { '(display-mode: minimal-ui)': true } });
  assert(s2.isInstalled() === true, 'display-mode:minimal-ui → isInstalled=true');
}

// ---- Test 4: isInstalled() returns false in a normal browser tab ----
{
  console.log('\nTest 4: isInstalled() returns false in a normal browser tab');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
  });
  assert(s.isInstalled() === false, 'plain browser tab → isInstalled=false');
}

// ---- Test 5: installPlatform() classifies iPhone ----
{
  console.log('\nTest 5: installPlatform() classifies iPhone');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    platform: 'iPhone',
  });
  assertEq(s.installPlatform(), 'ios-safari', 'iPhone UA → ios-safari');
}

// ---- Test 6: installPlatform() classifies iPad (incl. iPadOS-on-Mac) ----
{
  console.log('\nTest 6: installPlatform() classifies iPad and iPadOS-on-Mac');
  const s1 = evalCoach({
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    platform: 'iPad',
  });
  assertEq(s1.installPlatform(), 'ios-safari', 'iPad UA → ios-safari');
  const s2 = evalCoach({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    platform: 'MacIntel',
    navigator: { maxTouchPoints: 5 },
  });
  assertEq(s2.installPlatform(), 'ios-safari', 'iPadOS-on-Mac (MacIntel + maxTouchPoints>1) → ios-safari');
}

// ---- Test 7: installPlatform() classifies Android ----
{
  console.log('\nTest 7: installPlatform() classifies Android');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-S908B)',
    platform: 'Linux armv81',
  });
  assertEq(s.installPlatform(), 'android-chrome', 'Android UA → android-chrome');
}

// ---- Test 8: installPlatform() classifies desktop Chrome ----
{
  console.log('\nTest 8: installPlatform() classifies desktop Chrome');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    platform: 'Linux x86_64',
  });
  assertEq(s.installPlatform(), 'desktop-chrome', 'desktop Chrome UA → desktop-chrome');
}

// ---- Test 9: installPlatform() classifies unknown ----
{
  console.log('\nTest 9: installPlatform() classifies unknown browsers as desktop-other');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    platform: 'Linux x86_64',
  });
  assertEq(s.installPlatform(), 'desktop-other', 'Firefox on Linux → desktop-other');
}

// ---- Test 10: installCoachShouldPrompt() respects the dismissed flag ----
{
  console.log('\nTest 10: installCoachShouldPrompt() respects the dismissed flag');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    ls: { 'homestead.installCoach.dismissed.v1': '1' },
  });
  assert(s.installCoachShouldPrompt() === false, 'dismissed=1 → no prompt');
}

// ---- Test 11: installCoachShouldPrompt() respects the legacy first-prompted flag ----
// PHA-2498 (UX batch #1): the eligibility gate honours the legacy
// `firstPrompted` localStorage key for users who already saw the coach
// under the old one-shot schedule — we don't want to re-fire the auto-
// prompt at them now that the schedule is "situated" instead of "first
// boot". The actual timing is driven by `maybeShowInstallCoach`, which
// sets up the second-session / first-action / 75s-dwell arms via the
// new `arms.v1` localStorage key.
{
  console.log('\nTest 11: installCoachShouldPrompt() respects the legacy first-prompted flag (PHA-2498 #1, backwards compat)');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    ls: { 'homestead.installCoach.firstPrompted.v1': '1' },
  });
  assert(s.installCoachShouldPrompt() === false, 'legacy first-prompted=1 → no auto-prompt on existing users');
}

// ---- Test 11a: arms structure (PHA-2498 #1, "situated" rule) ----
// The new eligibility-tracking structure is `homestead.installCoach.arms.v1`
// JSON. Schema: { count: number, firstActionAt: number|null, bootStartedAt:
// number|null }. `loadArms()` reads from LS with a safe default; `saveArms()`
// persists. The test asserts the round-trip through `localStorage` works
// and that the schema fields all exist.
{
  console.log('\nTest 11a: arms structure round-trip (PHA-2498 #1, situated rule)');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
  });
  assert(typeof s.loadArms === 'function', 'loadArms exported on the sandbox');
  assert(typeof s.saveArms === 'function', 'saveArms exported on the sandbox');
  const empty = s.loadArms();
  assertEq(empty.count, 0, 'fresh arms → count=0');
  assertEq(empty.firstActionAt, null, 'fresh arms → firstActionAt=null');
  assertEq(empty.bootStartedAt, null, 'fresh arms → bootStartedAt=null');
  s.saveArms({ count: 2, firstActionAt: 1700000000000, bootStartedAt: 1700000000000 });
  const round = s.loadArms();
  assertEq(round.count, 2, 'count persists');
  assertEq(round.firstActionAt, 1700000000000, 'firstActionAt persists');
}

// ---- Test 11b/11c: maybeShowInstallCoach arms but does NOT fire on first boot ----
// PHA-2498 (UX batch #1) closed the immediate-coach-on-first-login bug.
// `maybeShowInstallCoach()` schedules three arms (2nd-session,
// first-action, 75s-dwell). The tests assert:
//   (a) on the first boot, arms are persisted to localStorage but no
//       `openInstallCoach` call fires synchronously
//   (b) on the second boot (count pre-populated to 1), arms.count is
//       bumped to 2 and the second-session arm is scheduled (delayed
//       via setTimeout — not fired synchronously)
//
// Both checks live inside one async IIFE because the test harness is
// plain top-level code and we can't `return` at module scope.
(async () => {
  // Test 11b: first boot — arms but no synchronous fire.
  {
    console.log('\nTest 11b: maybeShowInstallCoach() does NOT auto-open on first boot (PHA-2498 #1)');
    const calls = [];
    const captured = {
      // NB: don't override userAgent or platform here — buildSandbox uses
      // `captured.ua` and `captured.platform` for those, and setting them
      // to empty in `captured.navigator` would break installPlatform()
      // (it would think the user is on an unknown platform and bail).
      navigator: { standalone: false },
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      notification: 'default',
    };
    const s = evalCoach(captured);
    s.openInstallCoach = (src) => { calls.push(src); };
    s.document = { addEventListener: () => {}, removeEventListener: () => {} };
    s.window = s.window || { matchMedia: () => ({ matches: false }) };
    await s.maybeShowInstallCoach();
    assertEq(calls.length, 0, 'first boot → no immediate openInstallCoach call (situated rule)');
    const lsAfter = s.localStorage._data || {};
    const armKey = 'homestead.installCoach.arms.v1';
    assert(lsAfter[armKey] !== undefined, 'arms localStorage key set on first boot');
    const parsed = JSON.parse(lsAfter[armKey] || '{}');
    assertEq(parsed.count, 1, 'after first boot, arms.count=1');
  }

  // Test 11c: second boot — count bumps to 2, second-session arm scheduled.
  {
    console.log('\nTest 11c: second-boot arms.count=2 → second-session arm scheduled (PHA-2498 #1)');
    const calls = [];
    const captured = {
      // NB: see Test 11b comment re userAgent/platform override.
      navigator: { standalone: false },
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      notification: 'default',
      ls: {
        'homestead.installCoach.arms.v1': JSON.stringify({ count: 1, firstActionAt: null, bootStartedAt: null }),
      },
    };
    const s = evalCoach(captured);
    s.openInstallCoach = (src) => { calls.push(src); };
    s.document = { addEventListener: () => {}, removeEventListener: () => {} };
    s.window = s.window || { matchMedia: () => ({ matches: false }) };
    await s.maybeShowInstallCoach();
    const parsed = JSON.parse(s.localStorage._data['homestead.installCoach.arms.v1'] || '{}');
    assertEq(parsed.count, 2, 'second boot → arms.count=2');
    // Delayed arms are scheduled via setTimeout — not fired synchronously.
    assertEq(calls.length, 0, 'second boot → second_session arm scheduled but not yet fired (delayed arm)');
  }
})();


{
  console.log('\nTest 12: installCoachShouldPrompt() returns false on platforms without install support');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    platform: 'Linux x86_64',
  });
  assert(s.installCoachShouldPrompt() === false, 'desktop-other → no auto-prompt (chip only)');
}

// ---- Test 13: installCoachShouldPrompt() returns false when notifications already granted ----
{
  console.log('\nTest 13: installCoachShouldPrompt() returns false when Notification.permission=granted');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    notification: 'granted',
  });
  assert(s.installCoachShouldPrompt() === false, 'permission=granted → no prompt');
}

// ---- Test 14: installCoachShouldPrompt() returns true for fresh iOS install ----
{
  console.log('\nTest 14: installCoachShouldPrompt() returns true for fresh iOS install');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    notification: 'default',
  });
  assert(s.installCoachShouldPrompt() === true, 'fresh iOS, no flags → prompt');
}

// ---- Test 15: installCoachShouldPrompt() returns false when already installed ----
{
  console.log('\nTest 15: installCoachShouldPrompt() returns false when isInstalled=true');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    notification: 'default',
    navigator: { standalone: true, userAgent: '', platform: '' },
  });
  assert(s.installCoachShouldPrompt() === false, 'isInstalled=true → no prompt (rule #5)');
}

// ---- Test 16: installCoachInstructions() returns platform-specific HTML ----
{
  console.log('\nTest 16: installCoachInstructions() returns platform-specific HTML');
  const s = evalCoach({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
  });
  const ios = s.installCoachInstructions('ios-safari');
  assert(ios.includes('<ol'), 'iOS card includes a numbered <ol>');
  assert(ios.includes('Share') || ios.includes('Home Screen'), 'iOS card mentions Share / Home Screen');
  const android = s.installCoachInstructions('android-chrome');
  assert(android.includes('<ol'), 'Android card includes a numbered <ol>');
  assert(android.includes('Install') || android.includes('install'), 'Android card mentions Install');
  const generic = s.installCoachInstructions('desktop-other');
  assert(generic.includes('<p'), 'desktop card is a <p>, no installable platform');
  assert(!generic.includes('<ol'), 'desktop card has no <ol>');
}

// ---- Test 17: install_funnel_events server route accepts closed-enum steps ----
{
  console.log('\nTest 17: install_funnel_events route accepts all closed-enum steps');
  (async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-funnel-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  process.env.ADMIN_PASSWORD = 'test';
  process.env.SESSION_SECRET = 'test-secret';
  const app = require('../server.js');

  // Boot a listener on a free port
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;

  // Login as admin
  const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test' }),
  });
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  // Walk every step in the closed enum
  const steps = [
    'prompt_shown', 'instructions_opened', 'dismissed', 'install_chip_tapped',
    'install_completed', 'permission_requested', 'permission_granted',
    'permission_denied', 'first_push_delivered',
  ];
  for (const step of steps) {
    const r = await fetch(`http://127.0.0.1:${port}/api/funnel/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ step, platform: 'ios-safari', meta: { source: 'unit-test' } }),
    });
    assertEq(r.status, 200, `POST /api/funnel/install step=${step} → 200`);
  }

  // Unknown step is rejected
  const r400 = await fetch(`http://127.0.0.1:${port}/api/funnel/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ step: 'clicked_a_button', platform: 'ios-safari' }),
  });
  assertEq(r400.status, 400, 'unknown step → 400');
  const r400Body = await r400.json();
  assert(r400Body && r400Body.error === 'invalid_step', 'unknown step body.error=invalid_step');
  assert(Array.isArray(r400Body.allowed) && r400Body.allowed.includes('prompt_shown'),
    'invalid_step response lists allowed steps');

  // Anonymous request is rejected
  const r401 = await fetch(`http://127.0.0.1:${port}/api/funnel/install`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 'prompt_shown' }),
  });
  assertEq(r401.status, 401, 'anonymous POST → 401');

  // Verify rows landed in the table
  const db = new Database(path.join(tmpDir, 'life.db'));
  const count = db.prepare('SELECT COUNT(*) AS n FROM install_funnel_events').get().n;
  assertEq(count, steps.length, `install_funnel_events has ${steps.length} rows`);
  const first = db.prepare('SELECT * FROM install_funnel_events WHERE step=?').get('prompt_shown');
  assert(!!first, 'prompt_shown row exists');
  assertEq(first.platform, 'ios-safari', 'platform column populated');
  assert(first.meta && JSON.parse(first.meta).source === 'unit-test', 'meta JSON parsed back');

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
  })();
}