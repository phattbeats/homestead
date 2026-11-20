#!/usr/bin/env node
// PHA-4328: regressions for the bugs found while writing the devlog.
//
//   1. First-boot seed refuses a missing / placeholder / short ADMIN_PASSWORD.
//   2. Plex sync no longer stores X-Plex-Token in meta_json, and boot
//      migration scrubs rows that already carry it.
//   3. Calendar: rotated Graph tokens are persisted; stale sources are
//      re-synced by the background loop; recently failed sources wait.
//   4. HTTP: non-admins get /api/groups (no admin-only shadow route);
//      /api/events/merged carries the source display_name; the entity
//      API never returns a Plex token.
//
// Health-checker recovery is covered in scripts/test-health-checker.js.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(a, e, label) {
  const sa = JSON.stringify(a), se = JSON.stringify(e);
  if (sa === se) ok(label); else ng(label, `expected ${se}, got ${sa}`);
}

if (!process.env.CALENDAR_CRED_KEY) process.env.CALENDAR_CRED_KEY = crypto.randomBytes(32).toString('hex');

const userModel = require('../lib/user-model');
const schema = require('../lib/sync/_schema');
const plex = require('../lib/sync/plex');
const calendarSources = require('../lib/calendar-sources');
const { encryptString, decryptString } = require('../lib/secret-box');

