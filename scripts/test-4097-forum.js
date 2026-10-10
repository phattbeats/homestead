#!/usr/bin/env node
// #4097 (parent #4076) acceptance tests for The Forum: Porch rename,
// /forum route + /porch.html redirect, always-/forum default_route, the
// additive forum schema, seeded starter boards, and the Woodgrain read API
// (board index, thread list, thread view, who's online, stats/birthdays).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-forum-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3197';
process.env.ADMIN_PASSWORD = 'forum-test-pw';
process.env.BRANDON_PASSWORD = 'forum-test-pw';
process.env.SESSION_SECRET = 'forum-test-secret-padding-to-meet-min-32-chars';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

// The default-enabled module is the Forum; read it from the registry rather than hardcoding a key.
const WALL_KEY = require('../lib/modules').getDefaultEnabled()[0];
const BASE = 'http://127.0.0.1:3197';
const asUser = (u) => ({ 'x-authentik-username': u, 'x-authentik-groups': u === 'admin' ? 'household,admins' : 'household' });
const call = (user, method, urlPath, body) => fetch(BASE + urlPath, {
  method,
  redirect: 'manual',
  headers: { ...(user ? asUser(user) : {}), 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const getJson = async (user, urlPath) => (await call(user, 'GET', urlPath)).json();

(async () => {
  const app = require('../server.js');
  await new Promise((resolve) => app.listen(3197, '127.0.0.1', resolve));
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (_) { /* poll */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const db = new Database(path.join(tmpDir, 'life.db'));

  console.log('Test 1: schema is additive');
  {
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['title', 'sticky', 'views']) assert(cols('wall_posts').includes(c), `wall_posts.${c}`);
    for (const c of ['category', 'sort']) assert(cols('walls').includes(c), `walls.${c}`);
    for (const c of ['signature', 'birthday', 'last_active_at', 'last_visit_at']) assert(cols('users').includes(c), `users.${c}`);
    const { forum, walls } = { forum: require('../lib/forum'), walls: require('../lib/walls') };
    forum.migrate(db); forum.migrate(db);
    ok('forum.migrate is idempotent');
    void walls;
  }

  console.log('\nTest 2: Porch → The Forum rename, routes, landing');
  {
    const r = await fetch(BASE + '/forum');
    assertEq(r.status, 200, 'GET /forum → 200');
    const html = await r.text();
    assert(html.includes('<title>The Forum'), '/forum page title is The Forum');
    const red = await call(null, 'GET', '/porch.html?wall=household&post=abc');
    assertEq(red.status, 301, '/porch.html → 301');
    assertEq(red.headers.get('location'), '/forum?wall=household&post=abc', 'redirect preserves the query string');
    const red2 = await call(null, 'GET', '/porch.html');
    assertEq(red2.headers.get('location'), '/forum', 'bare redirect → /forum');
    const me = await getJson('brandon', '/api/me');
    assertEq(me.default_route, '/forum', '/api/me.default_route === /forum');
    // Regardless of enabled modules: disable every optional module.
    for (const k of (me.enabled_modules || [])) {
      if (k !== WALL_KEY) await call('brandon', 'POST', `/api/me/modules/${k}/disable`, { withDependents: true });
    }
    assertEq((await getJson('brandon', '/api/me')).default_route, '/forum', 'default_route stays /forum with only wall enabled');
    const mods = await getJson('brandon', '/api/modules');
    const wall = (Array.isArray(mods) ? mods : mods.modules).find((m) => m.key === WALL_KEY);
    assertEq(wall.name, 'The Forum', 'registry name is The Forum');
    assertEq(wall.route, '/forum', 'registry route is /forum');
  }

  console.log('\nTest 3: seeded boards (few, categorised); Porch posts live on');
  {
    const idx = await getJson('brandon', '/api/forum/index');
    const boards = idx.categories.flatMap((c) => c.boards);
    assertEq(boards.map((b) => b.slug), ['announcements', 'household', 'introductions'], 'exactly the three starter boards, in order');
    assertEq(idx.categories.map((c) => c.name), ['Homestead', 'Community'], 'grouped into two categories');
    assertEq(boards.find((b) => b.slug === 'household').name, 'General Chit-Chat', 'existing Porch wall is General Chit-Chat');
    const wallCount = db.prepare('SELECT COUNT(*) c FROM walls').get().c;
    require('../lib/forum').seed(db);
    assertEq(db.prepare('SELECT COUNT(*) c FROM walls').get().c, wallCount, 'seed is idempotent');
  }

  console.log('\nTest 4: threads — titles, replies, views, sticky');
  let t1, t2;
  {
    const a = await (await call('brandon', 'POST', '/api/walls/household/posts', { kind: 'text', title: 'Pizza night poll', text_body: 'Friday?' })).json();
    const b = await (await call('emily', 'POST', '/api/walls/household/posts', { kind: 'text', text_body: '\n\nUntitled musings\nsecond line' })).json();
    t1 = a.id; t2 = b.id;
    assertEq(a.title, 'Pizza night poll', 'explicit title stored');
    // Second-resolution timestamps: pin t2 to the past so ordering is deterministic.
    db.prepare("UPDATE wall_posts SET created_at = datetime('now','-1 hour') WHERE id = ?").run(t2);
    await call('emily', 'POST', `/api/walls/posts/${t1}/comments`, { body: 'Yes please' });
    await call('brandon', 'POST', `/api/walls/posts/${t1}/comments`, { body: 'Great' });

    const list = await getJson('brandon', '/api/forum/boards/household/threads');
    assertEq(list.board.name, 'General Chit-Chat', 'thread list names the board');
    assertEq(list.total, 2, 'two threads');
    const byId = Object.fromEntries(list.threads.map((t) => [t.id, t]));
    assertEq(byId[t1].replies, 2, 'reply count');
    assertEq(byId[t2].title, 'Untitled musings', 'untitled thread falls back to first non-blank body line');
    assertEq(byId[t1].lastPost.by.username, 'brandon', 'last poster is the latest replier');
    assertEq(list.threads[0].id, t1, 'most recently active thread first');

    const v0 = (await getJson('emily', `/api/forum/threads/${t1}`));
    assertEq(v0.thread.views, 1, 'a different reader bumps views');
    const v1 = (await getJson('brandon', `/api/forum/threads/${t1}`));
    assertEq(v1.thread.views, 1, "the author's own view doesn't bump views");
    assertEq(v1.replies.length, 2, 'thread view includes replies');
    assertEq(v1.board.slug, 'household', 'thread view names its board');

    const denied = await call('brandon', 'PATCH', `/api/forum/threads/${t2}`, { sticky: true });
    assertEq(denied.status, 403, 'non-admin cannot sticky');
    const stuck = await call('admin', 'PATCH', `/api/forum/threads/${t2}`, { sticky: true });
    assertEq(stuck.status, 200, 'admin can sticky');
    const after = await getJson('brandon', '/api/forum/boards/household/threads');
    assertEq(after.threads[0].id, t2, 'sticky thread sorts first');
    assertEq(after.threads[0].sticky, true, 'sticky flag exposed');
    assertEq((await call('brandon', 'GET', '/api/forum/threads/nope')).status, 404, 'unknown thread → 404');
    assertEq((await call('brandon', 'GET', '/api/forum/boards/nope/threads')).status, 404, 'unknown board → 404');
  }

  console.log('\nTest 5: board index counts + last post');
  {
    const idx = await getJson('brandon', '/api/forum/index');
    const b = idx.categories.flatMap((c) => c.boards).find((x) => x.slug === 'household');
    assertEq(b.threadCount, 2, 'board thread count');
    assertEq(b.postCount, 4, 'board post count = threads + replies');
    assertEq(b.lastPost.author.username, 'brandon', 'board last post author');
    assertEq(b.lastPost.isReply, true, 'last post is a reply');
    const empty = idx.categories.flatMap((c) => c.boards).find((x) => x.slug === 'announcements');
    assertEq(empty.lastPost, null, 'empty board has no last post');
  }

  console.log('\nTest 6: members — post counts, ranks, signature');
  {
    const v = await getJson('brandon', `/api/forum/threads/${t1}`);
    assertEq(v.thread.member.postCount, 2, 'brandon: 1 thread + 1 reply');
    assertEq(v.thread.member.rank, 'Newcomer', 'low post count → Newcomer');
    const adminView = await getJson('brandon', `/api/forum/threads/${t2}`);
    assert(adminView.thread.member.rank, 'thread author carries a rank');
    const bad = await call('brandon', 'PATCH', '/api/forum/me', { signature: 'x'.repeat(201) });
    assertEq(bad.status, 400, 'over-long signature rejected');
    const good = await call('brandon', 'PATCH', '/api/forum/me', { signature: '  ~ brandon ~  ', birthday: '07-04' });
    assertEq((await good.json()).signature, '~ brandon ~', 'signature trimmed + stored');
    assertEq((await call('brandon', 'PATCH', '/api/forum/me', { birthday: '13-45' })).status, 400, 'bad birthday rejected');
    const v2 = await getJson('emily', `/api/forum/threads/${t1}`);
    assertEq(v2.thread.member.signature, '~ brandon ~', 'signature appears on thread author');

    const adm = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    assertEq(require('../lib/forum').memberView(adm).rank, 'Administrator', 'admin → Administrator');
    const hearth = require('../lib/hearth-characters');
    const hid = hearth.ensureBuiltinAgentUser ? hearth.ensureBuiltinAgentUser(db) : null;
    if (hid) {
      const row = require('../lib/forum').memberView(typeof hid === 'object' ? hid.id : hid);
      assertEq(row.rank, 'Moderator · House Agent', 'Hearth is Moderator · House Agent');
    } else {
      ng('Hearth builtin agent user could not be created');
    }
  }

  console.log("\nTest 7: who's online + stats + birthdays + last visit");
  {
    db.prepare("UPDATE users SET last_active_at = datetime('now','-40 minutes') WHERE username IN ('emily','admin')").run();
    await getJson('brandon', '/api/forum/online');
    const on = await getJson('brandon', '/api/forum/online');
    assertEq(on.windowMinutes, 15, '15-minute window');
    assertEq(on.members.map((m) => m.username), ['brandon'], 'only recently-active users are online');
    await getJson('emily', '/api/forum/online'); // touch → emily active, visit rolled
    const on2 = await getJson('brandon', '/api/forum/online');
    assertEq(on2.members.map((m) => m.username).sort(), ['brandon', 'emily'], 'a fresh request puts a user online');

    const emilyRow = db.prepare("SELECT last_visit_at FROM users WHERE username='emily'").get();
    assert(!!emilyRow.last_visit_at, 'returning after >30min rolls last_visit_at forward');
    db.prepare("UPDATE users SET last_visit_at = datetime('now','-1 day') WHERE username='emily'").run();
    const idx = await getJson('emily', '/api/forum/index');
    const hh = idx.categories.flatMap((c) => c.boards).find((x) => x.slug === 'household');
    assertEq(hh.newSinceVisit, 4, 'new-since-last-visit counts threads + replies');
    const tl = await getJson('emily', '/api/forum/boards/household/threads');
    assert(tl.threads.every((t) => t.isNew), 'threads active since last visit are flagged new');

    const today = new Date();
    const md = `${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    db.prepare("UPDATE users SET birthday = ? WHERE username='emily'").run(md);
    const st = await getJson('brandon', '/api/forum/stats');
    assertEq(st.threads, 2, 'stats.threads');
    assertEq(st.posts, 4, 'stats.posts');
    assert(st.members >= 3, 'stats.members');
    assertEq(st.birthdaysToday.map((b) => b.username), ['emily'], 'birthdays today');
    assert(st.newestMember && st.newestMember.username, 'newest member present');
  }

  console.log('\nTest 8: access control');
  {
    assertEq((await call(null, 'GET', '/api/forum/index')).status, 401, 'unauthenticated index → 401');
    db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('stranger','Stranger','#000','x',0)").run();
    const r = await fetch(BASE + `/api/forum/threads/${t1}`, { headers: { 'x-authentik-username': 'stranger', 'x-authentik-groups': 'outsiders' } });
    assertEq(r.status, 404, 'non-member sees a thread as 404');
    const idx = await (await fetch(BASE + '/api/forum/index', { headers: { 'x-authentik-username': 'stranger', 'x-authentik-groups': 'outsiders' } })).json();
    assertEq(idx.categories, [], 'non-member sees no boards');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
