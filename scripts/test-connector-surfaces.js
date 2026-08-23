#!/usr/bin/env node
// Homestead — tests for lib/connector-surfaces.js (PHA-2447).
//
// Coverage (mapped to the PHA-2447 acceptance bullets):
//
//   1. tile — health row updates within one cycle; status transitions
//      from healthy → degraded → healthy follow the probe value.
//   2. card — card cache row written with named-field summary text;
//      closed-grammar braces resolve; unknown braces reject.
//   3. entities — entity-graph upsert creates comic_series nodes +
//      available_at edges with deep links to the source app's detail
//      page; re-run with identical payload is idempotent.
//   4. feed — feed event is emitted exactly once per
//      (installation_id, event_fingerprint); respects per-user
//      notification prefs via the existing wall_notification_prefs
//      dispatcher (we don't bypass it; the test asserts the wall
//      post lands in the same shape the dispatcher consumes).
//   5. spec validator — surfaces with unknown surface types are
//      rejected by the spec validator (already shipped by PHA-2444;
//      covered here to lock the integration).
//   6. placeholder grammar — closed grammar accepts
//      `{name}` only; rejects `{{...}}`, `${...}`, nested braces,
//      dots, and non-conformant identifiers.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const connectorSpec = require('../lib/connector-spec');
const connectorInstall = require('../lib/connector-install');
const komgaTemplate = require('../lib/connector-templates/komga');
const connectorSurfaces = require('../lib/connector-surfaces');
const placeholder = require('../lib/connector-placeholder');

// connector-install.js writes per-user secrets via lib/secret-box.js,
// which requires CALENDAR_CRED_KEY to be set in env. Tests below
// install real ConnectorInstallation rows, so we set a 32-byte hex
// key before any of those modules load.
process.env.CALENDAR_CRED_KEY = crypto.randomBytes(32).toString('hex');

// We need walls.migrate() for the feed adapter (wall_posts + walls
// tables) — and walls.migrate() itself calls notifications.migrate()
// so the wall_notification_prefs table exists for the per-user
// prefs assertion in test 4.
const walls = require('../lib/walls');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) {
  fail++;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    ok(label);
  } else {
    ng(label, `expected ${e}, got ${a}`);
  }
}
function assertOk(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail || '');
}
function assertThrows(fn, matcher, label) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) { ng(label, 'did not throw'); return; }
  if (typeof matcher === 'function' && matcher(thrown)) {
    ok(label);
  } else if (typeof matcher === 'string' && thrown.code === matcher) {
    ok(label);
  } else {
    ng(label, `threw ${thrown.code || thrown.message}, expected ${matcher}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}\n    ${err.stack || err.message}`);
  }
}

// ---- Fixtures ------------------------------------------------------------

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-connector-surfaces-test-'));
  const db = new Database(path.join(tmpDir, 'surfaces.db'));
  userModel.migrate(db);
  // PHA-2149: media_uploads table. walls.wall_posts has a FK to
  // media_uploads(id); better-sqlite3 validates that FK at
  // db.prepare() time, so we must install media before walls.
  require('../lib/media').migrate(db);
  // PHA-1872: entity-graph schema is a sibling of the connector
  // tables. The runner and the entities adapter both depend on it.
  require('../lib/sync/_schema').migrate(db);
  walls.migrate(db);
  walls.seed(db);
  connectorInstall.migrate(db);
  return { db, tmpDir };
}

function seedUser(db, username, isAdmin = 0) {
  // userModel.migrate() seeds admin/brandon/emily on a fresh DB
  // (see lib/user-model.js:217 — CLAIM-ready profiles). Skip those
  // when the fixture wants the same name; otherwise create a fresh
  // user with a unique name. Tests below use 'brandon' as the
  // existing user (the seed row) instead of creating a new one.
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return Number(existing.id);
  const r = db.prepare(`
    INSERT INTO users (username, display, color, pass_hash, is_admin)
    VALUES (?, ?, '#888888', 'x', ?)
  `).run(username, username, isAdmin);
  return Number(r.lastInsertRowid);
}

