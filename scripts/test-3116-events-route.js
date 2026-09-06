#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC
//
// PHA-3116 + PHA-3199 — POST /api/agent-connections/:id/events
//   * PHA-3116: signed event body is accepted; unsigned/skewed/tampered
//     bodies are rejected; revoked and missing connections are rejected;
//     the event lands as a mailbox message.
//   * PHA-3199: same route, plus replay protection (Request-Id ledger)
//     and fail-closed on missing rawBody. A captured signed POST can no
//     longer be re-fired inside the 5-min skew window, and an
//     attacker-supplied empty body never sees a re-serialized hash.
//
// Acceptance test: signed event body is accepted; unsigned/skewed/tampered
// bodies are rejected; revoked and missing connections are rejected; the
// event lands as a mailbox message via lib/porch/mailbox.postMessage with
// the connection's scoped appId.
//
// Hits the REAL route (no throwaway stand-in listener), starts the real
// server in-process, signs requests with lib/agent-endpoints.js's
// signPayload (the exact same construction companion-cli uses), and
// reads back via /api/mailbox/threads.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let pass = 0;
let fail = 0;

function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (actual === expected) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

const agentEndpoints = require('../lib/agent-endpoints');
const agentConnections = require('../lib/agent-connections');

function httpRequest(base, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...base, ...opts }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* */ }
        resolve({ status: res.statusCode, body: json, headers: res.headers, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function signedHeaders(secret, rawBody) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(rawBody).toString(),
    'X-Homestead-Request-Id': crypto.randomUUID(),
    'X-Homestead-Timestamp': ts,
    'X-Homestead-Signature': agentEndpoints.signPayload(secret, ts, rawBody),
  };
}