function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = process.env[k]; if (over[k] == null) delete process.env[k]; else process.env[k] = over[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function seedThrows(env) {
  const db = new Database(':memory:');
  try { withEnv(env, () => userModel.migrate(db)); return null; }
  catch (e) { return e.message; }
  finally { db.close(); }
}

function req(port, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch (_) { /* */ }
        resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\n1. first-boot seed password guard');
  {
    const BASE = { BRANDON_PASSWORD: null, EMILY_PASSWORD: null };
    let m = seedThrows({ ...BASE, ADMIN_PASSWORD: null });
    assert(m && /ADMIN_PASSWORD is not set/.test(m), 'unset ADMIN_PASSWORD refuses to seed', m);
    m = seedThrows({ ...BASE, ADMIN_PASSWORD: 'changeme' });
    assert(m && /placeholder/.test(m), '"changeme" refuses to seed', m);
    m = seedThrows({ ...BASE, ADMIN_PASSWORD: 'short' });
    assert(m && /shorter than 8/.test(m), 'short password refuses to seed', m);
    m = seedThrows({ ...BASE, ADMIN_PASSWORD: 'a-real-password', BRANDON_PASSWORD: 'changeme' });
    assert(m && /BRANDON_PASSWORD/.test(m), 'placeholder BRANDON_PASSWORD refuses to seed', m);

    const db = new Database(':memory:');
    withEnv({ ...BASE, ADMIN_PASSWORD: 'a-real-password' }, () => userModel.migrate(db));
    const bcrypt = require('bcryptjs');
    const admin = db.prepare("SELECT pass_hash FROM users WHERE username='admin'").get();
    assert(admin && bcrypt.compareSync('a-real-password', admin.pass_hash), 'valid ADMIN_PASSWORD seeds admin');
    assert(!bcrypt.compareSync('changeme', admin.pass_hash), 'admin does not accept "changeme"');
    // Existing DB: guard is first-boot only, so a later unset env still boots.
    let threw = null;
    try { withEnv({ ...BASE, ADMIN_PASSWORD: null }, () => userModel.migrate(db)); } catch (e) { threw = e.message; }
    assertEq(threw, null, 'existing database boots without ADMIN_PASSWORD');
    db.close();
  }

  console.log('\n2. Plex token never stored in meta_json');
  {
    const meta = plex.workMeta({ title: 'Heat', year: 1995, thumb: '/library/metadata/1/thumb/9', art: '/library/metadata/1/art/9' }, 'http://plex.test:32400');
    assert(!JSON.stringify(meta).includes('X-Plex-Token'), 'workMeta has no token');
    assertEq([meta.thumb, meta.art], ['/library/metadata/1/thumb/9', '/library/metadata/1/art/9'], 'workMeta keeps image paths');

    const db = new Database(':memory:');
    schema.migrate(db);
    const leaky = { title: 'Heat', thumb: '/t', thumb_url: 'http://plex.test/t?X-Plex-Token=SECRET123', art_url: 'http://plex.test/a?X-Plex-Token=SECRET123' };
    db.prepare(`INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
      VALUES ('e1','work','Heat','heat',?,datetime('now'),datetime('now'),'plex','plex','1','heat')`).run(JSON.stringify(leaky));
    db.prepare(`INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
      VALUES ('e2','person','Al','al','{}',datetime('now'),datetime('now'),'plex','plex','2','al')`).run();
    db.prepare(`INSERT INTO entity_edges (id, from_id, to_id, type, source_service, meta_json, created_by, created_at, updated_at)
      VALUES ('x1','e1','e2','features','plex',?,'plex',datetime('now'),datetime('now'))`).run(JSON.stringify({ img: 'http://p/x?w=1&X-Plex-Token=SECRET123' }));
    schema.migrate(db); // boot migration
    const e = JSON.parse(db.prepare("SELECT meta_json FROM entities WHERE id='e1'").get().meta_json);
    assertEq(e, { title: 'Heat', thumb: '/t' }, 'entity meta scrubbed, other keys kept');
    const x = JSON.parse(db.prepare("SELECT meta_json FROM entity_edges WHERE id='x1'").get().meta_json);
    assertEq(x, { img: 'http://p/x?w=1' }, 'edge meta token stripped from URL');
    const fts = db.prepare("SELECT COUNT(*) c FROM entities_fts WHERE entities_fts MATCH 'SECRET123'").get().c;
    assertEq(fts, 0, 'FTS index no longer contains the token');
    db.close();
  }

  console.log('\n3. calendar: token persistence + background sync');
  {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    calendarSources.migrate(db);
    const blob = encryptString(JSON.stringify({ access_token: 'old', refresh_token: 'r-old', client_id: 'c' }));
    const id = db.prepare(`INSERT INTO calendar_sources (provider, account_id, calendar_id, cred_blob, display_name)
      VALUES ('ms365','me@x','cal1',?, 'Work')`).run(blob).lastInsertRowid;

    // Capture the deps the graph factory receives, then fire a refresh.
    let seenDeps = null;
    calendarSources.registerAdapter('graph', (config, deps) => {
      seenDeps = deps;
      return { listEvents: async () => [{ externalId: 'ev1', title: 'Standup', start: '2026-11-20T15:00:00Z' }] };
    });
    const row = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id);
    calendarSources.createAdapter(row, { db });
    assert(seenDeps && typeof seenDeps.onTokenRefresh === 'function', 'createAdapter({db}) wires onTokenRefresh');
    await seenDeps.onTokenRefresh({ access_token: 'new', refresh_token: 'r-new', expires_at: '2030-01-01T00:00:00Z' });
    const creds = JSON.parse(decryptString(db.prepare('SELECT cred_blob FROM calendar_sources WHERE id = ?').get(id).cred_blob));
    assertEq([creds.access_token, creds.refresh_token, creds.client_id], ['new', 'r-new', 'c'], 'rotated tokens persisted, other creds kept');

    let r = await calendarSources.syncStaleSources(db);
    assertEq(r, { synced: 1, failed: 0, skipped: 0 }, 'never-synced source is synced');
    assertEq(db.prepare('SELECT COUNT(*) c FROM calendar_event_cache').get().c, 1, 'event cached');
    r = await calendarSources.syncStaleSources(db);
    assertEq(r.skipped, 1, 'fresh source skipped');
    r = await calendarSources.syncStaleSources(db, {}, Date.now() + calendarSources.FRESHNESS_MS + 60000);
    assertEq(r.synced, 1, 'source older than 5 min re-synced');

    calendarSources.registerAdapter('graph', () => ({ listEvents: async () => { throw new Error('provider down'); } }));
    const later = Date.now() + 2 * (calendarSources.FRESHNESS_MS + 60000);
    r = await calendarSources.syncStaleSources(db, {}, later);
    assertEq(r.failed, 1, 'failing provider recorded as failed');
    assert(/provider down/.test(db.prepare('SELECT last_error FROM calendar_sources WHERE id = ?').get(id).last_error), 'last_error stamped');
    db.close();
  }

  console.log('\n4. HTTP: /api/groups for non-admins, merged display_name, entity API');
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-pha4328-'));
    process.env.DATA_DIR = dataDir;
    // Re-register the real graph adapter is unnecessary: no sync runs here.
    const app = require('../server.js');
    const db = app.db;
    const server = app.listen(0);
    await new Promise((res) => server.once('listening', res));
    const port = server.address().port;
    try {
      const login = await req(port, 'POST', '/api/login', { body: { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD } });
      assertEq(login.status, 200, 'brandon (non-admin) logs in');
      const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

      const g = await req(port, 'GET', '/api/groups', { cookie });
      assertEq(g.status, 200, 'non-admin GET /api/groups → 200');
      assert(Array.isArray(g.body && g.body.groups) && g.body.groups.some((x) => x.name === 'household'), 'groups list includes household');

      const blob = encryptString(JSON.stringify({ app_password: 'x' }));
      const sid = db.prepare(`INSERT INTO calendar_sources (provider, account_id, calendar_id, cred_blob, display_name, last_synced_at)
        VALUES ('caldav_nextcloud','b','cal',?, 'Family', datetime('now'))`).run(blob).lastInsertRowid;
      db.prepare(`INSERT INTO calendar_event_cache (source_id, external_id, title, start_at) VALUES (?, 'u1', 'Dinner', '2026-11-20T18:00:00Z')`).run(sid);
      const m = await req(port, 'GET', '/api/events/merged?from=2026-11-01&to=2026-11-30', { cookie });
      const ev = (m.body && m.body.events || []).find((e) => e.title === 'Dinner');
      assertEq(ev && ev.display_name, 'Family', 'merged provider event carries display_name');

      // Entity API: plant a legacy row and re-run the boot scrub.
      db.prepare(`INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
        VALUES ('w1','work','Heat','heat-1',?,datetime('now'),datetime('now'),'plex','plex','99','heat')`)
        .run(JSON.stringify({ thumb_url: 'http://p/t?X-Plex-Token=SECRET123' }));
      schema.migrate(db);
      const ent = await req(port, 'GET', '/api/entities/w1', { cookie });
      assert(ent.status === 200 && !ent.raw.includes('SECRET123'), 'entity API response has no Plex token', `${ent.status} ${ent.raw.slice(0, 200)}`);
    } finally {
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
