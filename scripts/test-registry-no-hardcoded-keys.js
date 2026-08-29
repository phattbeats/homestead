#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2209 / PHA-2200.8 — Amendment 3 acceptance test:
// "No hardcoded module-key literals in render code outside the registry + migrations."
//
// Scans the repo for string literals matching the 6 registered
// built-in module keys ('wall', 'lists', 'calendar', 'chores',
// 'apps', 'agent') and fails the build if any are found in places
// where render/branch code SHOULD be reading from the registry
// instead.
//
// The audit pattern is intentionally conservative: this is a
// release-gate grep, not a stylistic lint. We classify matches
// into "real violation" vs "benign occurrence":
//
//   * Benign (NOT flagged):
//       - All matches inside `lib/modules.js`, `lib/registry-validate.js`,
//         `lib/user-model.js` (the registry + migrations + drift
//         detector).
//       - Comments (`//` or `/* */`) anywhere — doc strings naming
//         a module key are fine.
//       - JSON object property keys (`{wall: ...}` or `"wall": ...`
//         followed by `:`) — `welcome.html` reads `params.get('wall')`
//         where 'wall' is the URL param NAME for a wall_slug, not a
//         module key. `lib/snapshot.js` has `lists: {}` as a snapshot
//         envelope category.
//       - package.json `keywords` array — repo metadata.
//       - snapshot envelope category names ('lists' in
//         test-snapshot.js / smoke-snapshot.js's
//         `['overdue_tasks', 'upcoming', 'lists', 'activity_recent']`).
//
//   * Flagged (real violation):
//       - JS/HTML code that branches on a literal key string
//         instead of reading from the registry. Examples that
//         would fail this test: `if (mod === 'wall') { ... }`
//         outside the registry file; `data-module="'wall'"` on a
//         hardcoded DOM element; etc.
//
// Implementation: strip line + block comments before scanning,
// then apply the strict regex, then re-add the exclusions above
// as a final filter.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const KEYS = ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'];

// Strict regex: literal between matching quote boundaries.
const STRICT_KEY_RE = new RegExp(`(['"\`])(wall|lists|calendar|chores|apps|agent)\\1`, 'g');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'data', 'tmp', 'coverage',
  'homestead-data', 'homestead-cache', 'dist', 'build',
  '.cache', '.next', 'worktrees', 'verify-out',
]);

const EXCLUDE_FILES = new Set([
  // Source-of-truth + migrations + this audit script + related tests.
  'lib/modules.js',
  'lib/registry-validate.js',
  'lib/user-model.js',           // v3 migration carries the CHECK literal
  'scripts/test-modules.js',
  'scripts/test-modules-api.js',
  'scripts/test-user-modules.js',
  'scripts/test-registry-no-hardcoded-keys.js',
  // Sibling acceptance tests (PHA-2209) deliberately use literal keys
  // to assert against the registry; they are NOT render code.
  'scripts/test-modular-layout.js',
  'scripts/test-disable-reenable.js',
  'scripts/test-requires-cascade.js',
  'scripts/test-default-off-future.js',
  'scripts/test-shared-registry-third-party.js',
  // PHA-2205 layout-aware SPA smoke — drives the four-mode layout +
  // add-rooms sheet through specific module-key toggles. Same
  // pattern as the sibling tests above; literals are test config,
  // not render code.
  'scripts/smoke-modules-ui.js',
  'CHANGELOG.md',
  // PHA-2210 analytics-capture test: notification `category: 'wall'` is
  // test-row data (notification_log row fixture), not a render-time branch
  // against the module registry. Same pattern as the sibling acceptance tests.
  'scripts/test-analytics-capture.js',
  'package-lock.json',
  // PHA-2201 third-party apps: data writes with the 'apps' module key
  // (setUserModule calls to enable/disable the Apps tile after install/revoke).
  // These are NOT render-time branching — they pass the key as an argument
  // to a function whose contract requires it.
  'lib/app-install.js',
  // PHA-2232 third-party apps smoke test: asserts 'wall' is the default-enabled
  // built-in returned by GET /api/apps. Same category as snapshot envelope
  // categories — a "match by key" assertion, not a render branch.
  'scripts/smoke-apps-settings-ui.js',
  // PHA-2587 layout-route contract test: drives /api/me/modules/:key/enable
  // and /api/me/modules/:key/disable through the six module keys to assert
  // the layout API never advertises a 404 HTML route. Same pattern as the
  // sibling acceptance tests above — literals are test config, not render code.
  'scripts/test-2587-layout-route-contract.js',
  // PHA-2704 identity foundation tests: assert the new identity_links
  // schema (provider/issuer/provider_subject literals) and the local
  // credentials shape. Same pattern as the sibling acceptance tests.
  'scripts/test-2704-identity-foundation.js',
  'scripts/test-2704-identity-api.js',
  // PHA-2711 invite-signup tests: assert the public invite path uses
  // 'password' as the auth_provider and 'household' as the seed wall
  // slug. Same pattern as sibling acceptance tests — test fixtures,
  // not render branches.
  'scripts/test-2711-invite-signup.js',
  // PHA-2708 owner-recovery tests: assert the recovery primitive
  // strings ("owner_recovery_minted"/"owner_recovery_consumed"/
  // etc.) and the audit kind enum ("owner_recovery"). Same
  // pattern as the sibling acceptance tests — literals are test
  // config, not render code.
  'scripts/test-2708-owner-recovery.js',
  // PHA-2706 OIDC link tests: assert the oidc_link_states schema
  // (provider/issuer/handle literals) and the OIDC link lifecycle
  // (PKCE code_verifier, state, nonce, issuer subject). Same pattern
  // as the sibling acceptance tests — literals are test config, not
  // render code.
  'scripts/test-2706-oidc-link.js',
  'scripts/smoke-2706-oidc-link.js',
]);

