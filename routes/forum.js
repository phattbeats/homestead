// The Forum: read API for the Woodgrain board UI, plus the
// standalone /forum page and the legacy /porch.html redirect.
//
// Extracted from server.js following the routes/health.js pattern, so the
// forum surface does not re-inflate server.js (scripts/test-health-router.js guards
// its line count). Paths are byte-identical to the inline handlers:
// server.js mounts this router at the app root.
//
// Boards are walls, threads are wall posts, replies are post comments —
// see lib/forum.js. Every handler resolves the caller then delegates; the
// membership gate (404 for boards you can't see) lives in lib/walls.js.
// App-scoped tokens need the blanket read:walls scope: forum views span
// every board, so a single-wall scope can't authorise them.

'use strict';

const path = require('path');
const { Router } = require('express');
const polls = require('../lib/forum-polls');

module.exports = function forumRouter({
  db,
  auth,
  requireAdmin,
  tokenScopes,
  userModel,
  forum,
  wallsErr,
  publicDir,
}) {
  const router = Router();

  function requireForumReadScope(req, res, next) {
    const scopes = tokenScopes(req);
    if (scopes === null || scopes.includes('read:walls')) return next();
    return res.status(403).json({ error: 'insufficient_scope', required: 'read:walls' });
  }
  function forumCaller(req, res) {
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) { res.status(401).json({ error: 'unknown_user' }); return null; }
    forum.touchActivity(me.id);
    return me;
  }

  router.get('/api/forum/index', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.json(forum.boardIndex(me.id)); } catch (e) { wallsErr(res, e); }
  });
  router.get('/api/forum/boards/:slug/threads', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.json(forum.threadList(req.params.slug, me.id, { page: req.query.page, limit: req.query.limit })); }
    catch (e) { wallsErr(res, e); }
  });
  router.get('/api/forum/threads/:postId', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.json(forum.threadView(req.params.postId, me.id)); } catch (e) { wallsErr(res, e); }
  });
  router.patch('/api/forum/threads/:postId', auth, requireAdmin, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try {
      if (typeof (req.body || {}).sticky !== 'boolean') return res.status(400).json({ error: 'sticky_boolean_required' });
      res.json(forum.setSticky(req.params.postId, req.body.sticky));
    } catch (e) { wallsErr(res, e); }
  });
  // Thread polls (lib/forum-polls.js). Create/close: thread author or an
  // admin. Vote: any member who can see the thread, one vote each.
  router.get('/api/forum/polls/current', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.json({ poll: polls.current(me.id) }); } catch (e) { wallsErr(res, e); }
  });
  router.post('/api/forum/threads/:postId/poll', auth, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.status(201).json(polls.create(req.params.postId, me.id, req.body)); } catch (e) { wallsErr(res, e); }
  });
  router.post('/api/forum/polls/:pollId/vote', auth, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.json(polls.vote(req.params.pollId, me.id, (req.body || {}).optionId)); } catch (e) { wallsErr(res, e); }
  });
  router.delete('/api/forum/polls/:pollId/vote', auth, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try { res.json(polls.retract(req.params.pollId, me.id)); } catch (e) { wallsErr(res, e); }
  });
  router.patch('/api/forum/polls/:pollId', auth, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    try {
      if (typeof (req.body || {}).closed !== 'boolean') return res.status(400).json({ error: 'closed_boolean_required' });
      res.json(polls.setClosed(req.params.pollId, me.id, req.body.closed));
    } catch (e) { wallsErr(res, e); }
  });
  router.get('/api/forum/online', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    res.json(forum.whosOnline());
  });
  router.get('/api/forum/stats', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    res.json(forum.stats(me.id));
  });
  router.get('/api/forum/me', auth, requireForumReadScope, (req, res) => {
    const me = forumCaller(req, res); if (!me) return;
    res.json({ ...forum.memberView(me.id), lastVisitAt: forum.lastVisitFor(me.id) });
  });
  router.patch('/api/forum/me', auth, (req, res) => {
    if (tokenScopes(req) !== null) return res.status(403).json({ error: 'insufficient_scope' });
    const me = forumCaller(req, res); if (!me) return;
    try { res.json(forum.updateProfile(me.id, req.body)); } catch (e) { wallsErr(res, e); }
  });

  // Porch → The Forum. The standalone page lives at /forum; the old URL
  // (bookmarks, push-notification deep links, welcome handoffs) redirects,
  // preserving the query string (?wall=…&post=…). Mounted ahead of
  // express.static, same as the inline handlers were.
  router.get('/forum', (req, res) => {
    res.sendFile(path.join(publicDir, 'forum.html'), { dotfiles: 'allow' });
  });
  router.get('/porch.html', (req, res) => {
    const qi = req.originalUrl.indexOf('?');
    res.redirect(301, '/forum' + (qi === -1 ? '' : req.originalUrl.slice(qi)));
  });

  return router;
};
