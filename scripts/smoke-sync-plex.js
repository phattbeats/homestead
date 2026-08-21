#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1873 (PHA-1624 Phase B-1) smoke test for the Plex sync worker.
//
// End-to-end smoke against a live Plex Media Server. Reads:
//
//   PLEX_URL    — base URL (default https://plex.phatt.vip)
//   PLEX_TOKEN  — Plex API token (required)
//
// Behavior:
//   * Connects to /library/sections and walks every library.
//   * If a target lib is missing or PLEX_TOKEN is unset, exits 0 with
//     a clear message (smoke is optional in CI; real validation is in
//     scripts/test-sync-plex.js against canned HTTP fixtures).
//   * Otherwise: writes to a temp SQLite DB with the entity-graph
//     schema migrated, runs `syncPlex`, prints a summary, then drops
//     the temp DB. Use `--keep` to keep the temp DB at /tmp for
//     post-mortem inspection.
//
// Run: `node scripts/smoke-sync-plex.js [--keep]`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const plex = require('../lib/sync/plex');
const { migrate: migrateEntity } = require('../lib/sync/_schema');

const KEEP = process.argv.includes('--keep');
const BASE_URL = process.env.PLEX_URL || 'https://plex.phatt.vip';
const TOKEN = process.env.PLEX_TOKEN || '';

(async () => {
  if (!TOKEN) {
    console.log('[smoke] PLEX_TOKEN not set — skipping live smoke. Tests in scripts/test-sync-plex.js cover the worker.');
    process.exit(0);
  }
  console.log(`[smoke] PLEX_URL=${BASE_URL}`);
  console.log('[smoke] building temp SQLite + entity-graph schema...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-plex-smoke-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);

  console.log('[smoke] running syncPlex against', BASE_URL);
  const t0 = Date.now();
  const result = await plex.syncPlex({ db, token: TOKEN, baseUrl: BASE_URL });
  const dt = Date.now() - t0;

  console.log(`[smoke] syncPlex returned (${dt}ms):`);
  console.log(JSON.stringify(result, null, 2));

  // Spot-check: dump a few entities / edges so the user can sanity-check.
  const workCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'work'").get().c;
  const personCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'").get().c;
  const conceptCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'concept'").get().c;
  const edgeCount = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE source_service = 'plex'").get().c;
  console.log(`[smoke] DB now has: ${workCount} works, ${personCount} persons, ${conceptCount} concepts, ${edgeCount} plex edges`);

  const sample = db.prepare(`SELECT name, source_id, json_extract(meta_json, '$.year') AS year
                              FROM entities WHERE kind = 'work' ORDER BY name LIMIT 5`).all();
  console.log('[smoke] sample works:');
  for (const s of sample) console.log(`  - ${s.name} (${s.year || '?'}) source_id=${s.source_id}`);

  if (KEEP) {
    console.log(`[smoke] kept temp DB at ${dbPath}`);
  } else {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[smoke] temp DB cleaned up');
  }

  if (result.errors && result.errors.length > 0) {
    console.error(`[smoke] ${result.errors.length} error(s) during sync:`);
    for (const e of result.errors) console.error('  ', e);
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => {
  console.error('[smoke] FATAL:', e && e.stack || e);
  process.exit(1);
});