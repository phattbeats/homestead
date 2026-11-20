#!/usr/bin/env node
// Thread polls on The Forum (lib/forum-polls.js, PHA-4419): schema,
// create/validate, one vote per member (re-vote moves it), retract,
// close/reopen, author/admin gate, 404 for non-members, cascade on thread
// delete, thread view + thread list + sidebar read models, app-token scopes.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-forum-polls-'));
const PORT = 3196;
process.env.DATA_DIR = tmpDir;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'forum-polls-test-pw';
process.env.BRANDON_PASSWORD = 'forum-polls-test-pw';
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

    console.log('Test 1: schema');
    {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'forum_poll%'").all().map((r) => r.name).sort();
      assertEq(tables, ['forum_poll_options', 'forum_poll_votes', 'forum_polls'], 'three poll tables exist');
      const polls = require('../lib/forum-polls');
      polls.migrate(db); polls.migrate(db);
      ok('forum-polls.migrate is idempotent');
    }

    const thread = (await call('tyler', 'POST', '/api/walls/household/posts', { kind: 'text', title: 'friday movie?', text_body: 'vote below' })).body;
    const plain = (await call('emily', 'POST', '/api/walls/household/posts', { kind: 'text', title: 'no poll here', text_body: 'hi' })).body;

    console.log('\nTest 2: create + validation');
    let poll;
    {
      const bad = [
        [{ options: ['a', 'b'] }, 'question_required'],
        [{ question: 'q', options: ['a'] }, 'too_few_options'],
        [{ question: 'q', options: ['a', '  '] }, 'too_few_options'],
        [{ question: 'q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, 'too_many_options'],
        [{ question: 'q', options: ['Horror', 'horror'] }, 'duplicate_option'],
        [{ question: 'q', options: ['a', 'x'.repeat(81)] }, 'option_too_long'],
        [{ question: 'x'.repeat(141), options: ['a', 'b'] }, 'question_too_long'],
        [{ question: 'q', options: ['a', 3] }, 'invalid_option'],
        [{ question: 'q', options: ['a', 'b'], closesAt: '2001-01-01T00:00:00Z' }, 'closes_at_in_past'],
        [{ question: 'q', options: ['a', 'b'], closesAt: 'friday' }, 'invalid_closes_at'],
      ];
      for (const [body, code] of bad) {
        const r = await call('tyler', 'POST', `/api/forum/threads/${thread.id}/poll`, body);
        assertEq([r.status, r.body.error], [400, code], `bad poll → 400 ${code}`);
      }
      const notMine = await call('emily', 'POST', `/api/forum/threads/${thread.id}/poll`, { question: 'q', options: ['a', 'b'] });
      assertEq(notMine.status, 403, 'a member who is not the thread starter cannot attach a poll');
      const r = await call('tyler', 'POST', `/api/forum/threads/${thread.id}/poll`,
        { question: ' friday movie? ', options: ['👻 horror', '😂 comedy', '', '🚀 sci-fi'] });
      assertEq(r.status, 201, 'thread starter creates a poll → 201');
      poll = r.body;
      assertEq(poll.question, 'friday movie?', 'question is trimmed');
      assertEq(poll.options.map((o) => o.label), ['👻 horror', '😂 comedy', '🚀 sci-fi'], 'blank options dropped, order kept');
      assertEq([poll.totalVotes, poll.myVote, poll.closed, poll.canManage], [0, null, false, true], 'fresh poll: no votes, open, manageable by starter');
      const again = await call('tyler', 'POST', `/api/forum/threads/${thread.id}/poll`, { question: 'q', options: ['a', 'b'] });
      assertEq(again.status, 409, 'second poll on one thread → 409');
      const byAdmin = await call('admin', 'POST', `/api/forum/threads/${plain.id}/poll`, { question: 'admin poll', options: ['a', 'b'], closesAt: new Date(Date.now() + 86400000).toISOString() });
      assertEq(byAdmin.status, 201, 'an admin can attach a poll to anyone\'s thread');
      assert(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(byAdmin.body.closesAt), 'closesAt stored as SQLite UTC datetime', byAdmin.body.closesAt);
      assertEq((await call('admin', 'POST', '/api/forum/threads/nope/poll', { question: 'q', options: ['a', 'b'] })).status, 404, 'missing thread → 404');
    }

    console.log('\nTest 3: voting — one vote per member');
    {
      const [horror, comedy, scifi] = poll.options.map((o) => o.id);
      let r = await call('emily', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: horror });
      assertEq([r.status, r.body.myVote, r.body.totalVotes], [200, horror, 1], 'emily votes horror');
      assertEq(r.body.canManage, false, 'emily cannot manage tyler\'s poll');
      await call('tyler', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: horror });
      r = await call('admin', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: comedy });
      assertEq(r.body.options.map((o) => [o.votes, o.percent]), [[2, 67], [1, 33], [0, 0]], 'tallies and percentages');
      r = await call('emily', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: scifi });
      assertEq([r.body.totalVotes, r.body.myVote], [3, scifi], 're-voting moves the vote, total unchanged');
      assertEq(db.prepare('SELECT COUNT(*) c FROM forum_poll_votes WHERE poll_id = ?').get(poll.id).c, 3, 'one row per voter');
      const otherPollOption = (await call('admin', 'GET', `/api/forum/threads/${plain.id}`)).body.poll.options[0].id;
      for (const [body, label] of [[{ optionId: otherPollOption }, 'another poll\'s option'], [{ optionId: '1' }, 'a string id'], [{}, 'no option']]) {
        const bad = await call('emily', 'POST', `/api/forum/polls/${poll.id}/vote`, body);
        assertEq([bad.status, bad.body.error], [400, 'invalid_option'], `${label} → 400 invalid_option`);
      }
      r = await call('emily', 'DELETE', `/api/forum/polls/${poll.id}/vote`);
      assertEq([r.status, r.body.myVote, r.body.totalVotes], [200, null, 2], 'retracting removes the vote');
      await call('emily', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: horror });
    }

    console.log('\nTest 4: close / reopen');
    {
      assertEq((await call('emily', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: true })).status, 403, 'non-starter cannot close');
      assertEq((await call('tyler', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: 'yes' })).status, 400, 'closed must be boolean');
      let r = await call('tyler', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: true });
      assertEq([r.status, r.body.closed], [200, true], 'starter closes the poll');
      r = await call('emily', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: poll.options[1].id });
      assertEq([r.status, r.body.error], [409, 'poll_closed'], 'voting on a closed poll → 409');
      assertEq((await call('emily', 'DELETE', `/api/forum/polls/${poll.id}/vote`)).status, 409, 'retracting on a closed poll → 409');
      r = await call('admin', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: false });
      assertEq([r.status, r.body.closed, r.body.closesAt], [200, false, null], 'admin reopens it');
      db.prepare("UPDATE forum_polls SET closes_at = datetime('now', '-1 minute') WHERE id = ?").run(poll.id);
      assertEq((await call('emily', 'GET', `/api/forum/threads/${thread.id}`)).body.poll.closed, true, 'a passed closes_at reads as closed');
      await call('tyler', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: false });
    }

    console.log('\nTest 5: read models');
    {
      const tv = (await call('emily', 'GET', `/api/forum/threads/${thread.id}`)).body;
      assert(tv.poll && tv.poll.id === poll.id && tv.poll.myVote === poll.options[0].id, 'thread view carries the poll and my vote');
      assertEq((await call('emily', 'GET', `/api/forum/threads/${plain.id}`)).body.poll.question, 'admin poll', 'each thread its own poll');
      const third = (await call('emily', 'POST', '/api/walls/household/posts', { kind: 'text', title: 'still no poll', text_body: 'nope' })).body;
      assertEq((await call('emily', 'GET', `/api/forum/threads/${third.id}`)).body.poll, null, 'thread without a poll → poll: null');
      const list = (await call('emily', 'GET', '/api/forum/boards/household/threads')).body.threads;
      const flag = (id) => (list.find((t) => t.id === id) || {}).hasPoll;
      assertEq([flag(thread.id), flag(plain.id), flag(third.id)], [true, true, false], 'thread list flags hasPoll');
      let cur = (await call('emily', 'GET', '/api/forum/polls/current')).body.poll;
      assertEq([cur && cur.id, cur && cur.threadTitle, cur && cur.board.slug], [byAdminId(db, plain.id), 'no poll here', 'household'], 'sidebar shows the newest open poll');
      await call('admin', 'PATCH', `/api/forum/polls/${cur.id}`, { closed: true });
      cur = (await call('emily', 'GET', '/api/forum/polls/current')).body.poll;
      assertEq(cur && cur.id, poll.id, 'an open poll beats a newer closed one');
      await call('tyler', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: true });
      cur = (await call('emily', 'GET', '/api/forum/polls/current')).body.poll;
      assert(cur && cur.closed, 'with every poll closed, the sidebar shows the newest closed one');
      await call('tyler', 'PATCH', `/api/forum/polls/${poll.id}`, { closed: false });
    }

    console.log('\nTest 6: privacy — a poll exists only where its thread does');
    {
      db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('stranger','Stranger','#000','x',0)").run();
      const s = (m, p, b) => call('stranger', m, p, b, 'outsiders');
      assertEq((await s('POST', `/api/forum/polls/${poll.id}/vote`, { optionId: poll.options[0].id })).status, 404, 'non-member vote → 404');
      assertEq((await s('PATCH', `/api/forum/polls/${poll.id}`, { closed: true })).status, 404, 'non-member close → 404');
      assertEq((await s('GET', '/api/forum/polls/current')).body.poll, null, 'non-member sidebar → no poll');
      assertEq((await call(null, 'GET', '/api/forum/polls/current')).status, 401, 'unauthenticated → 401');
      assertEq((await call('emily', 'POST', '/api/forum/polls/nope/vote', { optionId: 1 })).status, 404, 'unknown poll → 404');
    }

    console.log('\nTest 7: app-token scopes');
    {
      const { scopesForApiRoute } = require('../lib/scope-display');
      assertEq(scopesForApiRoute('GET', '/api/forum/polls/current'), ['read:walls'], 'GET current needs read:walls');
      assertEq(scopesForApiRoute('POST', `/api/forum/polls/${poll.id}/vote`), ['write:walls:react'], 'vote needs write:walls:react');
      assertEq(scopesForApiRoute('POST', `/api/forum/threads/${thread.id}/poll`), ['write:walls:post'], 'create needs write:walls:post');
    }

    console.log('\nTest 8: deleting the thread cascades its poll');
    {
      const r = await call('tyler', 'DELETE', `/api/walls/household/posts/${thread.id}`);
      assertEq(r.status, 200, 'starter deletes the thread');
      const left = ['forum_polls', 'forum_poll_votes', 'forum_poll_options'].map((t) =>
        db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${t === 'forum_polls' ? 'id' : 'poll_id'} = ?`).get(poll.id).c);
      assertEq(left, [0, 0, 0], 'poll, options and votes are gone');
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

function byAdminId(db, postId) {
  const r = db.prepare('SELECT id FROM forum_polls WHERE post_id = ?').get(postId);
  return r && r.id;
}
