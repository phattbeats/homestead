// split server.js into Express routers.
//
// Fourth domain extracted — the household lists API (lists + their
// items). Chosen because the whole surface is plain JSON CRUD: no SSE,
// no timers, no cross-domain state. Every handler is a one-line
// delegation to lib/lists.js, which makes it the cheapest possible
// relocation to review — and it buys the line-count headroom the
// server.js decomposition guard needs (scripts/test-health-router.js).
//
// Pattern:
//   routes/<domain>.js exports a factory that takes the shared deps
//   (db, auth, requireScope, userModel, lists) and returns an Express
//   Router with just this domain's endpoints. server.js mounts it via
//     app.use('/api', listsRouter({ db, auth, requireScope, userModel, lists }));
//   so the URL paths stay byte-identical (`/api/lists`, `/api/lists/stats`,
//   `/api/lists/:id`, `/api/lists/:id/items`, `/api/list-items/:itemId`).
//
// Behavior must not change: this file is a pure relocation of the
// handlers that previously lived at server.js L3254–L3367.
//
// Route ORDER inside the router is load-bearing: `/api/lists/stats` is
// registered BEFORE `/api/lists/:id`, otherwise "stats" is captured as a
// list id and the stats envelope 404s into a list lookup. Keep that
// order when adding routes here.
//
// Acceptance gates (both must stay green with no edits):
//   - scripts/test-lists.js — the domain's own acceptance suite.
//   - scripts/test-lists-router.js — the relocation guard (factory
//     contract + mount + path byte-identity).
//
// What depends on what:
//   - `db`:          better-sqlite3 instance from server.js (userModel.getMe
//                    resolves the caller).
//   - `auth`:        the four-layer authenticate() middleware from
//                    server.js, referenced rather than re-defined so a
//                    future auth change still lands in one place.
//   - `requireScope`: scope gate factory from server.js — reads need
//                    `read:lists`, writes need `write:lists`.
//   - `userModel`:   lib/user-model.js — getMe.
//   - `lists`:       lib/lists.js — the domain itself.
//
// fail-closed check: a list write must never silently succeed against a
// scope the caller does not hold, and a missing caller must never read
// as an empty household. requireScope() rejects app-scoped tokens that
// lack the scope (403), and every handler resolves the caller through
// userModel.getMe before it writes.

'use strict';

const { Router } = require('express');

module.exports = function listsRouter({
  db,
  auth,
  requireScope,
  userModel,
  lists,
}) {
  if (!db) throw new Error('listsRouter: db is required');
  if (typeof auth !== 'function') throw new Error('listsRouter: auth must be a function');
  if (typeof requireScope !== 'function') throw new Error('listsRouter: requireScope must be a function');
  if (!userModel) throw new Error('listsRouter: userModel is required');
  if (!lists) throw new Error('listsRouter: lists is required');

  const r = Router();

  // Lists are the household-shared, multiple-contributor primitive
  // distinct from chores/tasks. The `lists` module in lib/lists.js
  // scopes reads to `read:lists` and writes to `write:lists`; both
  // are auto-granted to the household via the session user (the auth
  // middleware resolves the caller below). Routes follow the same
  // shape as /api/walls so the SPA can use a familiar fetch pattern.
  //
  // Design notes:
  //   * No membership gate — lists are household-shared by default.
  //     Future work can add per-list visibility if a household asks for it.
  //   * App-scoped bearer tokens must hold the matching list scope.
  //     Cookie/header-trust sessions retain normal first-party access, as
  //     requireScope() intentionally permits them.
  //   * Lists are not deleted by accidental item-delete — items cascade
  //     only when the parent list is removed.

  r.get('/lists', auth, requireScope('read:lists'), (req, res) => {
    try {
      const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
      res.json({ lists: lists.listLists({ includeArchived }) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'list_failed' });
    }
  });

  // Registered before `/lists/:id` on purpose — see the route-order note
  // in the file header.
  r.get('/lists/stats', auth, requireScope('read:lists'), (req, res) => {
    try {
      res.json(lists.publicStats());
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'stats_failed' });
    }
  });

  r.get('/lists/:id', auth, requireScope('read:lists'), (req, res) => {
    try {
      res.json(lists.getList(req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'list_failed' });
    }
  });

  r.post('/lists', auth, requireScope('write:lists'), (req, res) => {
    try {
      const me = userModel.getMe(db, req.session.user.username);
      const userId = me ? me.id : null;
      res.status(201).json(lists.createList(req.body || {}, userId));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'list_failed' });
    }
  });

  r.patch('/lists/:id', auth, requireScope('write:lists'), (req, res) => {
    try {
      res.json(lists.updateList(req.params.id, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'list_failed' });
    }
  });

  r.delete('/lists/:id', auth, requireScope('write:lists'), (req, res) => {
    try {
      res.json(lists.deleteList(req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'list_failed' });
    }
  });

  r.post('/lists/reorder', auth, requireScope('write:lists'), (req, res) => {
    try {
      res.json({ lists: lists.reorderLists((req.body && req.body.ordered_ids) || []) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'list_failed' });
    }
  });

  r.get('/lists/:id/items', auth, requireScope('read:lists'), (req, res) => {
    try {
      const includeChecked = req.query.include_checked === '1' || req.query.include_checked === 'true';
      const limit = req.query.limit ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100)) : undefined;
      res.json({ items: lists.listItems(req.params.id, { includeChecked, limit }) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'item_failed' });
    }
  });

  r.post('/lists/:id/items', auth, requireScope('write:lists'), (req, res) => {
    try {
      const me = userModel.getMe(db, req.session.user.username);
      const userId = me ? me.id : null;
      res.status(201).json(lists.addItem(req.params.id, req.body || {}, userId));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'item_failed' });
    }
  });

  r.patch('/list-items/:itemId', auth, requireScope('write:lists'), (req, res) => {
    try {
      const me = userModel.getMe(db, req.session.user.username);
      const userId = me ? me.id : null;
      res.json(lists.updateItem(req.params.itemId, req.body || {}, userId));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'item_failed' });
    }
  });

  r.delete('/list-items/:itemId', auth, requireScope('write:lists'), (req, res) => {
    try {
      res.json(lists.deleteItem(req.params.itemId));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'item_failed' });
    }
  });

  return r;
};
