#!/usr/bin/env node
// PHA-2659 acceptance tests — The Homestead Gazette.
//
// Covers the four things the design note (docs/GAZETTE-DESIGN.md) says
// this issue has to prove:
//
//   1. Gazette is a MODULE, not an agent-drawer perk: its own registry
//      key, its own user_modules row, `requires` on the harness module,
//      and the existing dependents_active cascade catching the edge.
//   2. The `user_modules` CHECK-constraint rebuild actually widens a
//      pre-existing DB and preserves its rows.
//   3. `open_mode: 'sheet'` reaches the SPA through the layout payload
//      without inventing a nav room.
//   4. The thin-edition rule holds in both directions — empty slices
//      are never offered to the harness, and a harness that invents a
//      section from an empty slice gets it dropped.
//
// Test 7 drives the whole route end-to-end against a FAKE provider
// (a local SSE server pointed at by HEARTH_LITELLM_URL), so the
// generate -> parse -> cache -> serve path is exercised for real
// rather than stubbed at the seam.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-gazette-'));
const FAKE_PROVIDER_PORT = 3197;
const PORT = 3196;

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'gazette-test-pw';
process.env.BRANDON_PASSWORD = 'gazette-test-pw';
process.env.SESSION_SECRET = 'gazette-test-secret';
process.env.NODE_ENV = 'production';
// Point the harness at the fake provider below rather than any real one.
process.env.HEARTH_PROVIDER = 'litellm';
process.env.HEARTH_LITELLM_URL = `http://127.0.0.1:${FAKE_PROVIDER_PORT}`;
process.env.HEARTH_LITELLM_KEY = 'fake-key-for-tests';
process.env.HEARTH_LITELLM_MODEL = 'fake-model';

const modules = require('../lib/modules');
const userModel = require('../lib/user-model');
const gazette = require('../lib/gazette');
const agentRuntime = require('../lib/agent-runtime');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

// What the fake provider will stream back. Mutable so tests can swap
// the harness's "output" between requests.
let FAKE_COMPLETION = '';
let fakeRequests = [];

function startFakeProvider() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        fakeRequests.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // One content delta, then a stop chunk — the minimal
        // OpenAI-compatible shape lib/agent-runtime.js consumes.
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FAKE_COMPLETION }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end();
      });
    });
    srv.listen(FAKE_PROVIDER_PORT, '127.0.0.1', () => resolve(srv));
  });
}

const HEAD = { 'x-authentik-username': 'brandon', 'x-authentik-groups': 'household' };
const GET = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: HEAD });
const POST = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST',
  headers: { ...HEAD, 'content-type': 'application/json' },
  body: JSON.stringify(body === undefined ? {} : body),
});

console.log('PHA-2659 Gazette tests\n');

// -----------------------------------------------------------------------------
// 1. Registry entry
// -----------------------------------------------------------------------------
{
  console.log('Test 1: gazette is a first-class registry module');
  const g = modules.getModule('gazette');
  assert(!!g, 'gazette is registered');
  assertEq(g.open_mode, 'sheet', "open_mode === 'sheet'");
  assertEq(g.room, null, 'room === null (claims no nav tab)');
  // PHA-2853 rework widened this: the typed issue pipeline reads wall
  // activity and merged calendar events directly, so those became hard
  // dependencies alongside the harness.
  assertEq(g.requires, ['agent', 'wall', 'calendar'], "requires === ['agent','wall','calendar']");
  assertEq(g.default_enabled, false, 'default_enabled === false');
  assert(modules.isModuleKey('gazette'), 'isModuleKey("gazette") === true');
  // The registry is the intake path for the DB whitelist too.
  assert(userModel.USER_MODULE_KEYS.includes('gazette'),
    'userModel.USER_MODULE_KEYS includes gazette (CHECK derives from registry)');
}

