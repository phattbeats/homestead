'use strict';

// Client for the PHATT Agent Hub (phatt-agents, PHA-4881). When HUB_URL and HUB_SERVICE_KEY
// are set, Homestead's agent-connection settings read/write permissions, status and audit
// through the hub. Unset → hub features are off and Homestead behaves exactly as before.

const LEGACY_PREFIX = 'legacy:homestead:';

function config(env = process.env) {
  const url = (env.HUB_URL || '').replace(/\/$/, '');
  const key = env.HUB_SERVICE_KEY || '';
  return url && key ? { url, key } : null;
}

// PHATT ID subject for a Homestead user (identity_links), else a legacy owner the hub can rebind later.
function ownerFor(db, userId) {
  const issuer = process.env.HUB_PHATTID_ISSUER;
  const row = issuer
    ? db.prepare('SELECT provider_subject FROM identity_links WHERE user_id = ? AND issuer = ? ORDER BY id LIMIT 1').get(userId, issuer)
    : db.prepare('SELECT provider_subject FROM identity_links WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
  return row ? row.provider_subject : `${LEGACY_PREFIX}${userId}`;
}

function createClient(cfg = config(), fetchImpl = globalThis.fetch) {
  if (!cfg) return null;
  async function call(method, path, { owner, body } = {}) {
    const res = await fetchImpl(`${cfg.url}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json', ...(owner ? { 'x-hub-owner': owner } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `hub_${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  return {
    call,
    list: (owner) => call('GET', '/connections', { owner }),
    get: (owner, id) => call('GET', `/connections/${id}`, { owner }),
    rename: (owner, id, label) => call('PATCH', `/connections/${id}`, { owner, body: { label } }),
    revoke: (owner, id) => call('PATCH', `/connections/${id}`, { owner, body: { revoke: true } }),
    grant: (owner, id, perm) => call('PUT', `/connections/${id}/permissions/${encodeURIComponent(perm)}`, { owner }),
    revokePermission: (owner, id, perm) => call('DELETE', `/connections/${id}/permissions/${encodeURIComponent(perm)}`, { owner }),
    permissions: () => call('GET', '/permissions'),
    audit: (owner, id) => call('GET', `/audit${id ? `?connection=${encodeURIComponent(id)}` : ''}`, { owner }),
  };
}

module.exports = { config, createClient, ownerFor, LEGACY_PREFIX };
