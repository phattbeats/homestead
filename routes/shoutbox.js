// split server.js into Express routers.
//
// Fifth domain extracted — the Shoutbox: the household chat strip's
// read, write and live-feed surface.
//
// Pattern:
//   routes/<domain>.js exports a factory that takes the shared deps
//   (db, auth, tokenScopes, userModel, wallsErr) and returns an Express
//   Router with just this domain's endpoints. server.js mounts it via
//     app.use('/api', shoutboxRouter({ db, auth, tokenScopes, userModel, wallsErr }));
//   so the URL paths stay byte-identical (/api/shoutbox,
//   /api/shoutbox/events).
//
// The domain itself — schema, rate limit, prune, the Hearth chime gate
// and its timer — stays in lib/shoutbox.js. This module is HTTP only.
//
// Behavior must not change: this file is a pure relocation of the three
// handlers that previously lived at server.js L2839–L2864, plus the
// shoutCaller helper they share.
//
// What depends on what:
//   - `db`:          better-sqlite3 instance from server.js (userModel.getMe
//                    resolves the caller).
//   - `auth`:        the four-layer authenticate() middleware from
//                    server.js, referenced rather than re-defined.
//   - `tokenScopes`: scope probe from server.js. The shoutbox is
//                    household-wide and app-scoped tokens are refused
//                    outright — there is no scope for a shout, and a
//                    shout is spoken as the human, not as an app.
//   - `userModel`:   lib/user-model.js — getMe.
//   - `wallsErr`:    the shared error mapper from server.js (a shout that
//                    trips the rate limit or the phrase filter surfaces
//                    as { error: 'rate_limited' } / { error:
//                    'banned_phrase' }).
//
// The SSE handler owns a 25s keepalive interval and a wall-events
// subscription. BOTH must be released when the request closes, or every
// reconnecting client leaks one interval and one subscription. The
// cleanup is unchanged from the inline version; scripts/test-shoutbox-router.js
// guards that it survived the move.
//
// fail-closed check: an app-scoped token gets 403 before any caller
// lookup, so a third-party app can never post as the human. A caller
// who cannot be resolved gets 401, not an empty box.

'use strict';

const { Router } = require('express');

const shoutbox = require('../lib/shoutbox');
const wallEvents = require('../lib/wall-events');

module.exports = function shoutboxRouter({
  db,
  auth,
  tokenScopes,
  userModel,
  wallsErr,
}) {
  if (!db) throw new Error('shoutboxRouter: db is required');
  if (typeof auth !== 'function') throw new Error('shoutboxRouter: auth must be a function');
  if (typeof tokenScopes !== 'function') throw new Error('shoutboxRouter: tokenScopes must be a function');
  if (!userModel) throw new Error('shoutboxRouter: userModel is required');
  if (typeof wallsErr !== 'function') throw new Error('shoutboxRouter: wallsErr must be a function');

  const r = Router();

  // Household-wide, so any signed-in member may read and shout. App-scoped
  // tokens are refused outright: there is no scope for it, and a shout is
  // spoken as the human.
  function shoutCaller(req, res) {
    if (tokenScopes(req) !== null) { res.status(403).json({ error: 'insufficient_scope' }); return null; }
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) { res.status(401).json({ error: 'unknown_user' }); return null; }
    return me;
  }

  r.get('/shoutbox', auth, (req, res) => {
    if (!shoutCaller(req, res)) return;
    res.json(shoutbox.list({ limit: req.query.limit, afterId: req.query.after }));
  });

  r.post('/shoutbox', auth, (req, res) => {
    const me = shoutCaller(req, res); if (!me) return;
    try { res.status(201).json(shoutbox.post(me.id, (req.body || {}).body)); } catch (e) { wallsErr(res, e); }
  });

  // The live feed. Long-lived SSE on the reserved shoutbox channel — the
  // same wire format the wall stream uses, so the client can share it.
  r.get('/shoutbox/events', auth, (req, res) => {
    if (!shoutCaller(req, res)) return;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders && res.flushHeaders();
    res.write('retry: 3000\n');
    res.write(': connected\n\n');
    const unsubscribe = wallEvents.subscribe(shoutbox.CHANNEL, ({ event, data }) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  return r;
};