function mailboxCallerCtx() { return {}; } // unused; routes hit via cookie

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-3116-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const db = app.db;
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', err => err ? reject(err) : resolve());
  });
  const port = server.address().port;
  const base = { hostname: '127.0.0.1', port };

  // PHA-3116 setup: seed installed_apps for the providers the test
  // exercises. The mailbox FK requires every app_id to exist in
  // installed_apps; in production the app is installed via the
  // consent flow (POST /api/apps/install), but for an in-process
  // acceptance test we seed directly — same pattern as test-mailbox.js.
  db.prepare(`INSERT INTO installed_apps (key, name, installed_by_user_id) VALUES (?, ?, ?)`)
    .run('openclaw', 'OpenClaw', 2);
  db.prepare(`INSERT INTO installed_apps (key, name, installed_by_user_id) VALUES (?, ?, ?)`)
    .run('claude_code', 'Claude Code', 2);
  db.prepare(`INSERT INTO installed_apps (key, name, installed_by_user_id) VALUES (?, ?, ?)`)
    .run('codex', 'Codex', 2);

  try {
    // Login as brandon (the seeded admin) so we can mint a connection.
    const login = await httpRequest(base, {
      path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ username: 'brandon', password: process.env.BRANDON_PASSWORD || 'changeme' }));
    assertEq(login.status, 200, 'login as brandon succeeds');
    const cookie = (login.headers['set-cookie'] || [])[0];
    assert(!!cookie, 'login returns a session cookie');

    // Mint a pairing code.
    const mint = await httpRequest(base, {
      path: '/api/agent-connections/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ provider: 'openclaw', label: 'phatt-claw' }));
    assertEq(mint.status, 200, 'pair mints a connection');
    const pairingCode = mint.body && mint.body.pairing_code;
    assert(!!pairingCode, 'mint returns a pairing_code');

    // Redeem the code (same user — companion pattern).
    const redeem = await httpRequest(base, {
      path: '/api/agent-connections/redeem-pairing-code', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ code: pairingCode }));
    assertEq(redeem.status, 200, 'redeem succeeds');
    const connectionId = redeem.body && redeem.body.id;
    const secret = redeem.body && redeem.body.secret_plaintext;
    assert(!!connectionId, 'redeem returns a connection id');
    assert(!!secret, 'redeem returns the one-time plaintext secret');

    // ------------------------------------------------------------------
    // 1. Happy path: signed event lands as a mailbox message.
    // ------------------------------------------------------------------
    console.log('\nTest 1: signed event lands in mailbox with the connection\'s scoped appId');
    const eventPayload = {
      threadKey: 'phatt-claw:standup',
      topic: 'phatt-claw standup',
      body: 'PHA-3116 acceptance: first signed event accepted.',
      wallSlug: 'household',
    };
    const eventBody = JSON.stringify(eventPayload);
    const goodHeaders = signedHeaders(secret, eventBody);
    const good = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId}/events`, method: 'POST',
      headers: goodHeaders,
    }, eventBody);
    assertEq(good.status, 202, 'signed event returns 202 Accepted');
    assert(good.body && good.body.accepted === true, '202 response carries accepted=true');
    assert(!!(good.body && good.body.messageId), '202 response carries messageId');

    // Read mailbox via cookie auth (same brandon user); the connection
    // is owned by brandon (user_id from redeem), so local mailbox
    // listings show the message with fromIdentity='phatt-claw'.
    const threads = await httpRequest(base, {
      path: '/api/mailbox/threads', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(threads.status, 200, 'GET /api/mailbox/threads returns 200');
    const threadList = threads.body && threads.body.threads;
    assert(Array.isArray(threadList) && threadList.length >= 1, 'mailbox lists at least one thread');
    const matchingThread = threadList.find(t => t.appId === 'openclaw');
    assert(!!matchingThread, 'thread is scoped to the connection provider appId (openclaw)');
    assertEq(matchingThread.appId, 'openclaw', 'thread.appId is openclaw');
    assertEq(matchingThread.localUserId, redeem.body.user_id, 'thread.localUserId is the connection owner');
    assertEq(matchingThread.wallSlug, 'household', 'thread.wallSlug defaults to household');
    const messages = await httpRequest(base, {
      path: `/api/mailbox/threads/${matchingThread.id}/messages`, method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(messages.status, 200, 'GET /api/mailbox/threads/:id/messages returns 200');
    const messageList = messages.body && messages.body.messages;
    assert(Array.isArray(messageList) && messageList.length >= 1, 'mailbox has at least one message');
    const firstMessage = messageList[messageList.length - 1];
    assert(firstMessage.body === eventPayload.body, 'mailbox message body matches signed event body');
    assert(firstMessage.direction === 'inbound', 'mailbox message is tagged inbound');
    assert(firstMessage.fromIdentity === 'phatt-claw', 'mailbox message fromIdentity is the connection label');

    // ------------------------------------------------------------------
    // 2. Tampered body — signature should not verify.
    // ------------------------------------------------------------------
    console.log('\nTest 2: tampered body fails signature check (401)');
    const tamperedBody = JSON.stringify({
      threadKey: 'phatt-claw:standup',
      topic: 'phatt-claw standup',
      body: 'tampered payload - different from what was signed',
      wallSlug: 'household',
    });
    // Sign the ORIGINAL eventBody, send the TAMPERED eventBody.
    const tamperedHeaders = signedHeaders(secret, eventBody);
    const tampered = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId}/events`, method: 'POST',
      headers: tamperedHeaders,
    }, tamperedBody);
    assertEq(tampered.status, 401, 'tampered body returns 401');
    assert(tampered.body && tampered.body.error === 'bad_signature', 'tampered body error is bad_signature');

    // ------------------------------------------------------------------
    // 3. Stale timestamp — outside the 5-minute replay window.
    // ------------------------------------------------------------------
    console.log('\nTest 3: stale timestamp fails signature check (401)');
    const staleBody = JSON.stringify({
      threadKey: 'phatt-claw:standup',
      topic: 'phatt-claw standup',
      body: 'an event signed an hour ago',
    });
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const staleHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(staleBody).toString(),
      'X-Homestead-Request-Id': crypto.randomUUID(),
      'X-Homestead-Timestamp': staleTs,
      'X-Homestead-Signature': agentEndpoints.signPayload(secret, staleTs, staleBody),
    };
    const stale = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId}/events`, method: 'POST',
      headers: staleHeaders,
    }, staleBody);
    assertEq(stale.status, 401, 'stale timestamp returns 401');
    assert(stale.body && stale.body.error === 'bad_signature', 'stale timestamp error is bad_signature');

    // ------------------------------------------------------------------
    // 4. Missing signature headers — 401.
    // ------------------------------------------------------------------
    console.log('\nTest 4: missing signature headers returns 401');
    const noSig = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId}/events`, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, eventBody);
    assertEq(noSig.status, 401, 'missing signature headers returns 401');
    assert(noSig.body && noSig.body.error === 'missing_signature_headers', 'missing-headers error code is correct');

    // ------------------------------------------------------------------
    // 5. Unknown connection id — 404.
    // ------------------------------------------------------------------
    console.log('\nTest 5: unknown connection id returns 404');
    const unknownBody = JSON.stringify({ threadKey: 't', topic: 't', body: 'b' });
    const unknownHeaders = signedHeaders(secret, unknownBody);
    const unknown = await httpRequest(base, {
      path: '/api/agent-connections/999999/events', method: 'POST',
      headers: unknownHeaders,
    }, unknownBody);
    assertEq(unknown.status, 404, 'unknown connection returns 404');

    // ------------------------------------------------------------------
    // 6. Invalid connection id format — 400.
    // ------------------------------------------------------------------
    console.log('\nTest 6: invalid connection id format returns 400');
    const badId = await httpRequest(base, {
      path: '/api/agent-connections/not-a-number/events', method: 'POST',
      headers: unknownHeaders,
    }, unknownBody);
    assertEq(badId.status, 400, 'invalid connection id returns 400');

    // ------------------------------------------------------------------
    // 7. Revoked connection — 410.
    // ------------------------------------------------------------------
    console.log('\nTest 7: revoked connection returns 410');
    const revoke = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ revoke: true }));
    assertEq(revoke.status, 200, 'PATCH revoke=true succeeds');
    const revokedBody = JSON.stringify({ threadKey: 't', topic: 't', body: 'b' });
    const revokedHeaders = signedHeaders(secret, revokedBody);
    const revoked = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId}/events`, method: 'POST',
      headers: revokedHeaders,
    }, revokedBody);
    assertEq(revoked.status, 410, 'revoked connection returns 410');
    assert(revoked.body && revoked.body.error === 'connection_revoked', 'revoked error code is connection_revoked');

    // ------------------------------------------------------------------
    // 8. Wrong secret — 401 (sanity check that the secret is actually used).
    // ------------------------------------------------------------------
    console.log('\nTest 8: signature from a different connection\'s secret returns 401');
    // Mint a second connection to get a different secret.
    const mint2 = await httpRequest(base, {
      path: '/api/agent-connections/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ provider: 'claude_code', label: 'cc' }));
    assertEq(mint2.status, 200, 'second pair mints a code');
    const redeem2 = await httpRequest(base, {
      path: '/api/agent-connections/redeem-pairing-code', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ code: mint2.body.pairing_code }));
    const connectionId2 = redeem2.body && redeem2.body.id;
    const secret2 = redeem2.body && redeem2.body.secret_plaintext;
    // Sign with secret2 but send to connectionId (which is revoked anyway,
    // so let's rotate one to a new active state by spinning a third
    // connection and cross-signing between them).
    // Simpler: sign with secret2 against connectionId2's URL, then
    // assert it succeeds (sanity); then sign with secret2 against
    // connectionId (different connection) — that should 401 because
    // verifySignature compares against the looked-up secret.
    // But connectionId is revoked (returns 410), so cross-sign returns
    // 410 not 401. Skip the cross-sign and just confirm isolation by
    // signing with a totally bogus secret.
    const bogusBody = JSON.stringify({ threadKey: 't', topic: 't', body: 'b' });
    const bogusHeaders = signedHeaders('totally_wrong_secret_' + 'x'.repeat(32), bogusBody);
    const bogus = await httpRequest(base, {
      path: `/api/agent-connections/${connectionId2}/events`, method: 'POST',
      headers: bogusHeaders,
    }, bogusBody);
    assertEq(bogus.status, 401, 'bogus secret returns 401');
    assert(bogus.body && bogus.body.error === 'bad_signature', 'bogus secret error is bad_signature');

    // ------------------------------------------------------------------
    // 9. Body validation — missing threadKey/topic/body all 400.
    // ------------------------------------------------------------------
    console.log('\nTest 9: body validation rejects missing fields');
    const missingFields = [
      { label: 'missing threadKey', payload: { topic: 't', body: 'b' } },
      { label: 'missing topic',     payload: { threadKey: 't', body: 'b' } },
      { label: 'missing body',      payload: { threadKey: 't', topic: 't' } },
      { label: 'blank body',        payload: { threadKey: 't', topic: 't', body: '   ' } },
    ];
    for (const { label, payload } of missingFields) {
      const raw = JSON.stringify(payload);
      const hdr = signedHeaders(secret2, raw);
      const resp = await httpRequest(base, {
        path: `/api/agent-connections/${connectionId2}/events`, method: 'POST',
        headers: hdr,
      }, raw);
      assertEq(resp.status, 400, `${label} returns 400`);
    }

    // ------------------------------------------------------------------
    // 10. PHA-3199: same Request-Id twice → second is 409, one mailbox row.
    //
    // Fresh connection for this test because connectionId was revoked
    // in Test 7 and we want a known-active state.
    // ------------------------------------------------------------------
    console.log('\nTest 10 (PHA-3199): replay of the same Request-Id returns 409');
    const mintReplay = await httpRequest(base, {
      path: '/api/agent-connections/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ provider: 'openclaw', label: 'replay-test' }));
    const redeemReplay = await httpRequest(base, {
      path: '/api/agent-connections/redeem-pairing-code', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, JSON.stringify({ code: mintReplay.body.pairing_code }));
    const replayConnId = redeemReplay.body.id;
    const replaySecret = redeemReplay.body.secret_plaintext;
    assert(!!replayConnId && !!replaySecret, 'replay-test connection is set up');

    const replayPayload = JSON.stringify({
      threadKey: 'replay:check',
      topic: 'replay test',
      body: 'first delivery — should land in mailbox',
      wallSlug: 'household',
    });
    const fixedReqId = crypto.randomUUID();
    const firstHeaders = signedHeaders(replaySecret, replayPayload);
    firstHeaders['X-Homestead-Request-Id'] = fixedReqId;
    const first = await httpRequest(base, {
      path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
      headers: firstHeaders,
    }, replayPayload);
    assertEq(first.status, 202, 'first delivery with unique id returns 202');

    // Resend the EXACT same headers+body — same Request-Id, same signature.
    const second = await httpRequest(base, {
      path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
      headers: firstHeaders,
    }, replayPayload);
    assertEq(second.status, 409, 'replay with same Request-Id returns 409');
    assert(second.body && second.body.error === 'replay_detected', 'replay error code is replay_detected');

    // Mailbox thread should have exactly ONE message from this connection.
    // threadId = `openclaw::replay:check` (lib/porch/mailbox.js's
    // `${appId}::${threadKey}` convention); we look it up directly
    // rather than relying on the topic field (the listing endpoint
    // doesn't return it on the summary row).
    const replayThreadId = 'openclaw::replay:check';
    const replayMessages = await httpRequest(base, {
      path: `/api/mailbox/threads/${replayThreadId}/messages`, method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(replayMessages.status, 200, 'replay thread messages endpoint returns 200');
    const matchingMsgs = replayMessages.body.messages.filter(m => m.body === 'first delivery — should land in mailbox');
    assertEq(matchingMsgs.length, 1, 'mailbox has exactly ONE message for the replayed body (duplicate was rejected)');

    // ------------------------------------------------------------------
    // 11. PHA-3199: two DIFFERENT Request-Ids, same body, both succeed.
    //
    // The replay ledger is keyed on request_id, not on (body, sig).
    // Two distinct deliveries (distinct ids) are independent events
    // even if their bodies happen to match — that mirrors Stripe's
    // Idempotency-Key model where the same payload sent twice with
    // different keys is two writes.
    // ------------------------------------------------------------------
    console.log('\nTest 11 (PHA-3199): two distinct Request-Ids, same body — both 202');
    const sameBody = JSON.stringify({
      threadKey: 'replay:check',
      topic: 'replay test',
      body: 'repeated payload, distinct ids',
      wallSlug: 'household',
    });
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const headersA = signedHeaders(replaySecret, sameBody);
    headersA['X-Homestead-Request-Id'] = idA;
    const headersB = signedHeaders(replaySecret, sameBody);
    headersB['X-Homestead-Request-Id'] = idB;
    const aResp = await httpRequest(base, {
      path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
      headers: headersA,
    }, sameBody);
    const bResp = await httpRequest(base, {
      path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
      headers: headersB,
    }, sameBody);
    assertEq(aResp.status, 202, 'delivery with id A returns 202');
    assertEq(bResp.status, 202, 'delivery with id B returns 202');

    // ------------------------------------------------------------------
    // 12. PHA-3199: missing req.rawBody → 401 raw_body_unavailable.
    //
    // The express.json({ verify }) hook only stashes rawBody when the
    // body parser actually saw a non-empty Buffer. If a client posts
    // an empty body (or a body Content-Type that bypasses json()),
    // req.rawBody is null/undefined — we must NOT fall back to
    // JSON.stringify(req.body) because Express re-serialization does
    // not byte-equal what the client signed.
    // ------------------------------------------------------------------
    console.log('\nTest 12 (PHA-3199): missing req.rawBody returns 401 raw_body_unavailable');
    const emptyBodyPayload = '';
    const ts12 = String(Math.floor(Date.now() / 1000));
    const emptyHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': '0',
      'X-Homestead-Request-Id': crypto.randomUUID(),
      'X-Homestead-Timestamp': ts12,
      'X-Homestead-Signature': agentEndpoints.signPayload(replaySecret, ts12, emptyBodyPayload),
    };
    const empty = await httpRequest(base, {
      path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
      headers: emptyHeaders,
    }, emptyBodyPayload);
    assertEq(empty.status, 401, 'empty rawBody returns 401');
    assert(empty.body && empty.body.error === 'raw_body_unavailable', 'empty-rawBody error code is raw_body_unavailable');

    // ------------------------------------------------------------------
    // 13. PHA-3199: invalid Request-Id (oversized, bad charset) → 401.
    //
    // Without this guard, an attacker can stuff arbitrary-length junk
    // into the replay ledger and blow up the table size, or smuggle
    // escape sequences into any future logging that interpolates the
    // id. Both are rejected up front.
    // ------------------------------------------------------------------
    console.log('\nTest 13 (PHA-3199): invalid Request-Id formats return 401 invalid_request_id');
    const badIdCases = [
      { label: 'oversized id (200 chars)', id: 'a'.repeat(200) },
      { label: 'id with whitespace', id: 'has spaces' },
      { label: 'id with slash', id: 'has/slash' },
      { label: 'id with semicolon', id: 'has;semicolon' },
      { label: 'id with non-ascii', id: 'has\u00e9accent' },
    ];
    for (const { label, id } of badIdCases) {
      const raw = JSON.stringify({
        threadKey: 'replay:check', topic: 'replay test',
        body: `bad-id test: ${label}`, wallSlug: 'household',
      });
      const hdr = signedHeaders(replaySecret, raw);
      hdr['X-Homestead-Request-Id'] = id;
      const resp = await httpRequest(base, {
        path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
        headers: hdr,
      }, raw);
      assertEq(resp.status, 401, `${label} returns 401`);
      assert(resp.body && resp.body.error === 'invalid_request_id', `${label} error is invalid_request_id`);
    }

    // ------------------------------------------------------------------
    // 14. PHA-3199: skew > 300s still returns 401 (regression guard).
    //
    // The replay table is the NEW replay guard; the timestamp check in
    // verifySignature is the EXISTING replay guard. Both must hold.
    // ------------------------------------------------------------------
    console.log('\nTest 14 (PHA-3199 backstop): skew > 300s still returns 401');
    const skewBody = JSON.stringify({
      threadKey: 'replay:check', topic: 'replay test',
      body: 'an event signed too long ago', wallSlug: 'household',
    });
    const skewTs = String(Math.floor(Date.now() / 1000) - 3600);
    const skewHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(skewBody).toString(),
      'X-Homestead-Request-Id': crypto.randomUUID(),
      'X-Homestead-Timestamp': skewTs,
      'X-Homestead-Signature': agentEndpoints.signPayload(replaySecret, skewTs, skewBody),
    };
    const skewResp = await httpRequest(base, {
      path: `/api/agent-connections/${replayConnId}/events`, method: 'POST',
      headers: skewHeaders,
    }, skewBody);
    assertEq(skewResp.status, 401, 'stale timestamp still returns 401');
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test-3116-events-route crashed:', err.stack || err.message);
  process.exit(1);
});
