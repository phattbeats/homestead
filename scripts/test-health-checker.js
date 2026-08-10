#!/usr/bin/env node
// PHA-1623 acceptance tests for the v0.0.6 health checker.
//
// Drives `lib/health-checker.js` directly against a temp SQLite file.
// No HTTP server, no subprocess. The `fetch` implementation is
// stubbed so we can simulate 200 / 401 / 500 / timeout / conn-refused
// without binding any port.
//
// Each test runs migrate() on a fresh DB so they're independent.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const healthChecker = require('../lib/health-checker');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { ng_print(label, detail); }
function ng_print(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-health-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  // Minimal schema — services + service_health_state. We don't need
  // users / tasks / events for these tests.
  db.exec(`
    CREATE TABLE services (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT DEFAULT '🔗',
      descr TEXT DEFAULT '',
      sort INTEGER DEFAULT 0,
      owner TEXT DEFAULT 'all',
      open_mode TEXT DEFAULT 'frame',
      health_url TEXT DEFAULT NULL,
      health_interval_sec INTEGER NOT NULL DEFAULT 60
    );
    CREATE TABLE service_health_state (
      service_id INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_status_code INTEGER,
      last_checked_at TEXT,
      last_ok_at TEXT,
      down_since TEXT,
      consecutive_fails INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  return { db, tmpDir, dbPath };
}

function insertService(db, row) {
  const r = db.prepare(`INSERT INTO services
    (name, url, icon, descr, sort, owner, open_mode, health_url, health_interval_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.name, row.url, row.icon || '🔗', row.descr || '',
      row.sort || 1, row.owner || 'all', row.open_mode || 'frame',
      row.health_url || null, row.health_interval_sec || 60);
  return r.lastInsertRowid;
}

// Build a stub fetch that returns the provided sequence of
// {status, body?} or throws the provided error.
function stubFetch(behaviors) {
  let i = 0;
  return async (url, init) => {
    const b = behaviors[Math.min(i, behaviors.length - 1)];
    i++;
    if (b.throw) {
      const e = new Error(b.throw.message || 'failed');
      if (b.throw.name === 'AbortError') e.name = 'AbortError';
      throw e;
    }
    // Minimal Response-like object.
    return {
      status: b.status,
      url,
      async arrayBuffer() { return new ArrayBuffer(0); },
    };
  };
}

// ---- Tests ----

console.log('PHA-1623 health-checker tests\n');

// ---- Tests ----
// Wrap async tests in a single async runner so we can use top-level
// await without tripping Node's CJS/ESM ambiguity warning.
(async () => {

// Test 1: classifyStatus
console.log('Test 1: classifyStatus — auth walls are UP, server errors are DOWN');
{
  assertEq(healthChecker.classifyStatus(200), 'up', '200 → up');
  assertEq(healthChecker.classifyStatus(204), 'up', '204 → up');
  assertEq(healthChecker.classifyStatus(301), 'up', '301 → up');
  assertEq(healthChecker.classifyStatus(401), 'up', '401 → up (auth wall)');
  assertEq(healthChecker.classifyStatus(403), 'up', '403 → up (auth wall)');
  assertEq(healthChecker.classifyStatus(404), 'down', '404 → down');
  assertEq(healthChecker.classifyStatus(500), 'down', '500 → down');
  assertEq(healthChecker.classifyStatus(502), 'down', '502 → down');
  assertEq(healthChecker.classifyStatus(503), 'down', '503 → down');
}

// Test 2: clampInterval
console.log('\nTest 2: clampInterval — guards against 0 / negative / huge values');
{
  assertEq(healthChecker.clampInterval(0), 0, '0 → 0 (opt-out)');
  assertEq(healthChecker.clampInterval(-5), 0, 'negative → 0');
  assertEq(healthChecker.clampInterval(60), 60, '60 unchanged');
  assertEq(healthChecker.clampInterval(1), 5, '1 → 5 (min)');
  assertEq(healthChecker.clampInterval(2), 5, '2 → 5 (min)');
  assertEq(healthChecker.clampInterval(7200), 3600, '7200 → 3600 (max)');
}

// Test 3: nextState — UP
console.log('\nTest 3: nextState — UP path');
{
  const prev = null;
  const s = healthChecker.nextState(prev, { ok: true, code: 200, error: null });
  assertEq(s.status, 'up', 'unknown → up');
  assertEq(s.consecutive_fails, 0, 'consecutive_fails reset');
  assertEq(s.transitioned, false, 'no transition (was unknown)');
  assert(!!s.last_ok_at, 'last_ok_at stamped');
  assertEq(s.down_since, null, 'down_since null on first up');
}

// Test 4: nextState — single fail does NOT mark DOWN yet
console.log('\nTest 4: nextState — 1 fail = still up, 2 fails = DOWN');
{
  const up = healthChecker.nextState(null, { ok: true, code: 200 });
  const fail1 = healthChecker.nextState(up, { ok: false, code: 500, error: 'HTTP 500' });
  assertEq(fail1.status, 'up', 'still up after 1 fail');
  assertEq(fail1.consecutive_fails, 1, 'consecutive_fails=1');
  assertEq(fail1.transitioned, false, 'no transition yet');
  assertEq(fail1.down_since, null, 'down_since not stamped yet');

  const fail2 = healthChecker.nextState(fail1, { ok: false, code: 502, error: 'HTTP 502' });
  assertEq(fail2.status, 'down', 'DOWN after 2 consecutive fails');
  assertEq(fail2.consecutive_fails, 2, 'consecutive_fails=2');
  assertEq(fail2.transitioned, true, 'transitioned=true on up→down');
  assert(!!fail2.down_since, 'down_since stamped on transition');
}

// Test 5: nextState — recovery clears down_since
console.log('\nTest 5: nextState — UP after DOWN clears down_since');
{
  const down = { status: 'down', down_since: '2026-08-09T16:00:00.000Z', last_ok_at: null,
                 consecutive_fails: 2, last_status_code: 500, last_error: 'HTTP 500' };
  const up = healthChecker.nextState(down, { ok: true, code: 200 });
  assertEq(up.status, 'up', 'back to up');
  assertEq(up.down_since, null, 'down_since cleared');
  assertEq(up.transitioned, true, 'transitioned=true on down→up');
}

// Test 6: probe with a stub fetch — 200 fast
console.log('\nTest 6: probe — 200 fast');
{
  const fetchImpl = stubFetch([{ status: 200 }]);
  const r = await healthChecker.probe('http://example.test/', { fetchImpl, timeoutMs: 1000 });
  assertEq(r.ok, true, 'ok=true');
  assertEq(r.code, 200, 'code=200');
}

// Test 7: probe — 401 (auth wall) is UP
console.log('\nTest 7: probe — 401 is UP (auth wall)');
{
  const fetchImpl = stubFetch([{ status: 401 }]);
  const r = await healthChecker.probe('http://example.test/', { fetchImpl });
  assertEq(r.ok, true, '401 → ok=true');
}

// Test 8: probe — 500 is DOWN
console.log('\nTest 8: probe — 500 is DOWN');
{
  const fetchImpl = stubFetch([{ status: 500 }]);
  const r = await healthChecker.probe('http://example.test/', { fetchImpl });
  assertEq(r.ok, false, '500 → ok=false');
}

// Test 9: probe — timeout
console.log('\nTest 9: probe — timeout returns error');
{
  const fetchImpl = stubFetch([{ throw: { name: 'AbortError', message: 'aborted' } }]);
  const r = await healthChecker.probe('http://slow.test/', { fetchImpl, timeoutMs: 100 });
  assertEq(r.ok, false, 'timeout → ok=false');
  assert(r.error && /timeout/i.test(r.error), `error mentions timeout (got: ${r.error})`);
}

// Test 10: probe — HEAD 405 → fall back to GET 200
console.log('\nTest 10: probe — HEAD 405 → GET 200');
{
  const fetchImpl = stubFetch([{ status: 405 }, { status: 200 }]);
  const r = await healthChecker.probe('http://example.test/', { fetchImpl });
  assertEq(r.ok, true, 'HEAD 405 + GET 200 → ok');
  assertEq(r.code, 200, 'reported code=200');
}

// Test 11: end-to-end — start checker, two fails flip to DOWN, third recovers
console.log('\nTest 11: end-to-end — start checker + tick + persistence');
{
  const { db, tmpDir } = freshDb();
  const sid = insertService(db, { name: 'SillyTavern', url: 'http://st.test/', health_interval_sec: 60 });

  // First two ticks return 500, third returns 200.
  const fetchImpl = stubFetch([
    { status: 500 }, { status: 500 }, { status: 200 },
  ]);
  let transitions = [];
  const checker = healthChecker.start(db, {
    onDownTransition: ({ service, state }) => transitions.push({ kind: 'down', id: service.id, status: state.status }),
    log: () => {},
  }, { fetchImpl });

  try {
    // Manually tick 3 times. We bypass the interval timer so the
    // test is deterministic.
    await checker.tick(sid); // 1st: 500 (still up)
    let row = healthChecker.getState(db, sid);
    assertEq(row.status, 'up', 'tick 1: still up after first 500');
    assertEq(row.consecutive_fails, 1, 'tick 1: fails=1');

    await checker.tick(sid); // 2nd: 500 → DOWN
    row = healthChecker.getState(db, sid);
    assertEq(row.status, 'down', 'tick 2: DOWN after second 500');
    assertEq(row.consecutive_fails, 2, 'tick 2: fails=2');
    assert(!!row.down_since, 'tick 2: down_since stamped');
    assertEq(transitions.length, 1, 'one down transition recorded');
    assertEq(transitions[0].status, 'down', 'transition is down');

    await checker.tick(sid); // 3rd: 200 → UP
    row = healthChecker.getState(db, sid);
    assertEq(row.status, 'up', 'tick 3: UP after recovery');
    assertEq(row.consecutive_fails, 0, 'tick 3: fails reset');
    assertEq(row.down_since, null, 'tick 3: down_since cleared');
    assertEq(row.last_status_code, 200, 'tick 3: last_status_code=200');
  } finally {
    checker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Test 12: listAll returns sane shape
console.log('\nTest 12: listAll — joins services + state, defaults to unknown');
{
  const { db, tmpDir } = freshDb();
  insertService(db, { name: 'Plex', url: 'http://plex.test/' });
  insertService(db, { name: 'Sonarr', url: 'http://sonarr.test/' });
  const rows = healthChecker.listAll(db);
  assertEq(rows.length, 2, '2 services returned');
  assertEq(rows[0].status, 'unknown', 'no state yet → status=unknown');
  assertEq(rows[0].name, 'Plex', 'name preserved');
  assertEq(rows[0].consecutive_fails, 0, 'consecutive_fails defaults to 0');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 13: probeUrlFor — explicit health_url wins
console.log('\nTest 13: probeUrlFor — explicit health_url wins over url');
{
  assertEq(healthChecker.probeUrlFor({ url: 'http://tile.test/', health_url: 'http://health.test/' }),
           'http://health.test/', 'uses health_url');
  assertEq(healthChecker.probeUrlFor({ url: 'http://tile.test/', health_url: '  ' }),
           'http://tile.test/', 'whitespace health_url falls back to url');
  assertEq(healthChecker.probeUrlFor({ url: 'http://tile.test/', health_url: null }),
           'http://tile.test/', 'null health_url falls back to url');
}

// Test 14: probe — conn refused (TypeError)
console.log('\nTest 14: probe — conn refused returns ok=false');
{
  const fetchImpl = stubFetch([{ throw: { name: 'TypeError', message: 'fetch failed' } }]);
  const r = await healthChecker.probe('http://down.test/', { fetchImpl, timeoutMs: 1000 });
  assertEq(r.ok, false, 'conn refused → ok=false');
  assert(!!r.error, 'error captured');
}

// Test 15: refresh picks up new services
console.log('\nTest 15: start().refresh() picks up newly-inserted services');
{
  const { db, tmpDir } = freshDb();
  const fetchImpl = stubFetch([{ status: 200 }]);
  let log = [];
  const checker = healthChecker.start(db, { log: (...a) => log.push(a.join(' ')) }, { fetchImpl });
  try {
    insertService(db, { name: 'NewOne', url: 'http://new.test/' });
    checker.refresh();
    assert(log.some(l => /started; \d+ service timer/.test(l)), `refresh logged service count (logs: ${JSON.stringify(log)})`);
  } finally {
    checker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

})().catch(err => {
  console.error('test harness threw:', err);
  process.exit(2);
});
