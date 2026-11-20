#!/usr/bin/env node
// Forum Games (lib/forum-games.js, PHA-4423): the Fun Zone board and its
// two sticky threads are seeded once (and reach installs seeded before
// it existed), count-to-1000 replies must be previous+1 from a
// different user with a friendly 409, word association stays plain,
// thread view and board list carry the game, Hearth skips game threads.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-forum-games-'));
const PORT = 3293;
process.env.DATA_DIR = tmpDir;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'forum-games-test-pw';
process.env.BRANDON_PASSWORD = 'forum-games-test-pw';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const BASE = `http://127.0.0.1:${PORT}`;
const headersFor = (u) => ({
  'x-authentik-username': u,
  'x-authentik-groups': u === 'admin' ? 'household,admins' : 'household',
  'content-type': 'application/json',
});
async function call(user, method, urlPath, body) {
  const r = await fetch(BASE + urlPath, {
    method, headers: headersFor(user),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve) => { const l = app.listen(PORT, '127.0.0.1', () => resolve(l)); });
  try {
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (_) { /* booting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const db = new Database(path.join(tmpDir, 'life.db'));
    for (const u of ['tyler', 'emily', 'admin']) await call(u, 'GET', '/api/me');
    const games = require('../lib/forum-games');
    const reply = (u, id, body) => call(u, 'POST', `/api/walls/posts/${id}/comments`, { body });

    console.log('Test 1: Fun Zone board is seeded with two sticky threads');
    let countId, wordId;
    {
      const idx = (await call('tyler', 'GET', '/api/forum/index')).body;
      const fz = idx.categories.find((c) => c.name === 'Fun Zone');
      assert(fz, 'Fun Zone category on the board index', JSON.stringify(idx.categories.map((c) => c.name)));
      const board = fz && fz.boards[0];
      assertEq(board && [board.slug, board.name, board.threadCount], ['forum-games', 'Forum Games', 2], 'Forum Games board with 2 threads');
      assert(board && board.description, 'board has a description');
      assertEq(idx.categories.map((c) => c.name).pop(), 'Fun Zone', 'Fun Zone sorts after the starter boards');
      const list = (await call('tyler', 'GET', '/api/forum/boards/forum-games/threads')).body.threads;
      assertEq(list.map((t) => [t.title, t.sticky, t.game]), [['Count to 1000', true, 'count'], ['Word Association', true, null]],
        'count thread first, both sticky, only count is a game');
      countId = list[0].id; wordId = list[1].id;
      const hearth = db.prepare("SELECT u.username FROM porch_builtin_agents b JOIN users u ON u.id = b.user_id").get();
      assertEq(list[0].author && list[0].author.username, hearth.username, 'threads are by built-in Hearth');
      assertEq(db.prepare("SELECT COUNT(*) c FROM notification_log WHERE title LIKE '%Count to%' OR body LIKE '%Count to%'").get().c, 0, 'seeding sent no notifications');
    }

    console.log('\nTest 2: seed runs once and respects deletion');
    {
      assertEq(games.seedFunZone(db, 1).seeded, false, 'second seed is a no-op');
      db.prepare("DELETE FROM walls WHERE slug = 'forum-games'").run();
      assertEq(games.seedFunZone(db, 1).seeded, false, 'deleted board is not resurrected');
      // Upgrade path: an install whose forum was seeded before this board existed.
      db.prepare("DELETE FROM forum_seeds WHERE key = ?").run(games.FUN_ZONE_SEED_KEY);
      const hearthId = db.prepare('SELECT user_id FROM porch_builtin_agents LIMIT 1').get().user_id;
      assertEq(games.seedFunZone(db, hearthId), { seeded: true, created: true }, 'pre-existing install gets the board on upgrade');
      const list = (await call('tyler', 'GET', '/api/forum/boards/forum-games/threads')).body.threads;
      assertEq(list.length, 2, 'with both threads');
      countId = list[0].id; wordId = list[1].id;
      // A hand-made forum-games wall is filed under Fun Zone, not given threads.
      db.prepare("DELETE FROM walls WHERE slug = 'forum-games'").run();
      db.prepare("DELETE FROM forum_seeds").run();
      db.prepare("INSERT INTO walls (id, slug, name, visibility, group_name) VALUES ('hand', 'forum-games', 'Our Games', 'group', 'household')").run();
      assertEq(games.seedFunZone(db, hearthId), { seeded: true, created: false }, 'existing slug is adopted');
      assertEq(db.prepare("SELECT name, category FROM walls WHERE id = 'hand'").get(), { name: 'Our Games', category: 'Fun Zone' }, 'custom name kept, category set');
      assertEq(db.prepare("SELECT COUNT(*) c FROM wall_posts WHERE wall_id = 'hand'").get().c, 0, 'no threads added to an adopted board');
      // Back to a seeded board for the game tests.
      db.prepare("DELETE FROM walls WHERE slug = 'forum-games'").run();
      db.prepare("DELETE FROM forum_seeds").run();
      games.seedFunZone(db, hearthId);
      const l2 = (await call('tyler', 'GET', '/api/forum/boards/forum-games/threads')).body.threads;
      countId = l2[0].id; wordId = l2[1].id;
    }

    console.log('\nTest 3: leadingNumber');
    {
      const cases = [['1', 1], ['  42! halfway-ish', 42], ['#7', 7], ['1,000', 1000], ['1000.', 1000], ['5, then 6', 5],
        ['4.5', null], ['12abc', null], ['twelve', null], ['', null], ['12,5', null]];
      for (const [t, n] of cases) assertEq(games.leadingNumber(t), n, `leadingNumber(${JSON.stringify(t)}) = ${n}`);
    }

    console.log('\nTest 4: count rules');
    {
      let r = await reply('tyler', countId, '2');
      assertEq([r.status, r.body.error, r.body.expected], [409, 'count_wrong_number', 1], 'first reply must be 1');
      assert(/next number is 1/.test(r.body.message || ''), 'friendly message names the next number', r.body.message);
      r = await reply('tyler', countId, 'hello');
      assertEq([r.status, r.body.error, r.body.expected], [409, 'count_not_a_number', 1], 'non-number rejected');
      assert(r.body.message && r.body.message.length > 10, 'with a message', r.body.message);
      r = await reply('tyler', countId, '1');
      assertEq(r.status, 200, 'tyler posts 1');
      r = await reply('tyler', countId, '2');
      assertEq([r.status, r.body.error, r.body.expected], [409, 'count_twice_in_a_row', 2], 'tyler cannot post 2 right after');
      assert(/twice in a row/i.test(r.body.message || ''), 'twice-in-a-row message', r.body.message);
      r = await reply('emily', countId, '3');
      assertEq([r.status, r.body.error], [409, 'count_wrong_number'], 'emily skipping to 3 rejected');
      r = await reply('emily', countId, '2 my turn');
      assertEq(r.status, 200, 'emily posts "2 my turn"');
      r = await reply('admin', countId, '2');
      assertEq([r.status, r.body.expected], [409, 3], 'admins follow the rules too');
      r = await reply('tyler', countId, '3');
      assertEq(r.status, 200, 'tyler can go again after someone else');
      assertEq(db.prepare('SELECT COUNT(*) c FROM post_comments WHERE post_id = ?').get(countId).c, 3, 'only the 3 valid replies were stored');
      r = await call('emily', 'GET', `/api/forum/threads/${countId}`);
      assertEq(r.body.game && [r.body.game.kind, r.body.game.last, r.body.game.next, r.body.game.goal, r.body.game.complete, r.body.game.lastBy.username],
        ['count', 3, 4, 1000, false, 'tyler'], 'thread view carries the count state');
    }

    console.log('\nTest 5: deleting the latest reply rewinds the count');
    {
      db.prepare('DELETE FROM post_comments WHERE id = (SELECT MAX(id) FROM post_comments WHERE post_id = ?)').run(countId);
      const r = await reply('emily', countId, '4');
      assertEq([r.status, r.body.expected], [409, 3], 'after deleting 3, the next number is 3 again');
      // emily posted 2, which is now the latest, so she has to wait.
      assertEq(r.body.error, 'count_twice_in_a_row', 'and the last poster is emily again');
      assertEq((await reply('admin', countId, '3')).status, 200, 'admin posts 3');
    }

    console.log('\nTest 6: reaching the goal finishes the game');
    {
      const u = db.prepare("SELECT id FROM users WHERE username = ?");
      const ids = [u.get('tyler').id, u.get('emily').id];
      const ins = db.prepare('INSERT INTO post_comments (post_id, author_user_id, body) VALUES (?, ?, ?)');
      db.transaction(() => { for (let n = 4; n <= 999; n++) ins.run(countId, ids[n % 2], String(n)); })();
      let r = await reply('admin', countId, '1,000 🎉');
      assertEq(r.status, 200, 'admin posts 1,000');
      r = await reply('tyler', countId, '1001');
      assertEq([r.status, r.body.error], [409, 'count_complete'], 'nothing after 1000');
      assert(/1000/.test(r.body.message || ''), 'complete message', r.body.message);
      const g = (await call('tyler', 'GET', `/api/forum/threads/${countId}`)).body.game;
      assertEq([g.complete, g.next, g.last], [true, null, 1000], 'thread view says complete');
    }

    console.log('\nTest 7: word association and other threads have no rules');
    {
      assertEq((await reply('tyler', wordId, 'porch → swing')).status, 200, 'word reply ok');
      assertEq((await reply('tyler', wordId, 'swing → set')).status, 200, 'same user twice is fine there');
      assertEq((await call('tyler', 'GET', `/api/forum/threads/${wordId}`)).body.game, null, 'no game block');
      const t = (await call('tyler', 'POST', '/api/walls/forum-games/posts', { kind: 'text', title: 'Rate the snack', text_body: '7/10' })).body;
      assertEq((await reply('tyler', t.id, 'anything')).status, 200, 'a new thread on the games board is plain');
      assertEq((await reply('tyler', t.id, 'anything again')).status, 200, 'no twice-in-a-row rule there');
    }

    console.log('\nTest 8: error mapper and agent path');
    {
      const walls = require('../lib/walls');
      let caught = null;
      const fresh = db.prepare("SELECT id FROM wall_posts WHERE forum_game = 'count'").get().id;
      try { walls.createComment(fresh, db.prepare("SELECT id FROM users WHERE username='tyler'").get().id, 'oops'); } catch (e) { caught = e; }
      assertEq(caught && [caught.status, caught.code], [409, 'count_complete'], 'walls.createComment enforces the rule for every caller');
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert(/if \(post\.forum_game\) \{\s*log\(`decision skipped, game thread/.test(src), 'Porch agent decisions skip game threads');
    }
    db.close();
  } catch (e) {
    ng('test aborted', e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
