#!/usr/bin/env node
// PHA-3206: `npm test` runner — discover and run every `scripts/test-*.js`
// and every `test/**/*.test.mjs` without manual `&&` chains in package.json.
//
// Replaces the 5,242-character `&&` chain in package.json's `"test"` script.
// Adding a new `scripts/test-foo.js` now runs on `npm test` with **zero**
// package.json edits — fixing the silent-skip class of regression that bit
// PHA-2883 (events route shipped 404 while `scripts/test-companion-cli.js`
// went green against a throwaway listener).
//
// Behavior parity with the old chain:
//   - Sequential (matches the `&&` semantics: stop at first failure).
//   - Each script gets the PHA-3200 bootstrap shim via `--require`.
//   - Pass/fail exit code matches the script's own `process.exit`.
//   - Prints the failing script name + exit code, then exits non-zero.
//
// New safety nets (none of which the old chain had):
//   - Empty glob is a hard failure (catches typos / wrong cwd / CI mismatch).
//   - Glob count sanity log line so a missing match is obvious in CI output.
//   - Per-script wall-clock timeout. A hanging script (e.g. one that opens
//     an HTTP listener and never closes it) is killed and counted as a
//     failure. The old chain had no timeout — a hang would burn the entire
//     6-hour CI window. Surfacing the hang as a failure is strictly better:
//     the script gets fixed (and stop-the-line applies, matching `&&`).
//   - MJS porch tests run last via `node --test test/porch/` after the JS
//     scripts complete; porch uses Node's built-in test runner.
//
// Hard limits:
//   - One runner for everything. Don't fork, don't add a second path.
//   - Don't change exit-code semantics — scripts decide pass/fail themselves.
//   - Don't touch the per-PHA test files. The point is to discover them.
//   - Don't try to "auto-exclude" hanging scripts. If a script needs to be
//     skipped, that's a separate fix (test bug, or environment gap), not
//     something the runner should paper over.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Per-script wall-clock cap. Tuned so the slowest currently-green test
// (test-companion-cli.js, ~30s end-to-end) has plenty of headroom, while
// a script that opens a listener and forgets to close it (the classic
// hang mode in this repo) trips within the first minute. Override via
// env if a single test genuinely needs more time.
const SCRIPT_TIMEOUT_MS = Number(process.env.PHA_3206_TEST_TIMEOUT_MS) || 120_000;

const repoRoot = path.resolve(__dirname, '..');
const scriptsDir = path.join(repoRoot, 'scripts');
const porchDir = path.join(repoRoot, 'test', 'porch');
const bootstrap = path.join(__dirname, '_test-bootstrap.js');

if (!fs.existsSync(bootstrap)) {
  console.error(`PHA-3206: bootstrap shim missing at ${bootstrap}`);
  process.exit(2);
}

// ----- Discover scripts/test-*.js (deterministic, sorted) -----------------

const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
const testFiles = entries
  .filter((e) => e.isFile() && /^test-.*\.js$/.test(e.name))
  .map((e) => path.join('scripts', e.name))
  .sort();

if (testFiles.length === 0) {
  console.error('PHA-3206: no scripts/test-*.js files matched. Aborting.');
  console.error('         cwd:', process.cwd());
  console.error('         scanned:', scriptsDir);
  process.exit(2);
}

// Floor guard: refuse to run if the glob drops below a known baseline.
// This catches typos in the glob pattern (which would silently pass with
// a 0-length match under naive shell expansion). Update this number when
// you intentionally retire a test file; the build will yell otherwise.
const MIN_EXPECTED = 50;
if (testFiles.length < MIN_EXPECTED) {
  console.error(
    `PHA-3206: glob matched ${testFiles.length} files, expected >= ${MIN_EXPECTED}. ` +
      'A test file probably moved or was deleted without updating this floor. ' +
      'If intentional, update MIN_EXPECTED in scripts/run-tests.js.'
  );
  process.exit(2);
}

console.log(`PHA-3206 runner: ${testFiles.length} scripts/test-*.js + porch tests`);

// ----- Run each script sequentially with the bootstrap shim ----------------

// runOne returns { status, killed, ms }. Uses spawn (not spawnSync) so we
// can enforce a wall-clock timeout on each script.
function runOne(rel) {
  const abs = path.join(repoRoot, rel);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--require', bootstrap, abs], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch (_) { /* already dead */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
      }, 5_000).unref();
    }, SCRIPT_TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      // Treat signals as a non-zero exit. Matches the script semantic
      // of "exit non-zero = fail".
      let status;
      if (signal) status = 128 + (signal === 'SIGKILL' ? 9 : 15);
      else status = code == null ? 1 : code;
      resolve({ status, killed, ms: Date.now() - t0 });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      console.error(`PHA-3206: spawn error for ${rel}: ${err.message}`);
      resolve({ status: 1, killed: false, ms: Date.now() - t0 });
    });
  });
}

async function main() {
  const t0 = Date.now();
  let failed = 0;

  for (const rel of testFiles) {
    console.log(`\n=== ${rel} ===`);
    const r = await runOne(rel);
    if (r.status !== 0) {
      failed += 1;
      if (r.killed) {
        console.error(
          `\nPHA-3206: ${rel} killed after ${SCRIPT_TIMEOUT_MS}ms wall-clock (hang or stuck I/O)`
        );
      } else {
        console.error(`\nPHA-3206: ${rel} exited with code ${r.status} in ${r.ms}ms`);
      }
      console.error('Aborting remaining tests (matches `&&` chain semantics).');
      break;
    }
  }

  if (failed > 0) {
    console.error(`\nPHA-3206: ${failed} test script(s) failed in ${Date.now() - t0}ms`);
    process.exit(1);
  }

  // ----- Run the node:test .mjs suite (porch) --------------------------------

  if (fs.existsSync(porchDir)) {
    const mjsFiles = fs
      .readdirSync(porchDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
      .map((e) => path.join('test', 'porch', e.name))
      .sort();

    if (mjsFiles.length > 0) {
      console.log(`\n=== porch (node --test, ${mjsFiles.length} files) ===`);
      // PHA-3206: pass --require so the PHA-3200 bootstrap shim
      // sets SESSION_SECRET / HOMESTEAD_INSECURE_TEST_COOKIES / NODE_ENV
      // before any test module imports server.js. Without it the
      // fail-closed loadSessionSecret throws "too short" on the porch
      // e2e-smoke.test.mjs because the test process inherits no env.
      const r = spawnSync(process.execPath, ['--require', bootstrap, '--test', ...mjsFiles], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
      if (r.status !== 0) {
        console.error(`\nPHA-3206: porch tests exited with code ${r.status}`);
        process.exit(1);
      }
    }
  }

  console.log(`\nPHA-3206: all tests passed in ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error('PHA-3206 runner crashed:', e && e.stack || e);
  process.exit(2);
});