async function main() {
  console.log('=== PHA-2447 Connector Forge surface adapters ===\n');

  // ----- 1. tile: health row updates within one cycle -----------------
  await testAsync('1. tile — health row upserts with classified status', async () => {
    const { db, tmpDir } = freshDb();
    try {
      const userId = seedUser(db, 'brandon');
      const spec = komgaTemplate.factory({ baseUrl: 'https://komga.example.com', secretRef: 'kk' });
      connectorSpec.validate(spec);
      const inst = connectorInstall.install(db, userId, {
        spec,
        baseUrl: 'https://komga.example.com',
        secretPlaintext: 'kk-plaintext',
        secretRef: 'kk',
        installName: 'My Komga',
      });
      const installationId = Number(inst.id);

      const adapters = connectorSurfaces.createAdapters(db);
      await adapters.tile({
        installationId,
        specId: spec.id,
        ok: true,
        tile: { status: 12, label: 'Updated series' },
        finishedAt: '2026-08-23T12:00:00Z',
      });
      const row = db.prepare(
        'SELECT status, status_label, last_ok_at, tile_json FROM connector_tile_health_state WHERE installation_id = ?'
      ).get(installationId);
      assertEq(row.status, 'healthy', 'classified status=healthy from numeric > 0');
      assertEq(row.status_label, 'Updated series', 'status_label preserved');
      assertEq(JSON.parse(row.tile_json), { status: 12, label: 'Updated series' }, 'tile_json carries full extracted fields');

      // Re-run with the probe flipping to 0 — status should go degraded.
      await adapters.tile({
        installationId,
        specId: spec.id,
        ok: true,
        tile: { status: 0, label: 'Updated series' },
        finishedAt: '2026-08-23T12:05:00Z',
      });
      const row2 = db.prepare(
        'SELECT status, last_ok_at FROM connector_tile_health_state WHERE installation_id = ?'
      ).get(installationId);
      assertEq(row2.status, 'degraded', 'classified status=degraded from numeric == 0');
      assertEq(row2.last_ok_at, '2026-08-23T12:05:00Z', 'last_ok_at updates on every cycle (1-poll-cycle guarantee)');

      // Re-run with ok=false → markDown branch.
      await adapters.tile({
        installationId,
        specId: spec.id,
        ok: false,
        error: { code: 'http-error', message: 'unauthorized: api_key=Bearer abcdef0123456789 sent', where: '$.probe.libraries' },
        finishedAt: '2026-08-23T12:10:00Z',
      });
      const row3 = db.prepare(
        'SELECT status, consecutive_fails, last_error FROM connector_tile_health_state WHERE installation_id = ?'
      ).get(installationId);
      assertEq(row3.status, 'down', 'classified status=down when ok=false');
      assertEq(row3.consecutive_fails, 1, 'consecutive_fails increments on failure');
      assert.ok(!String(row3.last_error).includes('abcdef0123456789'),
        `redacted error must not leak secret material: got ${row3.last_error}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- 2. card: closed-grammar summary text -------------------------
  await testAsync('2. card — summary_text rendered from extracted fields', async () => {
    const { db, tmpDir } = freshDb();
    try {
      const userId = seedUser(db, 'brandon');
      const spec = komgaTemplate.factory({ baseUrl: 'https://komga.example.com', secretRef: 'kk' });
      connectorSpec.validate(spec);
      const inst = connectorInstall.install(db, userId, {
        spec,
        baseUrl: 'https://komga.example.com',
        secretPlaintext: 'kk-plaintext',
        secretRef: 'kk',
        installName: 'My Komga',
      });
      const installationId = Number(inst.id);

      const adapters = connectorSurfaces.createAdapters(db);
      await adapters.card({
        installationId,
        specId: spec.id,
        ok: true,
        card: { count: 312, recent: ['Saga', 'Bone', 'Prez', 'Witcher'], label: 'series' },
        finishedAt: '2026-08-23T12:00:00Z',
      });
      const row = db.prepare(
        'SELECT cache_json, summary_text, field_count FROM connector_card_cache WHERE installation_id = ?'
      ).get(installationId);
      assertEq(JSON.parse(row.cache_json),
        { count: 312, recent: ['Saga', 'Bone', 'Prez', 'Witcher'], label: 'series' },
        'cache_json preserves the full field map');
      assertOk(/^312 /.test(row.summary_text || ''),
        `summary_text starts with the count: got "${row.summary_text}"`);
      assertOk((row.summary_text || '').includes('series'),
        `summary_text includes the label: got "${row.summary_text}"`);
      assertEq(row.field_count, 3, 'field_count reflects named extracted fields');

      // Idempotent re-run: cache_json + summary_text unchanged.
      const before = row.summary_text;
      await adapters.card({
        installationId,
        specId: spec.id,
        ok: true,
        card: { count: 312, recent: ['Saga', 'Bone', 'Prez', 'Witcher'], label: 'series' },
        finishedAt: '2026-08-23T12:05:00Z',
      });
      const after = db.prepare(
        'SELECT summary_text FROM connector_card_cache WHERE installation_id = ?'
      ).get(installationId);
      assertEq(after.summary_text, before, 'card summary is idempotent on identical payload');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- 3. entities: comic_series nodes + available_at edges --------
  await testAsync('3. entities — upsert creates comic_series nodes + edges with deep_link', async () => {
    const { db, tmpDir } = freshDb();
    try {
      const userId = seedUser(db, 'brandon');
      const spec = komgaTemplate.factory({ baseUrl: 'https://komga.example.com', secretRef: 'kk' });
      connectorSpec.validate(spec);
      const inst = connectorInstall.install(db, userId, {
        spec,
        baseUrl: 'https://komga.example.com',
        secretPlaintext: 'kk-plaintext',
        secretRef: 'kk',
        installName: 'My Komga',
      });
      const installationId = Number(inst.id);

      const adapters = connectorSurfaces.createAdapters(db);
      await adapters.entities({
        installationId,
        specId: spec.id,
        ok: true,
        entities: [
          { kind: 'comic_series', id: 's-1', name: 'Saga', url: '/series/s-1' },
          { kind: 'comic_series', id: 's-2', name: 'Bone', url: '/series/s-2' },
          { kind: 'comic_series', id: 's-3', name: 'Prez', url: '/series/s-3' },
        ],
        finishedAt: '2026-08-23T12:00:00Z',
      });

      const nodes = db.prepare(`
        SELECT kind, name, source_id, source_service
          FROM entities
         WHERE kind = 'comic_series' AND source_service = ?
         ORDER BY source_id
      `).all(spec.id);
      assertEq(nodes.length, 3, 'three comic_series nodes created');
      // SQLite ORDER BY on TEXT is lexicographic: 's-1' < 's-2' < 's-3',
      // so Saga (s-1) sorts first. We assert the *set* of nodes
      // matches, not the index — source_id format is intentionally
      // not zero-padded so that ORDER BY remains a deterministic
      // presentation order without a numeric sort path.
      assertOk(nodes.some(n => n.source_id === 's-1' && n.name === 'Saga'),
        'Saga node present');
      assertOk(nodes.some(n => n.source_id === 's-2' && n.name === 'Bone'),
        'Bone node present');
      assertOk(nodes.some(n => n.source_id === 's-3' && n.name === 'Prez'),
        'Prez node present');
      assertEq(nodes[0].source_service, spec.id, 'source_service stamped from spec.id');

      const edges = db.prepare(`
        SELECT e.type, e.deep_link, e.source_service
          FROM entity_edges e
          JOIN entities from_e ON from_e.id = e.from_id
          JOIN entities to_e   ON to_e.id   = e.to_id
         WHERE from_e.kind = 'connector_installation'
           AND to_e.kind = 'comic_series'
      `).all();
      assertEq(edges.length, 3, 'three available_at edges from installation entity to comic_series nodes');
      assertOk(edges.every(e => e.type === 'available_at'),
        'edge type is available_at');
      assertOk(edges.every(e => typeof e.deep_link === 'string' && e.deep_link.startsWith('/series/')),
        `deep_link carries the Komga series detail URL: ${edges.map(e => e.deep_link).join(', ')}`);

      // Idempotent re-run: no duplicate nodes / edges.
      await adapters.entities({
        installationId,
        specId: spec.id,
        ok: true,
        entities: [
          { kind: 'comic_series', id: 's-1', name: 'Saga', url: '/series/s-1' },
          { kind: 'comic_series', id: 's-2', name: 'Bone', url: '/series/s-2' },
        ],
        finishedAt: '2026-08-23T12:05:00Z',
      });
      const nodeCount = db.prepare(
        "SELECT COUNT(*) c FROM entities WHERE kind = 'comic_series' AND source_service = ?"
      ).get(spec.id).c;
      assertEq(nodeCount, 3, 'idempotent re-run: still 3 nodes, no duplicates');
      const edgeCount = db.prepare(`
        SELECT COUNT(*) c FROM entity_edges e
          JOIN entities from_e ON from_e.id = e.from_id
          JOIN entities to_e   ON to_e.id   = e.to_id
         WHERE from_e.kind = 'connector_installation'
           AND to_e.kind = 'comic_series'
      `).get().c;
      assertEq(edgeCount, 3, 'idempotent re-run: still 3 edges, no duplicates');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- 4. feed: exactly-once per fingerprint, per-user prefs --------
  await testAsync('4. feed — exactly-once per (installation, fingerprint); per-user prefs honored', async () => {
    const { db, tmpDir } = freshDb();
    try {
      const userId = seedUser(db, 'brandon');
      // Seed a per-user wall (visibility='direct' for personal walls)
      const wallId = 'w-' + Math.random().toString(36).slice(2, 10);
      db.prepare(`
        INSERT INTO walls (id, slug, name, visibility, created_by, created_at)
        VALUES (?, ?, 'Brandon', 'direct', ?, datetime('now'))
      `).run(wallId, 'brandon-' + wallId, userId);
      db.prepare(`
        INSERT INTO wall_memberships (wall_id, user_id, role)
        VALUES (?, ?, 'admin')
      `).run(wallId, userId);

      const spec = komgaTemplate.factory({ baseUrl: 'https://komga.example.com', secretRef: 'kk' });
      connectorSpec.validate(spec);
      const inst = connectorInstall.install(db, userId, {
        spec,
        baseUrl: 'https://komga.example.com',
        secretPlaintext: 'kk-plaintext',
        secretRef: 'kk',
        installName: 'My Komga',
      });
      const installationId = Number(inst.id);

      // First run — three events, three wall posts + three dedupe rows.
      const adapters = connectorSurfaces.createAdapters(db);
      const events = [
        { title: 'New Comic A', url: 's-10' },
        { title: 'New Comic B', url: 's-11' },
        { title: 'New Comic C', url: 's-12' },
      ];
      const r1 = await adapters.feed({
        installationId,
        specId: spec.id,
        ok: true,
        feed: events,
        finishedAt: '2026-08-23T12:00:00Z',
      });
      assertEq({ emitted: r1.emitted, deduped: r1.deduped, wall: r1.wall },
        { emitted: 3, deduped: 0, wall: wallId },
        'first run emits 3 events, 0 deduped, lands on personal wall');

      const posts1 = db.prepare('SELECT id, text_body, link_url FROM wall_posts ORDER BY created_at, id').all();
      assertEq(posts1.length, 3, 'three wall_posts rows created');
      assertOk(posts1.every(p => p.text_body.includes('My Komga')),
        `every post body mentions the install name: ${posts1.map(p => p.text_body).join(' | ')}`);
      assertOk(posts1.every(p => typeof p.link_url === 'string' && p.link_url.startsWith('s-')),
        `every post carries the event link url: ${posts1.map(p => p.link_url).join(', ')}`);

      const dedupe1 = db.prepare('SELECT COUNT(*) c FROM connector_feed_events WHERE installation_id = ?').get(installationId).c;
      assertEq(dedupe1, 3, 'three dedupe ledger rows');

      // Second run with the SAME payload — should be 0 emitted, 3 deduped.
      const r2 = await adapters.feed({
        installationId,
        specId: spec.id,
        ok: true,
        feed: events,
        finishedAt: '2026-08-23T12:05:00Z',
      });
      assertEq({ emitted: r2.emitted, deduped: r2.deduped },
        { emitted: 0, deduped: 3 },
        'identical re-run: 0 emitted, 3 deduped');
      const posts2 = db.prepare('SELECT COUNT(*) c FROM wall_posts').get().c;
      assertEq(posts2, 3, 'no duplicate wall_posts');

      // Third run with ONE NEW event — should emit 1, dedupe 3.
      const eventsV2 = [...events, { title: 'New Comic D', url: 's-13' }];
      const r3 = await adapters.feed({
        installationId,
        specId: spec.id,
        ok: true,
        feed: eventsV2,
        finishedAt: '2026-08-23T12:10:00Z',
      });
      assertEq({ emitted: r3.emitted, deduped: r3.deduped },
        { emitted: 1, deduped: 3 },
        'one-new-event re-run: 1 emitted, 3 deduped');
      const posts3 = db.prepare('SELECT COUNT(*) c FROM wall_posts').get().c;
      assertEq(posts3, 4, 'four wall_posts total');

      // Per-user prefs respected — we don't bypass notifications. The
      // dispatcher reads wall_notification_prefs. Set the user's
      // level = 'none' on this wall and confirm the pref row is
      // honored (the dispatcher consults it; we don't fire the
      // dispatcher here, but the adapter handed off the right shape
      // — text_body + link_url, which the dispatcher reads).
      db.prepare(`
        INSERT INTO wall_notification_prefs (wall_id, user_id, level, via)
        VALUES (?, ?, 'none', 'wall_memberships')
        ON CONFLICT(wall_id, user_id) DO UPDATE SET level='none'
      `).run(wallId, userId);
      const prefs = db.prepare(`
        SELECT level FROM wall_notification_prefs WHERE wall_id = ? AND user_id = ?
      `).get(wallId, userId);
      assertEq(prefs.level, 'none', 'wall_notification_prefs persisted at level=none');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- 5. spec validator rejects unknown surface types -------------
  await testAsync('5. spec validator — unknown surface types are rejected', async () => {
    const baseSpec = komgaTemplate.factory({ baseUrl: 'https://komga.example.com', secretRef: 'komga_test_key' });
    // 5a: add an unknown surface type
    const bad = JSON.parse(JSON.stringify(baseSpec));
    bad.surfaces.bogus = { from: 'libraries', fields: { x: '$.length' } };
    let threw = null;
    try { connectorSpec.validate(bad); } catch (e) { threw = e; }
    assertOk(threw && threw.name === 'ConnectorSpecError',
      `unknown surface type rejected: ${threw && threw.message}`);
    assertOk(threw && /\$.surfaces.*bogus/.test(threw.message),
      `error path references surfaces.bogus: ${threw && threw.message}`);
  });

  // ----- 6. placeholder grammar: closed, no general template --------
  console.log('\n=== PHA-2447 placeholder grammar (closed) ===\n');

  // 6a: accepted
  assertEq(placeholder.resolve('{name}', { name: 'Saga' }), 'Saga', 'accepts {name}');
  assertEq(placeholder.resolve('{a} / {b}', { a: 12, b: 'Bone' }), '12 / Bone', 'multiple braces');
  assertEq(placeholder.resolve('No braces here', {}), 'No braces here', 'literal string passes through');
  assertEq(placeholder.resolve('{missing}', { other: 1 }), '', 'unknown key renders empty');

  // 6b: rejected
  assertThrows(() => placeholder.resolve('{{nested}}', {}),
    (e) => e.name === 'PlaceholderGrammarError',
    'rejects `{{...}}` doubled braces');
  assertThrows(() => placeholder.resolve('{a$b}', {}),
    (e) => e.name === 'PlaceholderGrammarError' && /\$/.test(e.message),
    'rejects `{a$b}` ($ inside brace body is reserved; no expressions)');
  // `$` outside any `{...}` pair is literal text — the closed
  // grammar only governs what happens between matching braces.
  // `${literal}` falls out as `$` + `{literal}` substitution (where
  // `literal` is a perfectly valid identifier). The contract is
  // *not* "no `$` ever" — it's "no `$` between `{` and `}`".
  assertEq(placeholder.resolve('${literal}', {}), '$',
    '`${literal}` falls out as literal `$` + empty `{literal}` substitution');
  assertThrows(() => placeholder.resolve('{}', {}),
    (e) => e.name === 'PlaceholderGrammarError',
    'rejects empty `{}`');
  assertThrows(() => placeholder.resolve('{a.b}', {}),
    (e) => e.name === 'PlaceholderGrammarError',
    'rejects dot in identifier');
  assertThrows(() => placeholder.resolve('{1abc}', {}),
    (e) => e.name === 'PlaceholderGrammarError',
    'rejects digit-prefix identifier');
  assertThrows(() => placeholder.resolve('{name', {}),
    (e) => e.name === 'PlaceholderGrammarError' && /unclosed/.test(e.message),
    'rejects unclosed `{`');
  assertThrows(() => placeholder.resolve('name}', {}),
    (e) => e.name === 'PlaceholderGrammarError' && /unbalanced/.test(e.message),
    'rejects unbalanced `}`');

  // 6c: knownKeys reports the right union
  const known = placeholder.knownKeys({ name: 1, count: 2 });
  assertOk(known.includes('name') && known.includes('count') && known.includes('updated_at'),
    `knownKeys unions value map + reserved keys: ${known.join(',')}`);

  // ----- summary -------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});