#!/usr/bin/env node
// Member karma on The Forum (lib/forum-karma.js, PHA-4421): schema, one
// vote per giver per target (flip, retract, same-vote no-op), no self
// karma, 404 for people you share no board with, rolling daily rate limit,
// postbit read model in thread view, app-token scopes, user-delete cascade.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-forum-karma-'));
const PORT = 3197;
process.env.DATA_DIR = tmpDir;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'forum-karma-test-pw';
process.env.BRANDON_PASSWORD = 'forum-karma-test-pw';
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
const headersFor = (u, groups) => ({
  'x-authentik-username': u,
  'x-authentik-groups': groups || (u === 'admin' ? 'household,admins' : 'household'),
  'content-type': 'application/json',
});
async function call(user, method, urlPath, body, groups) {
  const r = await fetch(BASE + urlPath, {
    method, headers: user ? headersFor(user, groups) : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) };
}
const K = (u) => `/api/forum/members/${encodeURIComponent(u)}/karma`;
const score = (b) => [b.plus, b.minus, b.mine];

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
    const karma = require('../lib/forum-karma');

    console.log('Test 1: schema');
    {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'forum_karma%'").all().map((r) => r.name).sort();
      assertEq(tables, ['forum_karma', 'forum_karma_log'], 'two karma tables exist');
      karma.migrate(db); karma.migrate(db);
      ok('forum-karma.migrate is idempotent');
    }

    console.log('\nTest 2: give, flip, same-vote no-op, retract');
    {
      let r = await call('emily', 'GET', K('tyler'));
      assertEq([r.status, ...score(r.body), r.body.canVote], [200, 0, 0, 0, true], 'fresh member: 0 / 0, can vote');
      r = await call('emily', 'PUT', K('tyler'), { value: 1 });
      assertEq([r.status, ...score(r.body)], [200, 1, 0, 1], 'emily gives +1');
      r = await call('admin', 'PUT', K('tyler'), { value: -1 });
      assertEq(score(r.body), [1, 1, -1], 'admin gives -1');
      r = await call('emily', 'PUT', K('tyler'), { value: 1 });
      assertEq(score(r.body), [1, 1, 1], 'emily re-sending +1 does not double count');
      r = await call('emily', 'PUT', K('tyler'), { value: -1 });
      assertEq(score(r.body), [0, 2, -1], 'emily flips to -1: still one vote');
      assertEq(db.prepare("SELECT COUNT(*) c FROM forum_karma WHERE target_id = (SELECT id FROM users WHERE username='tyler')").get().c, 2, 'one row per giver');
      r = await call('emily', 'DELETE', K('tyler'));
      assertEq([r.status, ...score(r.body)], [200, 0, 1, 0], 'emily takes her vote back');
      r = await call('emily', 'DELETE', K('tyler'));
      assertEq(r.status, 200, 'retracting nothing is a 200 no-op');
      for (const [body, code] of [[{}, 'invalid_karma_value'], [{ value: 2 }, 'invalid_karma_value'], [{ value: '1' }, 'invalid_karma_value']]) {
        r = await call('emily', 'PUT', K('tyler'), body);
        assertEq([r.status, r.body.error], [400, code], `bad value ${JSON.stringify(body)} → 400`);
      }
    }

    console.log('\nTest 3: no karma on yourself');
    {
      let r = await call('tyler', 'PUT', K('tyler'), { value: 1 });
      assertEq([r.status, r.body.error], [400, 'karma_self'], 'self +1 → 400 karma_self');
      r = await call('tyler', 'GET', K('tyler'));
      assertEq([r.status, r.body.canVote], [200, false], 'own karma readable, canVote false');
      let threw = false;
      try { db.prepare("INSERT INTO forum_karma (giver_id, target_id, value) SELECT id, id, 1 FROM users WHERE username='tyler'").run(); } catch (_) { threw = true; }
      assert(threw, 'schema CHECK rejects a self row even past the API');
    }

    console.log('\nTest 4: privacy — only people you share a board with');
    {
      db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('stranger','Stranger','#000','x',0)").run();
      const s = (m, p, b) => call('stranger', m, p, b, 'outsiders');
      assertEq((await s('PUT', K('tyler'), { value: -1 })).status, 404, 'outsider giving karma → 404');
      assertEq((await s('GET', K('tyler'))).status, 404, 'outsider reading karma → 404');
      assertEq((await call('emily', 'PUT', K('stranger'), { value: 1 })).status, 404, 'member rating an outsider → 404');
      assertEq((await call('emily', 'PUT', K('nobody'), { value: 1 })).status, 404, 'unknown username → 404');
      assertEq((await call(null, 'GET', K('tyler'))).status, 401, 'unauthenticated → 401');
    }

    console.log('\nTest 5: thread postbits carry karma');
    {
      const thread = (await call('tyler', 'POST', '/api/walls/household/posts', { kind: 'text', title: 'karma thread', text_body: 'hi' })).body;
      await call('emily', 'POST', `/api/walls/posts/${thread.id}/comments`, { body: 'reply' });
      await call('emily', 'PUT', K('tyler'), { value: 1 });
      const v = (await call('emily', 'GET', `/api/forum/threads/${thread.id}`)).body;
      const k = v.thread.member.karma;
      assertEq([k.plus, k.minus, k.mine, k.canVote], [1, 1, 1, true], 'thread starter postbit: totals + viewer vote');
      const rk = v.replies[0].member.karma;
      assertEq([rk.mine, rk.canVote], [0, false], 'own reply postbit: canVote false');
    }

    console.log('\nTest 6: rolling daily rate limit');
    {
      // emily so far: +1, flip, retract, +1 in test 5 (the re-send and empty retract were free).
      const used = () => db.prepare("SELECT COUNT(*) c FROM forum_karma_log WHERE giver_id = (SELECT id FROM users WHERE username='emily')").get().c;
      assertEq(used(), 4, 'only real changes were logged (no-ops are free)');
      let last;
      for (let i = used(); i < karma.KARMA_DAILY_LIMIT; i++) {
        last = await call('emily', 'PUT', K(i % 2 ? 'admin' : 'tyler'), { value: i % 4 < 2 ? -1 : 1 });
      }
      assertEq(last && last.status, 200, `actions up to the limit (${karma.KARMA_DAILY_LIMIT}) succeed`);
      const cur = (await call('emily', 'GET', K('tyler'))).body.mine;
      const r = await call('emily', 'PUT', K('tyler'), { value: cur === 1 ? -1 : 1 });
      assertEq([r.status, r.body.error], [429, 'karma_rate_limited'], 'one more → 429 karma_rate_limited');
      const ra = Number(r.headers.get('retry-after'));
      assert(ra > 0 && ra <= 86400, 'Retry-After within a day', String(ra));
      assertEq((await call('emily', 'GET', K('tyler'))).body.mine, cur, 'rate-limited vote did not change anything');
      assertEq((await call('emily', 'PUT', K('tyler'), { value: cur })).status, 200, 'a no-op re-send is still allowed');
      assertEq((await call('admin', 'PUT', K('emily'), { value: 1 })).status, 200, 'the limit is per giver');
      db.prepare("UPDATE forum_karma_log SET at = datetime('now', '-25 hours') WHERE giver_id = (SELECT id FROM users WHERE username='emily')").run();
      assertEq((await call('emily', 'PUT', K('tyler'), { value: cur === 1 ? -1 : 1 })).status, 200, 'after 24h the window rolls over');
      assertEq(used(), 1, 'expired log rows are pruned');
    }

    console.log('\nTest 7: app-token scopes');
    {
      const { scopesForApiRoute } = require('../lib/scope-display');
      assertEq(scopesForApiRoute('GET', K('tyler')), ['read:walls'], 'GET karma needs read:walls');
      assertEq(scopesForApiRoute('PUT', K('tyler')), ['write:walls:react'], 'PUT karma needs write:walls:react');
      assertEq(scopesForApiRoute('DELETE', K('tyler')), ['write:walls:react'], 'DELETE karma needs write:walls:react');
    }

    console.log('\nTest 8: karma is deleted with the user');
    {
      const fk = db.prepare("SELECT \"from\" AS col, \"table\" AS t, on_delete FROM pragma_foreign_key_list('forum_karma') ORDER BY col").all();
      assertEq(fk.map((r) => [r.col, r.t, r.on_delete]), [['giver_id', 'users', 'CASCADE'], ['target_id', 'users', 'CASCADE']],
        'giver and target cascade from users(id)');
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
