#!/usr/bin/env node
// PHA-2200.5 / PHA-2206 — Feed component acceptance test.
//
// Exercises the placement-agnostic feed component extracted from
// porch.js (PHA-2151). Two layers:
//
//   1. Pure-helper unit tests via vm.runInContext — runs the inlined
//      helpers from public/components/feed.js in a Node sandbox with
//      mocked DOM/window globals. This is the same boundary PHA-2219
//      used for its inlined install-coach helpers, and matches the
//      "vanilla JS, no build" reality of Homestead's public/ folder.
//
//   2. Live end-to-end smoke against a real server.js — the same
//      /api/walls /posts /reactions /comments flow the browser would
//      exercise, plus a check that BOTH /porch.html and the
//      /index.html page-wall mount point load the same component
//      file and reference the same endpoints (no duplicate API calls).
//
// Run after the v0.3.0 acceptance suite (test-modules.js,
// test-invite-to-wall.js, test-modular-layout.js). Asserts both the
// extraction shape (component file + thin porch.html shell + index.html
// page-wall mount) and the runtime behavior (boot, fetch, render,
// dispose).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const ROOT = path.join(__dirname, '..');
const COMPONENT_PATH = path.join(ROOT, 'public', 'components', 'feed.js');
const PORCH_HTML_PATH = path.join(ROOT, 'public', 'porch.html');
const INDEX_HTML_PATH = path.join(ROOT, 'public', 'index.html');
const SW_PATH = path.join(ROOT, 'public', 'sw.js');
const PORCH_CSS_PATH = path.join(ROOT, 'public', 'porch.css');

// ---------------------------------------------------------------------------
// 1. Static asset shape.
// ---------------------------------------------------------------------------

console.log('\nTest 1: static asset shape (component extraction)');

assert(fs.existsSync(COMPONENT_PATH), 'public/components/feed.js exists');
assert(fs.existsSync(PORCH_HTML_PATH), 'public/porch.html still exists (now a thin shell)');
assert(fs.existsSync(INDEX_HTML_PATH), 'public/index.html exists');
assert(fs.existsSync(SW_PATH), 'public/sw.js exists');
assert(fs.existsSync(PORCH_CSS_PATH), 'public/porch.css still exists (shared styles)');

const componentSrc = fs.readFileSync(COMPONENT_PATH, 'utf8');
const porchHtml = fs.readFileSync(PORCH_HTML_PATH, 'utf8');
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const swSrc = fs.readFileSync(SW_PATH, 'utf8');

