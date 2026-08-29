#!/usr/bin/env node
// scripts/reset-owner-password.js — PHA-2708 host-side break-glass CLI.
//
// Homestead's owner has a single break-glass path: a local password
// verified against `local_credentials.password_hash`. When Authentik is
// down AND the owner has forgotten the LAN password, no in-app API can
// recover the account — and we don't want one. This CLI is the
// sanctioned recovery flow. It runs on the HOST (not the browser), so
// it never depends on Homestead being reachable, and it writes the
// recovery token directly into the SQLite DB that the server reads.
//
// Usage:
//   DATA_DIR=/var/lib/homestead node scripts/reset-owner-password.js
//   DATA_DIR=/var/lib/homestead node scripts/reset-owner-password.js --ttl-min 30
//   DATA_DIR=/var/lib/homestead node scripts/reset-owner-password.js --revoke
//
// What it prints:
//   * The plaintext recovery token (one shot). The DB only sees the
//     sha256(token); this stdout is the ONLY copy.
//   * A ready-to-paste `curl` line the operator can run from any
//     machine that can reach Homestead — no login required — to
//     drive the actual password rotation through
//     POST /api/admin/owner/recover. That endpoint is deliberately
//     unauthenticated; the token itself is the credential.
//   * The expiry timestamp (default 60 minutes).
//   * The audit kind (`owner_recovery_minted`) and the OS user who
//     ran the CLI, so the analytics_events row carries provenance.
//
// `--revoke` clears any active recovery token without minting a new
// one. Use this when a leaked token needs to be killed before expiry.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) {
  console.error('FATAL: DATA_DIR env var required (point at the running Homestead data dir).');
  process.exit(2);
}
const dbPath = path.join(DATA_DIR, 'life.db');
if (!fs.existsSync(dbPath)) {
  console.error(`FATAL: ${dbPath} not found. Is Homestead initialized at this DATA_DIR?`);
  process.exit(2);
}

const args = process.argv.slice(2);
const revokeMode = args.includes('--revoke');
const ttlIdx = args.indexOf('--ttl-min');
const ttlMin = ttlIdx > -1 ? Number(args[ttlIdx + 1]) : 60;
if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
  console.error('FATAL: --ttl-min must be a positive number of minutes.');
  process.exit(2);
}

const db = new Database(dbPath);
const identity = require('../lib/identity');

db.pragma('journal_mode = WAL');

try {
  if (!identity.findOwnerUserId(db)) {
    console.error('FATAL: no is_admin=1 user in this DB. Run Homestead once with the standard seed first.');
    process.exit(3);
  }

  if (revokeMode) {
    const r = identity.clearOwnerRecoveryToken(db);
    identity.auditOwnerRecovery(db, {
      kind: 'owner_recovery_revoked',
      actor: os.userInfo().username || 'unknown',
      userId: identity.findOwnerUserId(db),
      meta: { source: 'reset-owner-password.js', mode: 'revoke' },
    });
    console.log(JSON.stringify({ action: 'revoke', cleared: r.cleared, actor: os.userInfo().username || 'unknown', at: new Date().toISOString() }, null, 2));
    process.exit(0);
  }

  const minted = identity.mintOwnerRecoveryToken(db, { ttlMs: ttlMin * 60 * 1000 });
  if (minted.alreadyActive) {
    console.error('ERROR: an active recovery token already exists for the owner.');
    console.error('  expires_at:', minted.expiresAt);
    console.error('  use --revoke to clear it, then re-run.');
    process.exit(4);
  }
  if (!minted.token) {
    console.error('FATAL: mint returned no token; check local_credentials row.');
    process.exit(5);
  }

  identity.auditOwnerRecovery(db, {
    kind: 'owner_recovery_minted',
    actor: os.userInfo().username || 'unknown',
    userId: minted.userId,
    meta: { source: 'reset-owner-password.js', ttl_min: ttlMin },
  });

  // The plaintext token and a ready-to-paste curl line. Keep these on
  // ONE line so screen-scrapers don't accidentally split them.
  const host = process.env.RECOVERY_HOST || 'http://127.0.0.1:3001';
  // No -b cookies.txt / auth headers here on purpose — the recover
  // endpoint is unauthenticated by design; the token is the credential.
  const curlExample = `curl -sS -X POST -H 'Content-Type: application/json' \\\n` +
    `  -d '{"token":"${minted.token}","new_password":"REPLACE_ME_8_CHARS_MIN"}' \\\n` +
    `  ${host}/api/admin/owner/recover`;

  console.log(JSON.stringify({
    action: 'mint',
    userId: minted.userId,
    username: minted.username,
    display: minted.display,
    token: minted.token,
    expires_at: minted.expiresAt,
    ttl_min: ttlMin,
    actor: os.userInfo().username || 'unknown',
    curl_example: curlExample,
    warning: 'Save the token NOW. The DB only stores its sha256 hash; the plaintext is gone after this stdout clears.',
  }, null, 2));
} catch (e) {
  console.error('FATAL:', e.message);
  process.exit(1);
} finally {
  db.close();
}
