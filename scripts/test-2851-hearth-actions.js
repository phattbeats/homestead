#!/usr/bin/env node
// PHA-2851 acceptance — Hearth's inbound action surface.
//
// The drawer demo promises "queue Part Two" and "tell him the meme was
// mid" do something. This asserts they do, and — just as important —
// that the ways they can fail are visible rather than silent.
//
// Four groups, no network anywhere:
//
//   1. **REST surface (real server, session auth)**
//      - enqueue-media writes a media_queue row AND a wall post the
//        user can actually see.
//      - the action is idempotent: "queue it" twice is one row and one
//        announcement.
//      - mention-user writes a real mention row and reports a real
//        delivered count.
//
//   2. **Negative paths (issue acceptance §3)**
//      - no permission → 403 `not_reachable` (target shares no wall).
//      - no scope     → 403 `insufficient_scope` (app-scoped PAT).
//      - no model key → the drawer renders the existing
//        "Hearth needs a model key" reply, not a silent failure.
//      - bad arguments → 400 naming the offending field.
//
//   3. **Runtime tool loop (hermetic fake provider)**
//      - a streamed `tool_calls` delta, fragmented the way real
//        providers fragment it, is reassembled and executed.
//      - round 1 carries the tool block, round 2 does not (the loop is
//        bounded by construction, not by good intentions).
//      - outcomes come back as toolResults for the drawer's chips.
//
//   4. **Malformed tool arguments**
//      - unparseable `arguments` never reaches the action, and surfaces
//        as a failed chip rather than a success the model invented.
//
// Run: `node scripts/test-2851-hearth-actions.js`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentTokens = require('../lib/agent-tokens');
const agentRuntime = require('../lib/agent-runtime');
const hearthActions = require('../lib/hearth-actions');

let pass = 0;
let fail = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Harness: boot the real server against a throwaway DATA_DIR.
// ---------------------------------------------------------------------------
//
// Same shape as scripts/test-drawer-backend.js — server.js opens
// DATA_DIR/life.db itself and runs every migration, so the routes under
// test are the real ones with the real middleware chain, not a
// re-implementation.

function bootServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pha2851-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const server = http.createServer(app);
  const db = new Database(path.join(tmpDir, 'life.db'));
  return { app, server, db, tmpDir };
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const request = (opts, body) => new Promise((res2, rej2) => {
        const req = http.request({ host: '127.0.0.1', port, ...opts }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(raw); } catch (_) { /* not json */ }
            res2({ status: r.statusCode, headers: r.headers, body: json, raw });
          });
        });
        req.on('error', rej2);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
      resolve({ port, request });
    });
  });
}

