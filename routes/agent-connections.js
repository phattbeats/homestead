// PHA-3198 (PHA-1647): split server.js into Express routers.
//
// This is the FIRST domain extraction — agent-connections (pairing +
// the PHA-3116 events route) — chosen because that surface already
// missed a mount once (PHA-2883 report: tests green against a stand-in
// listener while prod returned 404 for POST /api/agent-connections/:id/events
// — see server.js history for the PHA-3116 wire-up).
//
// Pattern (per the PHA-3198 spec):
//   routes/<domain>.js exports a factory that takes the shared deps
//   (db, authenticate, mailbox, …) and returns an Express Router with
//   just this domain's endpoints. server.js mounts it via
//     app.use('/api/agent-connections', agentConnectionsRouter({ ... }));
//   so the URL paths stay byte-identical (no /api prefix re-prefix).
//
// Behavior must not change: this file is a pure relocation of the five
// handlers that previously lived at server.js L2339–L2554. Test
// scripts/test-agent-connections.js (HTTP integration test, exercises
// live routes against a real server.js) and
// scripts/test-3116-events-route.js (signed-body HMAC path) are the
// acceptance gates; both must stay green with no edits.
//
// What depends on what:
//   - `db`:    better-sqlite3 instance from server.js (lib/agent-connections.js
//              queries it directly; no DI on the lib side).
//   - `auth`:  the four-layer authenticate() middleware (PAT / header-trust
//              / session / 401) — defined in server.js, exposed here as a
//              reference rather than re-defined, so a future middleware
//              change still propagates by editing one place.
//   - `userModel`: lib/user-model.js — getMe / validateUsername.
//   - `agentConnections`: lib/agent-connections.js — mint / redeem /
//              rename / rotateSecret / revoke / get / verifySignature /
//              validateRequestId / purgeOldReplays / recordReplay /
//              recordDispatch / STATUS_*.
//   - `mailbox`: lib/porch/mailbox.js — postMessage.

'use strict';

const { Router } = require('express');

