#!/usr/bin/env node
// One-shot, idempotent: copy agent_connections rows to the PHATT Agent Hub with the SAME ids.
// Secrets are not sent. Usage: HUB_URL=… HUB_SERVICE_KEY=… DATA_DIR=… node scripts/export-agent-connections-to-hub.js [--dry-run]
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const hubClient = require('../lib/hub-client');

(async () => {
  const hub = hubClient.createClient();
  const dry = process.argv.includes('--dry-run');
  if (!hub && !dry) { console.error('HUB_URL and HUB_SERVICE_KEY are required'); process.exit(2); }
  const db = new Database(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'life.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM agent_connections ORDER BY id').all().map((r) => {
    const owner = hubClient.ownerFor(db, r.user_id);
    return {
      id: r.id, user_id: r.user_id, owner_sub: owner.startsWith(hubClient.LEGACY_PREFIX) ? null : owner,
      provider: r.provider, label: r.label, status: r.status, scopes: JSON.parse(r.scopes || '[]'),
      created_at: r.created_at, redeemed_at: r.redeemed_at, revoked_at: r.revoked_at, last_used_at: r.last_used_at,
    };
  });
  console.log(`${rows.length} connection(s); ${rows.filter((r) => !r.owner_sub).length} without a linked PHATT ID`);
  if (dry) return;
  console.log(await hub.call('POST', '/import/homestead', { body: { connections: rows } }));
})().catch((e) => { console.error(e.message); process.exit(1); });
