#!/usr/bin/env node
// PHA-1875 (PHA-1624 Phase B-3) smoke test for the seerr sync worker.
//
// End-to-end smoke against a live seerr (Jellyseerr / Overseerr)
// instance. Reads:
//
//   SEERR_URL     — base URL (default https://seerr.phatt.vip)
//   SEERR_API_KEY — seerr API key (required)
//
// Behavior:
//   * Connects to /api/v1/request and walks every page.
//   * If SEERR_API_KEY is unset, exits 0 with a clear message (smoke
//     is optional in CI; real validation is in
//     scripts/test-sync-seerr.js against canned HTTP fixtures).
//   * Otherwise: writes to a temp SQLite DB with the entity-graph
//     schema migrated, runs `syncSeerr`, prints a summary, then drops
//     the temp DB. Use `--keep` to keep the temp DB at /tmp for
//     post-mortem inspection.
//
// Run: `node scripts/smoke-sync-seerr.js [--keep]`

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const seerr = require('../lib/sync/seerr');
const { migrate: migrateEntity } = require('../lib/sync/_schema');

const KEEP = process.argv.includes('--keep');
const BASE_URL = process.env.SEERR_URL || 'https://seerr.phatt.vip';
const API_KEY = process.env.SEERR_API_KEY || '';

(async () => {
  if (!API_KEY) {
    console.log('[smoke] SEERR_API_KEY not set — skipping live smoke. Tests in scripts/test-sync-seerr.js cover the worker.');
    process.exit(0);
  }
  console.log(`[smoke] SEERR_URL=${BASE_URL}`);
  console.log('[smoke] building temp SQLite + entity-graph schema...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-seerr-smoke-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateEntity(db);

  console.log('[smoke] running syncSeerr against', BASE_URL);
  const t0 = Date.now();
  const result = await seerr.syncSeerr({ db, apiKey: API_KEY, baseUrl: BASE_URL });
  const dt = Date.now() - t0;

  console.log(`[smoke] syncSeerr returned (${dt}ms):`);
  console.log(JSON.stringify(result, null, 2));

  // Spot-check: dump counts so the user can sanity-check.
  const workCount = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'work' AND source_service = 'seerr'").get().c;
  const personConfirmed = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person' AND source_service = 'seerr' AND source_id LIKE 'user:%'").get().c;
  const personUnknown = db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person' AND source_service = 'seerr' AND source_id LIKE 'unknown:%'").get().c;
  const requestedIn = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'requested_in' AND source_service = 'seerr'").get().c;
  const hintEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE type = 'availability_hint' AND source_service = 'seerr'").get().c;
  const staleEdges = db.prepare("SELECT COUNT(*) c FROM entity_edges WHERE source_service = 'seerr' AND stale = 1").get().c;
  const reviewRows = db.prepare("SELECT COUNT(*) c FROM entity_review_queue WHERE kind = 'unknown_person'").get().c;
  console.log(`[smoke] DB now has: ${workCount} seerr works, ${personConfirmed} confirmed persons, ${personUnknown} unknown-person stubs, ${requestedIn} requested_in edges, ${hintEdges} hint edges, ${staleEdges} stale edges, ${reviewRows} unknown-person review rows`);

  const sample = db.prepare(`SELECT name, source_id, json_extract(meta_json, '$.tmdb_id') AS tmdb_id
                              FROM entities WHERE kind = 'work' AND source_service = 'seerr' ORDER BY name LIMIT 5`).all();
  console.log('[smoke] sample seerr works:');
  for (const s of sample) console.log(`  - ${s.name} (tmdb=${s.tmdb_id || '?'}) source_id=${s.source_id}`);

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