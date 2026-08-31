#!/usr/bin/env node
// PHA-2711: owner-account break-glass reset.
//
// Mints a one-shot recovery token for a Homestead local-account user.
// The token is valid for 1 hour, sha256-hashed in the DB, and
// single-use. The plaintext token is printed to stdout once; the
// operator pastes it into the /api/public/invites/reset endpoint along
// with the new password.
//
// Usage:
//   node scripts/reset-owner-password.js --username brandon
//   node scripts/reset-owner-password.js --user-id 3 --ttl 15m
//
// The script needs HOMESTEAD_DB_PATH env (defaults to
// /app/data/homestead.db in the running container, ./data/homestead.db
// in dev). It does NOT take a network dependency — it's a host-side
// CLI that runs against the live DB, the same way the seed / migrate
// scripts do.
//
// This is the documented "Brandon's owner account has a working local
// credential and documented break-glass reset path independent of
// Authentik" path. PHA-2711 explicitly requires both the working
// credential (PHA-2704 already backfilled pass_hash → local_credentials
// on first boot) and a way to recover it if the password is forgotten.

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const invites = require('../lib/invites');
const identity = require('../lib/identity');

function parseTtl(s) {
  const m = String(s || '').trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) throw new Error(`invalid --ttl: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * factor;
}

function parseArgs(argv) {
  const out = { ttlMs: 60 * 60 * 1000, username: null, userId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--username' || a === '-u') out.username = argv[++i];
    else if (a === '--user-id') out.userId = Number(argv[++i]);
    else if (a === '--ttl') out.ttlMs = parseTtl(argv[++i]);
    else if (a === '--db') out.db = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/reset-owner-password.js --username <name> [--ttl 1h] [--db <path>]');
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || process.env.HOMESTEAD_DB_PATH || (fs.existsSync('/app/data/homestead.db') ? '/app/data/homestead.db' : path.join(process.cwd(), 'data', 'homestead.db'));
  if (!fs.existsSync(dbPath)) {
    console.error(`FATAL: db not found: ${dbPath}. Pass --db or set HOMESTEAD_DB_PATH.`);
    process.exit(2);
  }
  const db = new Database(dbPath);
  let row;
  if (args.userId) {
    row = db.prepare('SELECT id, username, display FROM users WHERE id = ?').get(args.userId);
  } else if (args.username) {
    row = db.prepare('SELECT id, username, display FROM users WHERE username = ?').get(args.username.toLowerCase());
  } else {
    console.error('FATAL: --username or --user-id required.');
    process.exit(2);
  }
  if (!row) {
    console.error(`FATAL: user not found.`);
    process.exit(2);
  }
  if (!identity.hasLocalCredential(db, row.id)) {
    console.error(`FATAL: user ${row.username} has no local_credentials row. Authentik-only accounts cannot be reset via this script.`);
    process.exit(2);
  }
  const { token, expiresAt } = invites.createResetToken(db, row.id, args.ttlMs);
  console.log(JSON.stringify({
    ok: true,
    user_id: row.id,
    username: row.username,
    display: row.display,
    token,
    expires_at: expiresAt,
    reset_endpoint: '/api/public/invites/reset',
    curl_example: `curl -sS -X POST http://<homestead-host>:3000/api/public/invites/reset -H 'content-type: application/json' -d '${JSON.stringify({ token, new_password: 'REPLACE_ME' })}'`,
  }, null, 2));
}

try { main(); }
catch (err) { console.error('FATAL:', err.message); process.exit(1); }
