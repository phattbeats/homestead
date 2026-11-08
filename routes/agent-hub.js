'use strict';

// /api/agent-hub — Homestead's settings screens talk to the PHATT Agent Hub through here.
// The hub owns permissions + audit; Homestead only authenticates the player and asserts who they are.

const { Router } = require('express');
const hubClient = require('../lib/hub-client');

module.exports = function agentHubRouter({ db, auth, userModel, hub = hubClient.createClient() }) {
  const r = Router();
  const wrap = (fn) => async (req, res) => {
    if (!hub) return res.status(404).json({ error: 'hub_not_configured' });
    const me = userModel.getMe(db, req.session.user.username);
    if (!me) return res.status(401).json({ error: 'unknown_user' });
    try { res.json(await fn(hubClient.ownerFor(db, me.id), req)); } catch (e) {
      res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message });
    }
  };

  r.get('/status', auth, (_req, res) => res.json({ enabled: !!hub }));
  r.get('/permissions', auth, wrap(() => hub.permissions()));
  r.get('/connections', auth, wrap((owner) => hub.list(owner)));
  r.get('/connections/:id', auth, wrap((owner, req) => hub.get(owner, req.params.id)));
  r.put('/connections/:id/permissions/:perm', auth, wrap((owner, req) => hub.grant(owner, req.params.id, req.params.perm)));
  r.delete('/connections/:id/permissions/:perm', auth, wrap((owner, req) => hub.revokePermission(owner, req.params.id, req.params.perm)));
  // Agents connected on the hub itself (MCP connectors, /connect pairing) have no Homestead row; this is their Revoke.
  r.post('/connections/:id/revoke', auth, wrap((owner, req) => hub.revoke(owner, req.params.id)));
  r.get('/connections/:id/audit', auth, wrap((owner, req) => hub.audit(owner, req.params.id)));
  return r;
};