const SCAN_EXTS = new Set([
  '.js', '.json', '.html', '.css', '.sh', '.py', '.ts',
]);

// Strip line + block comments. Replaces comments with same-length
// whitespace so line numbers are preserved (useful for error
// reporting if we ever surface it).
function stripComments(src) {
  // Block comments first (greedy across newlines).
  src = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  // Line comments.
  src = src.replace(/\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '));
  // HTML comments (PHA-2557): render code in HTML files lives next to
  // <!-- ... --> blocks that document the surrounding markup. The
  // audit's intent is to keep render code reading from the registry,
  // not to police docstrings — strip HTML comments too so a key
  // mentioned in a `<!-- PHA-2557: ... -->` block doesn't flag.
  src = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  return src;
}

// JSON files don't have JS comments — but their property keys are
// still benign. We detect property-key position by checking that
// the literal is followed (after optional whitespace) by `:`.
function isObjectKeyContext(src, matchIndex, matchLen) {
  // Look ahead past whitespace.
  const after = src.slice(matchIndex + matchLen).match(/^\s*:/);
  return !!after;
}

function isJsonPropertyKey(filename, src, matchIndex, matchLen) {
  if (!filename.endsWith('.json')) return false;
  return isObjectKeyContext(src, matchIndex, matchLen);
}

// Object-key in JS/HTML (less common but exists): `{wall: ...}` —
// we only flag in code contexts, but allow as object keys.
function isJsObjectKeyContext(src, matchIndex, matchLen) {
  return isObjectKeyContext(src, matchIndex, matchLen);
}

// Specific legitimate occurrences to allow-list (with file path
// + exact match-string). These are NOT violations of the
// "no-hardcoded-keys" principle — they're different namespaces.
//
// These were called out as side-findings in PHA-2203 PR #31 and
// should be revisited when PHA-2200.4 (SPA bootstrap) lands — the
// drawer stream-author namespace and the CalDAV XML element
// namespace are separate concerns from the module registry, but
// a future maintainer should not assume "'agent' = registry key"
// without checking.
const ALLOWED_LEGITIMATE = [
  // 'wall' as a URL param name in welcome.html (the wall_slug).
  { file: 'public/welcome.html', literal: "'wall'" },
  // 'lists' as snapshot envelope category in tests.
  { file: 'scripts/test-snapshot.js', literal: "'lists'" },
  { file: 'scripts/smoke-snapshot.js', literal: "'lists'" },
  // PHA-2586: SQLite schema assertion; this is the table namespace,
  // not a render-time module-key branch.
  { file: 'scripts/test-lists.js', literal: "'lists'" },
  // 'calendar' as a package.json keyword (repo metadata).
  { file: 'package.json', literal: '"calendar"' },
  // 'calendar' as a CalDAV XML element-name selector in
  // caldav-source.js (the CalDAV calendar-query REPORT uses
  // `<C:calendar>` as the element tag — this is XML namespace,
  // not a Homestead module key).
  { file: 'lib/caldav-source.js', literal: "'calendar'" },
  // 'agent' as the drawer stream-author in public/index.html
  // (`appendDrawerStreaming('agent')` — the drawer SSE channel
  // author is 'agent', a separate namespace from the registry
  // module-key 'agent'). Flagged for PHA-2200.4 to disambiguate.
  { file: 'public/index.html', literal: "'agent'" },
  // PHA-2586: 'lists' as a sqlite_master table-name lookup in
  // lib/snapshot.js (defensive `SELECT name FROM sqlite_master
  // WHERE name='lists'` gate — same pattern as the CalDAV XML
  // element allow-list above; the table name is a SQL identifier,
  // not a render-time module-key branch).
  { file: 'lib/snapshot.js', literal: "'lists'" },
];

function isAllowedLegitimate(file, match) {
  return ALLOWED_LEGITIMATE.some(a => a.file === file && a.literal === match);
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCAN_EXTS.has(ext)) acc.push(full);
    }
  }
  return acc;
}

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