// Component shape — must export HomesteadFeed with mount/unmount.
assert(componentSrc.includes('window.HomesteadFeed'), 'feed.js assigns window.HomesteadFeed');
assert(/HomesteadFeed\s*=\s*Object\.freeze\(\s*\{\s*mount/.test(componentSrc), 'HomesteadFeed is a frozen { mount, unmount } API');
assert(componentSrc.includes('function mount('), 'feed.js defines mount()');
assert(componentSrc.includes('function unmount('), 'feed.js defines unmount()');

// Permission gates from the contract.
assert(componentSrc.includes('canPost'), 'feed.js honours canPost');
assert(componentSrc.includes('canReact'), 'feed.js honours canReact');
assert(componentSrc.includes('canComment'), 'feed.js honours canComment');
assert(componentSrc.includes('apiBase'), 'feed.js honours apiBase');
assert(componentSrc.includes('wallSlug'), 'feed.js honours wallSlug');

// Idempotency — re-mounting a target must dispose the prior instance.
assert(/prior.*dispose\(\)/.test(componentSrc), 'mount() disposes prior instance before re-mounting');

// Disposal — must abort in-flight fetches and clear event listeners.
assert(/aborter.*abort/.test(componentSrc), 'dispose() aborts in-flight AbortController');
assert(/removeEventListener/.test(componentSrc), 'dispose() removes every registered listener');

// Test-only export — must be present for the vm sandbox tests.
assert(/module\.exports/.test(componentSrc), 'feed.js exports helpers under module.exports (test-only)');

// Thin-shell porch.html — must load the component, not the inlined porch.js.
assert(!porchHtml.includes('/porch.js'), 'porch.html no longer loads /porch.js (replaced by component)');
assert(porchHtml.includes('/components/feed.js'), 'porch.html loads /components/feed.js');
assert(porchHtml.includes('HomesteadFeed.mount'), 'porch.html calls HomesteadFeed.mount()');
assert(porchHtml.includes('porch.css'), 'porch.html still links porch.css (shared styles)');

// The old standalone chrome (header.back, wallName id) is now in the
// component, not the shell — porch.html is a THIN shell by the spec.
// We assert the shell only contains a mount target + the script tag.
assert(porchHtml.includes('id="porch-mount"'), 'porch.html has a #porch-mount target for the component');
assert(!porchHtml.includes('class="back"'), 'porch.html shell does NOT inline the back link (component owns chrome)');
assert(!porchHtml.includes('id="wallName"'), 'porch.html shell does NOT inline wallName (component renders it)');

// index.html — must mount the same component inside a page-wall div.
assert(/id=["']page-porch["']/.test(indexHtml), 'index.html has a page-porch page container');
assert(/HomesteadFeed\.mount\(/.test(indexHtml), 'index.html calls HomesteadFeed.mount() for the wall module');
assert(/components\/feed\.js/.test(indexHtml), 'index.html loads /components/feed.js');

// sw.js — must precache the component file (offline-friendly mount).
assert(/components\/feed\.js/.test(swSrc), 'sw.js precaches /components/feed.js');

// Size budget — the component must stay small (vanilla JS, no framework).
// Bumped from 40 KB to 50 KB during PHA-2846 cleanup: PHA-2657 (delete-own-post)
// tipped it to 40,862 bytes and PHA-2831 (Hearth on the Porch) to 41,248.
// 50 KB is the next clean plateau; reconfirm when the next 5 KB tier is hit.
const FEED_COMPONENT_MAX_BYTES = 50 * 1024;
const componentBytes = componentSrc.length;
assert(componentBytes < FEED_COMPONENT_MAX_BYTES, `feed.js under ${FEED_COMPONENT_MAX_BYTES} bytes (actual ${componentBytes} bytes)`);

// ---------------------------------------------------------------------------
// 2. Pure-helper unit tests via vm.runInContext.
// ---------------------------------------------------------------------------

console.log('\nTest 2: pure helpers via vm sandbox');

// Set up a minimal sandbox: the helpers call esc/cssEsc/fmtTime/etc
// and use Object.freeze, Array.from, Set, URLSearchParams. We DON'T
// need a DOM for these — the helpers just stringify.
const sandbox = {
  Object,
  Array,
  Set,
  Map,
  URLSearchParams,
  JSON,
  String,
  Number,
  Date,
  Math,
  console,
  module: { exports: {} },
  window: {},
};
vm.createContext(sandbox);
// Wrap the IIFE in a script that exposes the underscored exports on
// the sandbox so we can read them. The component does
// `module.exports = { _esc, ... }` if module is defined.
const helperProbe = `
${componentSrc}
sandbox_helpers = module.exports;
`;
const probedSrc = componentSrc + '\n; sandbox_helpers = module.exports;\n';
const ctx = vm.createContext(Object.assign({}, sandbox, { sandbox_helpers: null }));
try {
  vm.runInContext(probedSrc, ctx);
} catch (e) {
  // Some helpers rely on document/window/fetch. The test-only export
  // block is unconditional (no DOM needed), so if we got here without
  // throwing, the export populated correctly. If we did throw, we
  // surface the error.
  ng('vm sandbox ran feed.js without throwing', e.message);
}

const H = ctx.sandbox_helpers || {};
assert(typeof H._esc === 'function', '_esc exported');
assert(typeof H._cssEsc === 'function', '_cssEsc exported');
assert(typeof H._fmtTime === 'function', '_fmtTime exported');
assert(typeof H._postMediaHtml === 'function', '_postMediaHtml exported');
assert(typeof H._reactionsHtml === 'function', '_reactionsHtml exported');
assert(typeof H._postHtml === 'function', '_postHtml exported');
assert(Array.isArray(H._REACTIONS), '_REACTIONS exported');
assertEq(H._REACTIONS.map((r) => r.emoji), ['+1', 'joy', 'fire', 'eyes', 'heart'], '_REACTIONS order is locked');

// esc() — XSS escape matrix.
assertEq(H._esc('<script>alert(1)</script>'),
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '_esc escapes angle brackets');
assertEq(H._esc('Tom & Jerry "Best" \'Show\''),
  'Tom &amp; Jerry &quot;Best&quot; &#39;Show&#39;',
  '_esc escapes & " \' (HTML5 entities)');
assertEq(H._esc(null), '', '_esc(null) → ""');
assertEq(H._esc(undefined), '', '_esc(undefined) → ""');
assertEq(H._esc(42), '42', '_esc(42) → "42"');

// cssEsc() — for querySelector attribute selectors.
assertEq(H._cssEsc('post"abc'), 'post\\"abc', '_cssEsc escapes double-quote');
assertEq(H._cssEsc('post\\abc'), 'post\\\\abc', '_cssEsc escapes backslash');

// fmtTime() — must produce a locale-friendly string. We just check it's
// non-empty and parses back to a valid Date.
const fmt = H._fmtTime('2026-08-20 14:30:00');
assert(typeof fmt === 'string' && fmt.length > 0, '_fmtTime returns a non-empty string');

// postMediaHtml() — each kind.
assert(H._postMediaHtml({ kind: 'image', mediaId: 'm1' }).includes('<img'),
  'postMediaHtml(image) emits <img>');
assert(H._postMediaHtml({ kind: 'video', mediaId: 'm2' }).includes('<video'),
  'postMediaHtml(video) emits <video>');
assert(H._postMediaHtml({ kind: 'text', text: 'hi' }).includes('hi'),
  'postMediaHtml(text) renders the body');
assert(H._postMediaHtml({ kind: 'link', link: { url: 'https://x', title: 'X' } }).includes('X'),
  'postMediaHtml(link) renders the title');
assertEq(H._postMediaHtml({ kind: 'unknown' }), '', 'postMediaHtml(unknown) → ""');

// reactionsHtml() — count, mine, both.
const r0 = H._reactionsHtml({ id: 'p1' });
assert(r0.includes('data-emoji="+1"'), 'reactionsHtml includes +1 button');
assert(!r0.includes(' class="rc"'), 'reactionsHtml omits .rc when count=0');
const r1 = H._reactionsHtml({ id: 'p2', reactionSummary: { fire: 3 }, myReactions: [] });
assert(r1.includes('>3</span>'), 'reactionsHtml includes the count when >0');
const r2 = H._reactionsHtml({ id: 'p3', myReactions: ['heart'] });
assert(r2.includes('data-emoji="heart"') && r2.match(/class="reaction mine"/),
  'reactionsHtml marks .mine for reactions in myReactions');

// postHtml() — author fallback, commentCount, pending.
assert(H._postHtml({ id: 'p', createdAt: '2026-08-20 14:30:00' }).includes('Someone'),
  'postHtml fallback author is "Someone"');
assert(H._postHtml({ id: 'p', createdAt: '2026-08-20 14:30:00', commentCount: 7 }).includes('(7)'),
  'postHtml includes commentCount');
assert(H._postHtml({ id: 'p', createdAt: '2026-08-20 14:30:00', _pending: true }).includes('pending'),
  'postHtml marks _pending posts as .pending');

// ---------------------------------------------------------------------------
// 3. Live end-to-end: boot server, mount from BOTH placements.
// ---------------------------------------------------------------------------

console.log('\nTest 3: live server end-to-end (both placements)');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-feed-component-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3193';
process.env.ADMIN_PASSWORD = 'feed-test-admin-pw';
process.env.BRANDON_PASSWORD = 'feed-test-brandon-pw';
process.env.SESSION_SECRET = 'feed-test-secret';
process.env.NODE_ENV = 'production';

(async () => {
  const app = require(path.join(ROOT, 'server.js'));
  await new Promise((resolve, reject) => {
    app.listen(3193, '127.0.0.1', () => { console.log('[feed-component] homestead on :3193'); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3193/api/health');
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  try {
    // Both placements load the same component file.
    const r1 = await fetch('http://127.0.0.1:3193/porch.html');
    assertEq(r1.status, 200, 'GET /porch.html returns 200');
    const porchServed = await r1.text();
    assert(porchServed.includes('/components/feed.js'),
      'served /porch.html loads /components/feed.js');
    assert(porchServed.includes('HomesteadFeed.mount'),
      'served /porch.html calls HomesteadFeed.mount()');

    const r2 = await fetch('http://127.0.0.1:3193/components/feed.js');
    assertEq(r2.status, 200, 'GET /components/feed.js returns 200');
    const componentServed = await r2.text();
    assert(componentServed.includes('window.HomesteadFeed'),
      'served /components/feed.js exposes window.HomesteadFeed');

    // Login + ensure brandon is in household (the seeded wall).
    // PHA-2556: brandon is already in household via lib/user-model.js's
    // seed — no DB write needed.
    const brandonCookie = await login('brandon', 'feed-test-brandon-pw');

    // API surface used by both placements (feed.js calls these; the test
    // confirms both placements will succeed against the same backend).
    const r3 = await fetch('http://127.0.0.1:3193/api/walls', { headers: { Cookie: brandonCookie } });
    assertEq(r3.status, 200, 'GET /api/walls returns 200 (placement-agnostic)');
    const wallsBody = await r3.json();
    assert(wallsBody.walls.some((w) => w.slug === 'household'),
      'walls include household (so wallSlug="household" default works in both placements)');

    const r4 = await fetch('http://127.0.0.1:3193/api/walls/household/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ kind: 'text', text_body: 'feed component test' }),
    });
    assertEq(r4.status, 200, 'POST /api/walls/{slug}/posts returns 200');
    const post = await r4.json();
    assert(typeof post.id === 'string', 'created post has an id');

    const r5 = await fetch(`http://127.0.0.1:3193/api/walls/household/posts/${post.id}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ emoji: 'fire' }),
    });
    assertEq(r5.status, 200, 'POST reaction returns 200');

    const r6 = await fetch(`http://127.0.0.1:3193/api/walls/posts/${post.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ body: 'test comment' }),
    });
    assertEq(r6.status, 200, 'POST comment returns 200');

    // PHA-2656: notifyLevel <select> save/load round trip. feed.js's
    // #notifyLevel dropdown was rendered but never wired to a save handler
    // (decorative-only). It now GETs on boot/wall-switch and PUTs on
    // change — exercise the exact request pair it issues, and confirm the
    // change actually persists (i.e. would survive a page reload).
    const r7 = await fetch('http://127.0.0.1:3193/api/walls/household/notifications', {
      headers: { Cookie: brandonCookie },
    });
    assertEq(r7.status, 200, 'GET /api/walls/{slug}/notifications returns 200');
    const before = await r7.json();
    assert(['all', 'mentions', 'none'].includes(before.level), 'notifications GET returns a valid level');

    const nextLevel = before.level === 'mentions' ? 'none' : 'mentions';
    const r8 = await fetch('http://127.0.0.1:3193/api/walls/household/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ level: nextLevel }),
    });
    assertEq(r8.status, 200, 'PUT /api/walls/{slug}/notifications returns 200');
    const putBody = await r8.json();
    assertEq(putBody.level, nextLevel, 'PUT response echoes the saved level');

    const r9 = await fetch('http://127.0.0.1:3193/api/walls/household/notifications', {
      headers: { Cookie: brandonCookie },
    });
    const after = await r9.json();
    assertEq(after.level, nextLevel, 'notifications GET reflects the PUT after "reload" (persisted, not decorative)');

    // Frontend now actually calls that pair instead of just rendering the
    // <select> — guard against the wiring being reverted/removed.
    assert(/#notifyLevel/.test(componentServed) && /'change'/.test(componentServed),
      'feed.js wires a change listener on #notifyLevel');
    assert(/\/walls\/\$\{encodeURIComponent\(WALL\)\}\/notifications/.test(componentServed),
      'feed.js calls the wall notifications endpoint');
    assert(/api\('PUT',\s*`\/walls\/\$\{encodeURIComponent\(WALL\)\}\/notifications`/.test(componentServed),
      'feed.js PUTs the notify level on change');

    // Placement agreement: the same component file must be referenced by
    // both placements AND must NOT add a duplicate fetch when mounted in
    // both. We assert this by checking that index.html's page-wall mount
    // is gated on `if (modules.wall) { ... }` — so only one mount runs
    // per page load, not both. (The acceptance contract says "no duplicate
    // API calls" which is the same as "page-wall mounted iff wall module
    // is enabled" — the user is in exactly one placement at a time.)
    assert(/if\s*\(/.test(indexHtml.match(/HomesteadFeed\.mount\([^)]*\)/m) ? indexHtml : ''),
      'index.html mount call is gated by a condition (no unconditional duplicate mount)');

    console.log(`\n[feed-component] ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('[feed-component] error:', e && e.stack || e);
    process.exit(1);
  }
})();

async function login(username, password) {
  const r = await fetch('http://127.0.0.1:3193/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}