// -----------------------------------------------------------------------------
// 2. computeLayout surfaces sheet modules without giving them a room
// -----------------------------------------------------------------------------
{
  console.log('\nTest 2: computeLayout emits sheets[] for open_mode sheet');
  const without = modules.computeLayout(['wall', 'agent']);
  assertEq(without.sheets, [], 'gazette disabled → sheets === []');

  const with_ = modules.computeLayout(['wall', 'agent', 'gazette']);
  assertEq(with_.sheets.map(s => s.key), ['gazette'], 'gazette enabled → sheets === [gazette]');
  assert(with_.sheets[0].label === 'Gazette' && typeof with_.sheets[0].icon === 'string',
    'sheet entry carries label + icon for the launcher');
  // A sheet module must never claim a nav room, or applyLayout would
  // try to enable a nav button and page div that don't exist.
  const tile = with_.tabs.find(t => t.key === 'gazette');
  assert(tile && tile.room === null, 'gazette tile carries room === null');
  assertEq(with_.agentDrawer, true, 'agentDrawer still true (sheets are additive)');
}

// -----------------------------------------------------------------------------
// 3. The user_modules CHECK-constraint rebuild
// -----------------------------------------------------------------------------
{
  console.log('\nTest 3: migrate() rebuilds a pre-PHA-2659 user_modules CHECK');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-gz-mig-'));
  const db = new Database(path.join(dir, 'life.db'));

  // Build a real, fully-migrated DB first (the rest of the schema —
  // identity, credentials — has to be present for migrate() to run),
  // then DOWNGRADE user_modules to the exact six-key CHECK that
  // shipped before this issue. That reproduces a live pre-PHA-2659
  // install far more faithfully than a hand-rolled users table.
  userModel.migrate(db);
  const uid = db.prepare("SELECT id FROM users WHERE username = 'brandon'").get().id;
  db.pragma('foreign_keys = OFF');
  db.exec(`
DROP TABLE user_modules;
CREATE TABLE user_modules (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key  TEXT    NOT NULL CHECK (module_key IN ('wall','lists','calendar','chores','apps','agent')),
  enabled_at  TEXT,
  PRIMARY KEY (user_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_user_modules_user ON user_modules(user_id);
`);
  db.pragma('foreign_keys = ON');
  db.prepare('INSERT INTO user_modules VALUES (?, ?, ?)').run(uid, 'wall', '2026-01-01 00:00:00');
  db.prepare('INSERT INTO user_modules VALUES (?, ?, ?)').run(uid, 'lists', null);

  let threw = null;
  try { db.prepare('INSERT INTO user_modules VALUES (?, ?, NULL)').run(uid, 'gazette'); }
  catch (e) { threw = e; }
  assert(threw !== null, 'precondition: old CHECK rejects a gazette row');

  userModel.migrate(db);

  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_modules'").get().sql;
  assert(/'gazette'/.test(ddl), 'rebuilt CHECK now allows gazette');
  // Rows survive the rebuild, enabled_at semantics intact.
  const wall = db.prepare('SELECT * FROM user_modules WHERE user_id=? AND module_key=?').get(uid, 'wall');
  assertEq(wall.enabled_at, '2026-01-01 00:00:00', 'enabled row preserved with its timestamp');
  const lists = db.prepare('SELECT * FROM user_modules WHERE user_id=? AND module_key=?').get(uid, 'lists');
  assert(lists && lists.enabled_at === null, 'disabled row preserved as disabled');
  // The index is recreated (DROP TABLE takes its indexes with it).
  assert(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_user_modules_user'").get(),
    'idx_user_modules_user recreated after the rebuild');
  // And the new key now inserts.
  db.prepare('INSERT INTO user_modules VALUES (?, ?, NULL)').run(uid, 'gazette');
  ok('gazette row inserts after the rebuild');

  // Idempotent: a second migrate must not rebuild or lose anything.
  const before = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  userModel.migrate(db);
  assertEq(db.prepare('SELECT COUNT(*) c FROM user_modules').get().c, before,
    're-running migrate() is a no-op (rows unchanged)');
  // FK enforcement must be back ON after the rebuild toggled it off.
  assertEq(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys pragma restored to ON');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// 4. Thin-edition rule: section availability
// -----------------------------------------------------------------------------
{
  console.log('\nTest 4: availableSections omits empty slices');
  const empty = {
    user: { display: 'Brandon' }, date: '2026-08-30', tz: 'UTC',
    today_tasks: [], overdue_tasks: [], upcoming_chores: [], today_events: [],
    porch_overnight: { posts: [], comments: [] }, arrivals: [], tile_health: [],
  };
  assertEq(gazette.availableSections(empty), [], 'nothing happened → no sections at all');

  const someChores = { ...empty, today_tasks: [{ id: 1, title: 'Take out trash' }] };
  assertEq(gazette.availableSections(someChores), ['rotation_desk'],
    'only chores → only the rotation desk');

  const busy = {
    ...empty,
    today_tasks: [{ id: 1, title: 'Take out trash' }],
    today_events: [{ id: 2, title: 'Movie night' }],
    arrivals: [{ id: 'e1', name: 'Dune', kind: 'film' }],
    porch_overnight: { posts: [{ id: 'p1', text_body: 'hi' }], comments: [] },
  };
  assertEq(gazette.availableSections(busy), ['rotation_desk', 'arts_media', 'porch', 'listings'],
    'busy day → all four sections, in print order');

  // The prompt must only ever offer the sections that have material —
  // this is the thin-edition rule's first half.
  const { system, user, sections } = gazette.buildPrompt(someChores);
  assertEq(sections, ['rotation_desk'], 'buildPrompt reports only available sections');
  assert(system.includes('rotation_desk'), 'prompt names the available section');
  assert(!system.includes('arts_media'), 'prompt does NOT name a section with no material');
  assert(/OMIT any section/.test(system), 'prompt carries the omit-do-not-pad instruction');
  assert(user.includes('Take out trash'), 'prompt carries the actual material');
  // VOICE.md rule, not a separate editor persona (design note is explicit).
  assert(/Warm, dry, slightly amused/.test(system), 'prompt carries the VOICE.md register');
}

// -----------------------------------------------------------------------------
// 5. Thin-edition rule: parsing drops invented sections
// -----------------------------------------------------------------------------
{
  console.log('\nTest 5: parseEdition enforces the section whitelist');
  const raw = JSON.stringify({
    lede: { headline: 'Three things and a bin', body: 'The bin goes out tonight.' },
    briefs: [
      { key: 'rotation_desk', headline: 'Rotation', body: 'Your turn.' },
      // The harness invented this one — there were no arrivals today.
      { key: 'arts_media', headline: 'Nothing arrived', body: 'The library was quiet.' },
    ],
    editors_note: 'Anything else worth printing?',
  });
  const ed = gazette.parseEdition(raw, ['rotation_desk']);
  assertEq(ed.briefs.map(b => b.key), ['rotation_desk'],
    'brief for an unavailable section is dropped, not printed empty');
  assertEq(ed.lede.headline, 'Three things and a bin', 'lede survives');
  assertEq(ed.editors_note, 'Anything else worth printing?', 'editors_note survives');
  assertEq(ed.briefs[0].title, 'Rotation Desk', 'brief carries its structural section title');

  // Fenced JSON is common harness output and must not be fatal.
  const fenced = '```json\n' + JSON.stringify({ lede: { headline: 'H', body: 'B' }, briefs: [] }) + '\n```';
  assertEq(gazette.parseEdition(fenced, []).lede.body, 'B', 'fenced JSON parses');

  // Prose preamble before the object, also common.
  const prefixed = 'Here is your edition:\n' + JSON.stringify({ lede: { headline: 'H', body: 'B' }, briefs: [] });
  assertEq(gazette.parseEdition(prefixed, []).lede.body, 'B', 'prefixed JSON parses');

  // Junk must throw so the route can cache an honest 'unavailable'
  // rather than render an empty sheet.
  for (const [bad, label] of [['', 'empty string'], ['not json at all', 'non-JSON prose']]) {
    let t = null;
    try { gazette.parseEdition(bad, []); } catch (e) { t = e; }
    assert(t !== null, `parseEdition throws on ${label}`);
  }
  // An object with nothing printable in it is also a failure, not an
  // empty edition.
  let t2 = null;
  try { gazette.parseEdition(JSON.stringify({ briefs: [] }), []); } catch (e) { t2 = e; }
  assert(t2 !== null, 'parseEdition throws when there is no lede and no brief');
}

// -----------------------------------------------------------------------------
// 6. composeGazette speaks the provider wire
// -----------------------------------------------------------------------------
async function testComposeGazette() {
  console.log('\nTest 6: composeGazette runs the provider wire');
  const res = await agentRuntime.composeGazette({
    system: 'sys', user: 'usr',
    providerCfg: {
      provider: 'litellm', baseUrl: 'http://fake', apiKey: 'k', model: 'm',
      fetchImpl: async () => ({
        ok: true,
        body: {
          getReader() {
            const chunks = [
              Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"lede":' } }] })}\n\n`),
              Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"headline":"H","body":"B"}}' }, finish_reason: 'stop' }] })}\n\n`),
            ];
            let i = 0;
            return { read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
          },
        },
      }),
    },
  });
  assert(res.ok, 'composeGazette returns ok', res.lastError);
  assertEq(res.text, '{"lede":{"headline":"H","body":"B"}}', 'streamed deltas are concatenated');

  const bad = await agentRuntime.composeGazette({ system: '', user: '' });
  assert(!bad.ok && bad.status === 'bad_request', 'composeGazette rejects an empty prompt');
}

// -----------------------------------------------------------------------------
// 7. End-to-end over HTTP: gate, generate, cache, refresh
// -----------------------------------------------------------------------------
async function testRoute() {
  const fakeProvider = await startFakeProvider();
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(PORT, '127.0.0.1', resolve);
    process.on('uncaughtException', reject);
  });
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\nTest 7: GET /api/me/gazette/today is module-gated');
  {
    // Fresh install grandfathers the six pre-Gazette modules; gazette
    // is NOT among them, so the route must refuse before it is added.
    const me = await (await GET('/api/me')).json();
    assert(!me.enabled_modules.includes('gazette'), 'precondition: gazette not enabled');
    const r = await GET('/api/me/gazette/today');
    assertEq(r.status, 403, 'disabled → 403');
    assertEq((await r.json()).error, 'module_not_enabled', "error === 'module_not_enabled'");
  }

  console.log('\nTest 8: the cross-module dependency is real');
  {
    // agent is enabled here (grandfathered), so enabling gazette works.
    const en = await POST('/api/me/modules/gazette/enable');
    assertEq(en.status, 200, 'enabling gazette succeeds while agent is on');

    // Now the new registry edge must trip the EXISTING cascade: you
    // cannot drop the harness out from under the edition.
    const dis = await POST('/api/me/modules/agent/disable');
    assertEq(dis.status, 409, 'disabling agent with gazette on → 409');
    const body = await dis.json();
    assert(Array.isArray(body.dependents) && body.dependents.includes('gazette'),
      '409 names gazette as the blocking dependent', JSON.stringify(body));

    // And the cascade opt-in takes both down together.
    const casc = await POST('/api/me/modules/agent/disable', { withDependents: true });
    assertEq(casc.status, 200, 'disable with withDependents succeeds');
    const after = await (await GET('/api/me')).json();
    assert(!after.enabled_modules.includes('gazette'), 'gazette went down with agent');

    // Put both back for the remaining tests.
    await POST('/api/me/modules/agent/enable');
    await POST('/api/me/modules/gazette/enable');
  }

  console.log('\nTest 9: layout advertises the sheet launcher');
  {
    const layout = await (await GET('/api/me/layout')).json();
    assertEq((layout.sheets || []).map(s => s.key), ['gazette'],
      'layout.sheets carries gazette once enabled');
  }

  console.log('\nTest 10: quiet day prints the thin edition without calling the harness');
  {
    // Nothing has been seeded — no tasks, no events, no posts, no
    // arrivals. The route must NOT spend a token to say so.
    fakeRequests = [];
    const r = await GET('/api/me/gazette/today');
    assertEq(r.status, 200, 'quiet day → 200');
    const d = await r.json();
    assertEq(d.status, 'thin', "status === 'thin'");
    assertEq(d.edition.briefs, [], 'thin edition has no briefs (no empty columns)');
    assertEq(d.edition.lede.body, gazette.THIN_NOTE, 'thin edition prints the quiet-day line');
    assertEq(fakeRequests.length, 0, 'harness was never called for a quiet day');
  }

  console.log('\nTest 11: a real edition generates, then serves from cache');
  {
    // Give the day some material. A task due today lights up the
    // rotation desk; that is enough for a real edition.
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await POST('/api/me/modules/chores/enable', { withRequirements: true });
    const t = await POST('/api/tasks', { title: 'Take out trash', assignee: 'all', due_date: iso });
    assertEq(t.status, 200, 'seeded a task due today');

    FAKE_COMPLETION = JSON.stringify({
      lede: { headline: 'The bin goes out', body: 'One thing due, and it is the bin.' },
      briefs: [{ key: 'rotation_desk', headline: 'Rotation', body: 'Everyone, technically.' }],
      editors_note: 'Ask the editor: whose turn is it really?',
    });
    fakeRequests = [];

    // refresh=1 because the quiet edition for today is already cached.
    const r = await GET('/api/me/gazette/today?refresh=1');
    assertEq(r.status, 200, 'generate → 200');
    const d = await r.json();
    assertEq(d.status, 'published', "status === 'published'");
    assertEq(d.cached, false, 'freshly generated (cached === false)');
    assertEq(d.edition.lede.headline, 'The bin goes out', 'lede came from the harness');
    assertEq(d.edition.briefs.map(b => b.key), ['rotation_desk'], 'brief survived the whitelist');
    assertEq(fakeRequests.length, 1, 'harness called exactly once');

    // The prompt the harness actually received must carry the material.
    const sent = JSON.stringify(fakeRequests[0].body.messages);
    assert(sent.includes('Take out trash'), 'harness prompt carried the real task');
    assert(!sent.includes('arts_media'), 'harness prompt omitted the section with no material');

    // Second open of the same day: served from cache, no second call.
    fakeRequests = [];
    const again = await (await GET('/api/me/gazette/today')).json();
    assertEq(again.cached, true, 'second open is a cache hit');
    assertEq(again.edition.lede.headline, 'The bin goes out', 'cached edition is the same edition');
    assertEq(fakeRequests.length, 0, 'cache hit does not re-call the harness');
  }

  console.log('\nTest 12: a broken harness degrades to a retryable unavailable');
  {
    FAKE_COMPLETION = 'I am afraid I cannot do that.'; // unparseable
    fakeRequests = [];
    const d = await (await GET('/api/me/gazette/today?refresh=1')).json();
    assertEq(d.status, 'unavailable', "unparseable output → status 'unavailable'");
    assertEq(d.retryable, true, 'flagged retryable so the sheet can offer a re-run');

    // Cached, so a broken harness is not re-dialled on every open.
    fakeRequests = [];
    const cached = await (await GET('/api/me/gazette/today')).json();
    assertEq(cached.status, 'unavailable', 'failure is cached for the day');
    assertEq(fakeRequests.length, 0, 'broken harness is not re-called on the next open');

    // ...but an explicit refresh recovers once the harness behaves.
    FAKE_COMPLETION = JSON.stringify({ lede: { headline: 'Back', body: 'Recovered.' }, briefs: [] });
    const fixed = await (await GET('/api/me/gazette/today?refresh=1')).json();
    assertEq(fixed.status, 'thin', 'recovered edition with no briefs is thin, not unavailable');
    assertEq(fixed.edition.lede.headline, 'Back', 'refresh re-ran the harness');
  }

  fakeProvider.close();
}

(async () => {
  await testComposeGazette();
  await testRoute();
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