async function login(request, username) {
  const r = await request(
    { path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { username, password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' }
  );
  if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.raw}`);
  return (r.headers['set-cookie'] || [])[0];
}

const jsonPost = (cookie, path_) => ({
  path: path_, method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
});

// ---------------------------------------------------------------------------
// Fake provider: a fetchImpl that replays scripted SSE bodies.
// ---------------------------------------------------------------------------
//
// `arguments` is split across several deltas on purpose. Every real
// OpenAI-compatible gateway streams it that way, and a parser that only
// works when the JSON arrives whole is a parser that works in tests and
// nowhere else.

function sseBody(blocks) {
  const text = blocks.map((b) => `data: ${JSON.stringify(b)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
  };
}

function scriptedFetch(responses, seen) {
  let i = 0;
  return async (url, init) => {
    seen.push(JSON.parse(init.body));
    const r = responses[i++];
    if (!r) throw new Error('fake provider: script exhausted');
    return r();
  };
}

const FAKE_CFG = {
  provider: 'litellm',
  baseUrl: 'http://fake.invalid',
  apiKey: 'k',
  model: 'fake-model',
};

// ---------------------------------------------------------------------------

async function main() {
  agentRuntime.__test__.setSystemPromptLoader(() => ({
    text: 'You are Hearth.', soulSha: 'x', identitySha: 'y', soulPath: '', identityPath: '',
  }));

  const { server, db, tmpDir } = bootServer();
  const { request } = await startServer(server);

  try {
    // -----------------------------------------------------------------
    console.log('\n1. REST surface — the actions the drawer demo promises');
    // -----------------------------------------------------------------
    const brandon = await login(request, 'brandon');
    const me = db.prepare("SELECT id, username FROM users WHERE username = 'brandon'").get();
    ok(!!me, 'brandon is a seeded user');

    // A synced Plex work, so the action can resolve a real title rather
    // than echoing a rating key back at the user.
    db.prepare(`
      INSERT INTO entities (id, kind, name, slug, meta_json, created_at, updated_at, created_by,
                            source_service, source_id, name_lower)
      VALUES ('e-part-two', 'work', 'Dune: Part Two', 'dune-part-two', '{}',
              datetime('now'), datetime('now'), 'test', 'plex', '55501', 'dune: part two')
    `).run();

    const q1 = await request(jsonPost(brandon, '/api/actions/enqueue-media'),
      { source: 'plex', id: '55501' });
    eq(q1.status, 200, 'POST /api/actions/enqueue-media → 200');
    ok(!!(q1.body && q1.body.queueId), 'returns a queueId');
    ok(!!(q1.body && q1.body.wallPostId), 'returns a wallPostId');
    eq(q1.body && q1.body.title, 'Dune: Part Two', 'resolved the title from the entity graph');

    const queueRow = db.prepare('SELECT * FROM media_queue WHERE id = ?').get(q1.body.queueId);
    ok(!!queueRow, 'media_queue row exists');
    eq(queueRow && queueRow.user_id, me.id, 'queue row belongs to the caller');
    eq(queueRow && queueRow.source_id, '55501', 'queue row carries the source id');

    const postRow = db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(q1.body.wallPostId);
    ok(!!postRow, 'wall post exists');
    ok(postRow && postRow.text_body.startsWith('🕒 Queued via Hearth:'),
      'wall post carries the announcement text', postRow && postRow.text_body);
    ok(postRow && postRow.text_body.includes('Dune: Part Two'),
      'wall post names the title');
    eq(postRow && postRow.author_user_id, me.id, 'post is authored by the user, not a ghost account');

    // The post has to be visible through the wall the user actually
    // reads — a row in the table nobody's feed selects is not "a visible
    // post on the user's wall".
    const feed = await request({
      path: `/api/walls/${q1.body.wallSlug}/posts`, method: 'GET', headers: { Cookie: brandon },
    });
    eq(feed.status, 200, 'GET the wall feed → 200');
    ok((feed.body.posts || feed.body || []).some
      ? JSON.stringify(feed.body).includes(q1.body.wallPostId)
      : false, 'the queued post is in the wall feed');

    // Idempotency.
    const q2 = await request(jsonPost(brandon, '/api/actions/enqueue-media'),
      { source: 'plex', id: '55501' });
    eq(q2.status, 200, 'queueing the same thing twice → 200');
    eq(q2.body && q2.body.queueId, q1.body.queueId, 'same queueId returned');
    eq(q2.body && q2.body.alreadyQueued, true, 'reported as already queued');
    eq(db.prepare('SELECT COUNT(*) n FROM media_queue WHERE user_id = ?').get(me.id).n, 1,
      'still exactly one queue row');
    eq(db.prepare("SELECT COUNT(*) n FROM wall_posts WHERE text_body LIKE '🕒 Queued via Hearth:%'").get().n, 1,
      'still exactly one announcement — no duplicate wall spam');

    // mention-user.
    const emily = db.prepare("SELECT id FROM users WHERE username = 'emily'").get();
    ok(!!emily, 'emily is a seeded user');
    // Pin emily out of quiet hours (start === end means "never quiet",
    // per notifications.isInQuietHours). Without this the delivered
    // count would depend on what time of day CI happens to run.
    db.prepare(`
      INSERT INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour)
      VALUES (?, 0, 0)
      ON CONFLICT(user_id) DO UPDATE SET quiet_start_hour = 0, quiet_end_hour = 0
    `).run(emily.id);
    const m1 = await request(jsonPost(brandon, '/api/actions/mention-user'),
      { username: 'emily', message: 'the meme was mid' });
    eq(m1.status, 200, 'POST /api/actions/mention-user → 200');
    ok(!!(m1.body && m1.body.mentionId), 'returns a mentionId');
    ok(typeof (m1.body && m1.body.delivered) === 'number', 'returns a delivered count');

    const mentionRow = db.prepare('SELECT * FROM mentions WHERE id = ?').get(m1.body.mentionId);
    ok(!!mentionRow, 'mention row exists');
    eq(mentionRow && mentionRow.mentioned_user_id, emily.id, 'mention points at emily');
    eq(mentionRow && mentionRow.mentioned_by, me.id, 'mention is attributed to the caller');

    const mentionPost = db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(m1.body.postId);
    ok(mentionPost && mentionPost.text_body.includes('@emily'),
      'the post @-mentions emily so the existing machinery sees it');
    ok(mentionPost && mentionPost.text_body.includes('the meme was mid'),
      'the message survives intact');

    const notif = db.prepare(`
      SELECT * FROM notification_log WHERE user_id = ? AND category = 'mention'
    `).get(emily.id);
    ok(!!notif, 'a mention notification row was written for emily');
    eq(m1.body.delivered, 1, 'delivered count matches the row that was actually written');

    // "Only if the target has notifications enabled for this surface":
    // with the wall muted, the mention row still exists (the message was
    // delivered to the wall) but Hearth reports 0 notified rather than
    // claiming a ping that never fired.
    const wallId = db.prepare('SELECT id FROM walls WHERE slug = ?').get(m1.body.wallSlug).id;
    db.prepare(`
      INSERT INTO wall_notification_prefs (wall_id, user_id, level, via)
      VALUES (?, ?, 'none', 'user_groups')
      ON CONFLICT(wall_id, user_id) DO UPDATE SET level = 'none'
    `).run(wallId, emily.id);
    const muted = await request(jsonPost(brandon, '/api/actions/mention-user'),
      { username: 'emily', message: 'and this one too' });
    eq(muted.status, 200, 'mentioning someone who muted the wall → 200');
    ok(!!(muted.body && muted.body.mentionId), 'the mention row is still written');
    eq(muted.body && muted.body.delivered, 0, 'delivered count is honestly 0');
    db.prepare('DELETE FROM wall_notification_prefs WHERE wall_id = ? AND user_id = ?').run(wallId, emily.id);

    // -----------------------------------------------------------------
    console.log('\n2. Negative paths — visible failure, not silent failure');
    // -----------------------------------------------------------------

    // No permission: a user who shares no wall with the caller.
    db.prepare(`
      INSERT INTO users (username, display, color, pass_hash, preferences, is_admin)
      VALUES ('stranger', 'Stranger', '#888', '', '{}', 0)
    `).run();
    const denied = await request(jsonPost(brandon, '/api/actions/mention-user'),
      { username: 'stranger', message: 'hello' });
    eq(denied.status, 403, 'mentioning an unreachable user → 403');
    eq(denied.body && denied.body.error, 'not_reachable', 'error is not_reachable');
    ok(!!(denied.body && denied.body.message), 'carries a message the drawer can render');
    eq(db.prepare("SELECT COUNT(*) n FROM wall_posts WHERE text_body LIKE '%hello%'").get().n, 0,
      'nothing was posted on the refused path');

    const unknown = await request(jsonPost(brandon, '/api/actions/mention-user'),
      { username: 'nobodyhere', message: 'hi' });
    eq(unknown.status, 404, 'mentioning an unknown user → 404');
    eq(unknown.body && unknown.body.error, 'unknown_user', 'error is unknown_user');

    // Bad arguments name the field they rejected.
    const badSource = await request(jsonPost(brandon, '/api/actions/enqueue-media'),
      { source: 'netflix', id: '1' });
    eq(badSource.status, 400, 'an unsupported source → 400');
    eq(badSource.body && badSource.body.field, 'source', 'names the offending field');

    const missingId = await request(jsonPost(brandon, '/api/actions/enqueue-media'),
      { source: 'plex' });
    eq(missingId.status, 400, 'a missing id → 400');
    eq(missingId.body && missingId.body.field, 'id', 'names the offending field');

    // No scope: an app-scoped PAT that never asked for these actions.
    const pat = agentTokens.issue(db, me.id, {
      label: 'pha2851 scope test',
      scopes: JSON.stringify(['read:me']),
    });
    const scoped = await request({
      path: '/api/actions/enqueue-media', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pat.token_plaintext}` },
    }, { source: 'plex', id: '999' });
    eq(scoped.status, 403, 'an app token without the scope → 403');
    eq(scoped.body && scoped.body.error, 'insufficient_scope', 'error is insufficient_scope');
    eq(scoped.body && scoped.body.required, 'write:actions:media_queue', 'names the scope it needed');

    const scopedOk = await request({
      path: '/api/actions/enqueue-media', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentTokens.issue(db, me.id, {
          label: 'pha2851 scoped ok',
          scopes: JSON.stringify(['write:actions:media_queue']),
        }).token_plaintext}`,
      },
    }, { source: 'kavita', id: '777' });
    eq(scopedOk.status, 200, 'an app token WITH the scope → 200');

    // No model key: the drawer's existing fallback, not a silent 500.
    // (No HEARTH_* key is set in this process, and brandon has a default
    // Hearth character once the runtime is asked for one.)
    const hearthCharacters = require('../lib/hearth-characters');
    hearthCharacters.seedDefaultHearthCharacter(db, me.id);
    const ep = await request(jsonPost(brandon, '/api/agent-endpoints'),
      { harness_label: 'test', kind: 'drawer', url: 'http://127.0.0.1:1/never' });
    ok(ep.status === 200 && ep.body && ep.body.id, 'created a drawer endpoint', ep.raw);
    const noKey = await request({
      path: '/api/drawer', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: brandon },
    }, { message: 'queue Part Two', endpoint_id: ep.body.id });
    eq(noKey.status, 200, 'drawer with no model key → 200 (the drawer is still alive)');
    eq(noKey.body && noKey.body.hearth_no_key, true, 'flagged as hearth_no_key');
    ok(noKey.body && /needs a model key/i.test(noKey.body.text || ''),
      'renders the "Hearth needs a model key" copy', noKey.body && noKey.body.text);

    // -----------------------------------------------------------------
    console.log('\n3. Runtime tool loop — the model asks, the server acts');
    // -----------------------------------------------------------------
    const executed = [];
    const surface = {
      specs: hearthActions.toolSpecs(),
      execute: (name, input) => {
        executed.push({ name, input });
        return { ok: true, action: name, result: { title: 'Dune: Part Two', source: 'plex' }, chip: 'queued Dune: Part Two' };
      },
    };

    const seen = [];
    const fetchImpl = scriptedFetch([
      // Round 1: a tool call, arguments fragmented across deltas.
      () => sseBody([
        { choices: [{ delta: { content: 'On it — ' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'enqueue_media', arguments: '{"sou' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'rce":"plex",' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"id":"55501"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 9 } },
      ]),
      // Round 2: narration.
      () => sseBody([
        { choices: [{ delta: { content: "Queued it. It's on your porch." }, finish_reason: 'stop' }] },
      ]),
    ], seen);

    const r = await agentRuntime.dispatchHearth({
      db, me, message: 'queue Part Two', conversationId: 'c1', requestId: 'r1',
      providerCfg: { ...FAKE_CFG, fetchImpl },
      actions: surface,
    });

    eq(r.ok, true, 'dispatch succeeded');
    eq(executed.length, 1, 'exactly one action executed');
    eq(executed[0] && executed[0].name, 'enqueue_media', 'the action the model named');
    ok(executed[0] && executed[0].input.source === 'plex' && executed[0].input.id === '55501',
      'fragmented arguments reassembled correctly', JSON.stringify(executed[0] && executed[0].input));
    eq(r.toolResults.length, 1, 'one tool result came back');
    eq(r.toolResults[0].ok, true, 'tool result is a success');
    eq(r.toolResults[0].chip, 'queued Dune: Part Two', 'chip text is what the drawer renders');
    ok(r.text.includes('On it —') && r.text.includes('Queued it'),
      'both rounds of prose survive', r.text);

    eq(seen.length, 2, 'exactly two provider round-trips');
    ok(Array.isArray(seen[0].tools) && seen[0].tools.length === 2,
      'round 1 carried the tool block');
    ok(seen[0].tools.some(t => t.function.name === 'enqueue_media')
      && seen[0].tools.some(t => t.function.name === 'mention_user'),
      'both house-actions are offered');
    ok(!seen[0].tools.some(t => t.function.name === 'set_lights'),
      'set_lights is NOT offered — the porch has no lights');
    eq(seen[1].tools, undefined, 'round 2 carried NO tool block — the loop is bounded');
    ok(seen[1].messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'),
      'the tool result was fed back to the model');

    // -----------------------------------------------------------------
    console.log('\n4. Malformed tool arguments — a failed chip, not a fake success');
    // -----------------------------------------------------------------
    const executed2 = [];
    const seen2 = [];
    const r2 = await agentRuntime.dispatchHearth({
      db, me, message: 'queue something', conversationId: 'c2', requestId: 'r2',
      providerCfg: {
        ...FAKE_CFG,
        fetchImpl: scriptedFetch([
          () => sseBody([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'enqueue_media', arguments: '{not json' } }] }, finish_reason: 'tool_calls' }] },
          ]),
          () => sseBody([
            { choices: [{ delta: { content: "I couldn't parse that one." }, finish_reason: 'stop' }] },
          ]),
        ], seen2),
      },
      actions: {
        specs: hearthActions.toolSpecs(),
        execute: (name, input) => { executed2.push({ name, input }); return { ok: true, action: name, result: {}, chip: 'nope' }; },
      },
    });
    eq(executed2.length, 0, 'the action was never executed');
    eq(r2.toolResults.length, 1, 'the failure is still reported');
    eq(r2.toolResults[0].ok, false, 'reported as failed');
    eq(r2.toolResults[0].code, 'invalid_arguments', 'code is invalid_arguments');

    // A refused action is reported the same way — the drawer must be
    // able to say "that didn't happen" out loud.
    const r3 = await agentRuntime.dispatchHearth({
      db, me, message: 'tell stranger hi', conversationId: 'c3', requestId: 'r3',
      providerCfg: {
        ...FAKE_CFG,
        fetchImpl: scriptedFetch([
          () => sseBody([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_3', function: { name: 'mention_user', arguments: '{"username":"stranger","message":"hi"}' } }] }, finish_reason: 'tool_calls' }] },
          ]),
          () => sseBody([{ choices: [{ delta: { content: "I can't reach them." }, finish_reason: 'stop' }] }]),
        ], []),
      },
    });
    eq(r3.toolResults.length, 1, 'the refused action produced a tool result');
    eq(r3.toolResults[0].ok, false, 'reported as failed');
    eq(r3.toolResults[0].code, 'not_reachable', 'code is not_reachable — the real permission check ran');

    // -----------------------------------------------------------------
    console.log('\n5. Unit — tool-call delta accumulation');
    // -----------------------------------------------------------------
    const acc = new Map();
    agentRuntime.accumulateToolCallDeltas(acc, { delta: { tool_calls: [
      { index: 1, id: 'b', function: { name: 'mention_user', arguments: '{"user' } },
      { index: 0, id: 'a', function: { name: 'enqueue_media', arguments: '{"sour' } },
    ] } });
    agentRuntime.accumulateToolCallDeltas(acc, { delta: { tool_calls: [
      { index: 0, function: { arguments: 'ce":"plex","id":"1"}' } },
      { index: 1, function: { arguments: 'name":"emily","message":"yo"}' } },
    ] } });
    const calls = agentRuntime.collectToolCalls(acc);
    eq(calls.length, 2, 'two parallel calls reassembled');
    eq(calls[0].name, 'enqueue_media', 'sorted by index, not arrival order');
    eq(calls[0].arguments.id, '1', 'first call arguments parsed');
    eq(calls[1].arguments.username, 'emily', 'second call arguments parsed');
    ok(calls.every(c => !c.argumentsError), 'no parse errors');
  } finally {
    agentRuntime.__test__.resetSystemPromptLoader();
    try { db.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