module.exports = function agentConnectionsRouter({
  db,
  auth,
  userModel,
  agentConnections,
  mailbox,
}) {
  if (!db) throw new Error('agentConnectionsRouter: db is required');
  if (!auth) throw new Error('agentConnectionsRouter: auth is required');
  if (!userModel) throw new Error('agentConnectionsRouter: userModel is required');
  if (!agentConnections) throw new Error('agentConnectionsRouter: agentConnections is required');
  if (!mailbox) throw new Error('agentConnectionsRouter: mailbox is required');

  const r = Router();

  // GET /api/agent-connections — own connections, or (admin + ?user=)
  // another user's.
  r.get('/', auth, (req, res) => {
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) return res.status(401).json({ error: 'unknown_user' });
    if (req.query.user) {
      if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
      const target = db.prepare('SELECT id FROM users WHERE username = ?').get(userModel.validateUsername(req.query.user) || '');
      if (!target) return res.status(404).json({ error: 'not found' });
      return res.json(agentConnections.list(db, target.id));
    }
    res.json(agentConnections.list(db, me.id));
  });

  // POST /api/agent-connections/pair — mint a pairing code for a provider
  // tile. Returns the connection row plus the one-time pairing code and
  // its expiry.
  r.post('/pair', auth, (req, res) => {
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) return res.status(401).json({ error: 'unknown_user' });
    const { provider, label = '', scopes = [] } = req.body || {};
    try {
      const minted = agentConnections.mintPairingCode(db, me.id, { provider, label, scopes });
      res.json(minted);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/agent-connections/redeem-pairing-code — the local companion
  // redeems a code while session-authenticated as the SAME user who
  // minted it. Single-use, 10 min TTL. Returns the connection plus the
  // one-time plaintext secret on success.
  r.post('/redeem-pairing-code', auth, (req, res) => {
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) return res.status(401).json({ error: 'unknown_user' });
    const { code } = req.body || {};
    const redeemed = agentConnections.redeemPairingCode(db, code, { userId: me.id });
    if (!redeemed) return res.status(400).json({ error: 'invalid_or_expired_code' });
    res.json(redeemed);
  });

  // PATCH /api/agent-connections/:id — rename (label only), or
  // rotate_secret=true / revoke=true for the corresponding action.
  // rotate and revoke are mutually exclusive with a plain rename in one
  // call — each PATCH performs exactly one of rename/rotate/revoke so the
  // one-time secret reveal semantics stay unambiguous.
  r.patch('/:id', auth, (req, res) => {
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) return res.status(401).json({ error: 'unknown_user' });
    const { label, rotate_secret = false, revoke = false } = req.body || {};
    try {
      let updated;
      if (revoke) {
        updated = agentConnections.revoke(db, req.params.id, { ownerUserId: me.id });
      } else if (rotate_secret) {
        updated = agentConnections.rotateSecret(db, req.params.id, { ownerUserId: me.id });
      } else if (label !== undefined) {
        updated = agentConnections.rename(db, req.params.id, label, { ownerUserId: me.id });
      } else {
        return res.status(400).json({ error: 'nothing to update' });
      }
      if (!updated) return res.status(404).json({ error: 'not found' });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PHA-3116: POST /api/agent-connections/:id/events — the inbound route
  // the Homestead companion CLI's `relay-one-event` posts to. Each
  // companion holds a per-connection plaintext secret returned once at
  // pairing-redemption time; every event body is signed with
  //   X-Homestead-Signature: sha256=HMAC_SHA256(secret, ts + "." + rawBody)
  // (same HMAC construction as lib/agent-endpoints.js's signPayload,
  // verified via lib/agent-connections.js's verifySignature with a 5-min
  // replay window).
  //
  // The route is NOT session-authenticated — the companion runs on the
  // user's machine, may run while no Homestead session is active, and
  // the wire signature is the auth. We trust the connection's stored
  // secret (rotation invalidates all events signed with the old secret).
  //
  // The event body is handed to lib/porch/mailbox.postMessage as
  //   { appId, localUserId, threadKey, topic, body, direction: 'inbound' }
  // where appId = connection.provider (one of openclaw / claude_code /
  // codex) so mailbox isolation is preserved. The companion never sees
  // or stores OAuth cookies for the harness; only the companion secret
  // stays in the user-side companion state. Homestead never persists
  // any cookie/token alongside the event.
  r.post('/:id/events', (req, res) => {
    const connectionId = Number(req.params.id);
    if (!Number.isInteger(connectionId) || connectionId <= 0) {
      return res.status(400).json({ error: 'invalid_connection_id' });
    }
    const rawRequestId = req.get('X-Homestead-Request-Id');
    const timestamp = req.get('X-Homestead-Timestamp');
    const signature = req.get('X-Homestead-Signature');
    if (!rawRequestId || !timestamp || !signature) {
      return res.status(401).json({
        error: 'missing_signature_headers',
        required: ['X-Homestead-Request-Id', 'X-Homestead-Timestamp', 'X-Homestead-Signature'],
      });
    }
    // PHA-3199: reject malformed request ids before we touch any crypto
    // path — non-empty, max 128 chars, charset [A-Za-z0-9._-]. A
    // missing/oversized/junk-id is the same bucket as a missing header
    // (you can't be a real companion if you can't format an id).
    const requestId = agentConnections.validateRequestId(rawRequestId);
    if (!requestId) {
      return res.status(401).json({
        error: 'invalid_request_id',
        maxLength: 128,
        charset: 'A-Za-z0-9._-',
      });
    }
    // The PHA-3116 events route is the ONLY path that reads the stored
    // signing secret in steady state (mint/redeem/rotate are the other
    // three). Pass includeSecretPlaintext=true so toPublic surfaces
    // `secret_plaintext` for the signature check below; the value is
    // never sent back to the client — it lives only in this handler's
    // local scope for the duration of one request. ownerUserId is set
    // to the connection's actual owner so the existing toPublic owner
    // gate (which only releases the secret to the connection's owner)
    // passes; the secret never leaves this handler.
    const firstRow = db.prepare('SELECT user_id FROM agent_connections WHERE id = ?').get(connectionId);
    if (!firstRow) return res.status(404).json({ error: 'not_found' });
    const connection = agentConnections.get(db, connectionId, { ownerUserId: firstRow.user_id, includeSecretPlaintext: true });
    if (!connection) return res.status(404).json({ error: 'not_found' });
    if (connection.status === agentConnections.STATUS_REVOKED) {
      return res.status(410).json({ error: 'connection_revoked' });
    }
    if (connection.status !== agentConnections.STATUS_ACTIVE) {
      return res.status(409).json({ error: 'connection_not_active', status: connection.status });
    }
    // PHA-3199: fail closed on missing rawBody. The verify hook in the
    // express.json({ verify }) middleware above stashes req.rawBody when
    // it sees a non-empty Buffer. If it's missing (empty body, wrong
    // Content-Type, body parser short-circuited, etc.) there is NOTHING
    // we can HMAC that the client also signed — any fallback we cooked
    // up server-side would not match what a real companion sent. We do
    // NOT fall back to JSON.stringify(req.body): Express's JSON.parse
    // can re-order object keys, drop whitespace, and lose information;
    // a client signing one document and a server signing another is a
    // false-positive signing risk. Hard 401 + an explicit error code so
    // the companion logs something useful.
    const rawBody = req.rawBody;
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      return res.status(401).json({ error: 'raw_body_unavailable' });
    }
    if (!agentConnections.verifySignature(connection.secret_plaintext, timestamp, rawBody, signature)) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    // PHA-3199: signature is good. Now check the replay ledger BEFORE we
    // write to the mailbox so a duplicate request id never produces a
    // second inbound message. Cheap GC on the way in keeps the table
    // bounded to the last 6 minutes of activity.
    agentConnections.purgeOldReplays(db);
    const fresh = agentConnections.recordReplay(db, {
      connectionId: connection.id,
      requestId,
    });
    if (!fresh) {
      // We log the duplicate as a bookkeeping row but DO NOT surface
      // the request id back to the caller (echoing attacker-supplied
      // input is a habit we don't need). 409 is the spec'd response.
      try {
        agentConnections.recordDispatch(db, connection.id, { statusCode: 409, error: 'replay_detected' });
      } catch (_) { void _; }
      return res.status(409).json({ error: 'replay_detected' });
    }
    const { threadKey, topic, body, wallSlug } = req.body || {};
    if (typeof threadKey !== 'string' || !threadKey) {
      return res.status(400).json({ error: 'threadKey_required' });
    }
    if (typeof topic !== 'string' || !topic) {
      return res.status(400).json({ error: 'topic_required' });
    }
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body_required' });
    }
    try {
      // appId = connection.provider so the mailbox isolation guarantee
      // (one app can only read/write its own threads) is preserved
      // without a separate provider<->app_id mapping table.
      const message = mailbox.postMessage(db, {
        appId: connection.provider,
        localUserId: connection.user_id,
        threadKey,
        topic,
        body,
        direction: 'inbound',
        fromIdentity: connection.label || connection.provider,
        wallSlug: typeof wallSlug === 'string' ? wallSlug : undefined,
      });
      // Bookkeeping: stamp last_used_at + last_status_code so future
      // diagnostics can see the connection is actively firing.
      try {
        agentConnections.recordDispatch(db, connection.id, { statusCode: 200 });
      } catch (_) { void _; }  // best-effort: swallow bookkeeping error
      res.status(202).json({ accepted: true, requestId, messageId: message.id });
    } catch (e) {
      try {
        agentConnections.recordDispatch(db, connection.id, { statusCode: 500, error: String(e && e.message || e) });
      } catch (_) { void _; }  // best-effort: swallow bookkeeping error
      res.status(500).json({ error: 'mailbox_post_failed' });
    }
  });

  return r;
};