console.log('PHA-2209 Amendment 3 — registry-no-hardcoded-keys audit\n');

const files = walk(REPO_ROOT, []);
ok(`scanned ${files.length} files under ${path.relative(process.cwd(), REPO_ROOT)}/`);

const offenders = [];
for (const full of files) {
  const rel = path.relative(REPO_ROOT, full);
  if (EXCLUDE_FILES.has(rel)) continue;
  let raw;
  try { raw = fs.readFileSync(full, 'utf8'); }
  catch (e) { continue; }
  // Strip comments before scanning — comments are NOT render code.
  const src = (rel.endsWith('.js') || rel.endsWith('.html') || rel.endsWith('.css') || rel.endsWith('.ts'))
    ? stripComments(raw)
    : raw;
  STRICT_KEY_RE.lastIndex = 0;
  let m;
  const fileHits = [];
  while ((m = STRICT_KEY_RE.exec(src)) !== null) {
    const matchStr = m[0];
    const matchIdx = m.index;
    // Object-key position (followed by `:`) — benign.
    if (isJsObjectKeyContext(src, matchIdx, matchStr.length)) continue;
    if (isJsonPropertyKey(rel, raw, matchIdx, matchStr.length)) continue;
    // Specific allow-list for known-benign occurrences.
    if (isAllowedLegitimate(rel, matchStr)) continue;
    fileHits.push({ idx: matchIdx, str: matchStr });
  }
  if (fileHits.length > 0) {
    offenders.push({ file: rel, hits: fileHits });
  }
}

if (offenders.length === 0) {
  ok('no hardcoded module-key literals in render code');
} else {
  console.log('  � hardcoded module-key literals found in render code:');
  for (const o of offenders) {
    const samples = o.hits.slice(0, 5).map(h => h.str).join(', ');
    console.log(`      ${o.file}: ${o.hits.length} hit(s) — sample: ${samples}`);
  }
  fail++;
}

// Sanity: registry + migrations exist.
assert(
  fs.existsSync(path.join(REPO_ROOT, 'lib/modules.js')),
  'lib/modules.js exists (registry source-of-truth)'
);
assert(
  fs.existsSync(path.join(REPO_ROOT, 'lib/user-model.js')),
  'lib/user-model.js exists (migrations + CHECK constraint)'
);
assert(
  fs.existsSync(path.join(REPO_ROOT, 'lib/registry-validate.js')),
  'lib/registry-validate.js exists (drift detector)'
);

// Sanity: every key is declared in lib/modules.js.
for (const k of KEYS) {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'lib/modules.js'), 'utf8');
  const re = new RegExp(`\\bkey:\\s*['"\`]${k}['"\`]`);
  assert(re.test(src), `lib/modules.js declares registry entry "${k}"`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
