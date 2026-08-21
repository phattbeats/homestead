#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1874 (PHA-1624 Phase B-2) smoke test for the Kavita sync worker.
//
// End-to-end smoke against a live Kavita server. Reads:
//
//   KAVITA_URL      — base URL (default https://kavita.phatt.vip)
//   KAVITA_API_KEY  — Kavita API key (required)
//
// Behavior:
//   * Connects to /api/Library/libraries and walks every Manga + Book
//     library (types 0 + 1; image + video filtered out per design doc
//     §5.1).
//   * If a target lib is missing or KAVITA_API_KEY is unset, exits 0
//     with a clear message (smoke is optional in CI; real validation
//     is in scripts/test-sync-kavita.js against canned HTTP fixtures).
//   * Otherwise: writes to a temp SQLite DB with the entity-graph
//     schema migrated, runs `syncKavita`, prints a summary, then
//     drops the temp DB. Use `--keep` to keep the temp DB at /tmp for
//     post-mortem inspection.
//
// Run: `node scripts/smoke-sync-kavita.js [--keep]`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const kavita = require('../lib/sync/kavita');
const { migrate: migrateEntity } = require('../lib/sync/_schema');

const KEEP = process.argv.includes('--keep');
const BASE_URL = process.env.KAVITA_URL || 'https://kavita.phatt.vip';
const API_KEY = process.env.KAVITA_API_KEY || '';

(async () => {
  if (!API_KEY) {
    console.log('[smoke] KAVITA_API_KEY not set — skipping live smoke. Tests in scripts/test-sync-kavita.js cover the worker.');
    process.exit(0);
  }
  console.log(`[smoke] KAVITA_URL=${BASE_URL}`);
  console.log('[smoke] building temp SQLite + entity-graph schema...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-kavita-smoke-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);

  console.log('[smoke] running syncKavita against', BASE_URL);
  const t0 = Date.now();
  const result = await kavita.syncKavita({ db, apiKey: API_KEY, baseUrl: BASE_URL });
  const dt = Date.now() - t0;

  console.log(`[smoke] syncKavita returned (${dt}ms):`);
  console.log(JSON.stringify(result, null, 2));

  // Spot-check: dump a few entities / edges so the user can sanity-check.
  const workCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'work'").get().c;
  const personCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'").get().c;
  const conceptCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'concept'").get().c;
  const edgeCount = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE source_service = 'kavita'").get().c;
  console.log(`[smoke] DB now has: ${workCount} works, ${personCount} persons, ${conceptCount} concepts, ${edgeCount} kavita edges`);

  const sample = db.prepare(`SELECT name, source_id, json_extract(meta_json, '$.year') AS year,
                                    json_extract(meta_json, '$.format') AS format
                              FROM entities WHERE kind = 'work' ORDER BY name LIMIT 5`).all();
  console.log('[smoke] sample works:');
  for (const s of sample) console.log(`  - ${s.name} (${s.year || '?'}, ${s.format || '?'}) source_id=${s.source_id}`);

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