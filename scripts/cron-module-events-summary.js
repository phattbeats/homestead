#!/usr/bin/env node
// PHA-2220 — Daily cohort summary cron for module_events.
//
// Rebuilds the user_signals denormalized rollup from the raw
// module_events log. Designed to be run from system cron (or
// invoked by hand for backfill / one-shot). Idempotent: re-runs
// produce identical output without coordination.
//
// Operational contract:
//   * Reads the SQLite file at $DATA_DIR/life.db (default ./data/life.db).
//   * Calls `userModel.summarizeModuleEvents(db)` which is itself
//     wrapped in a single transaction.
//   * Logs a one-line summary on stdout so the cron envelope can
//     capture the result for grep / alerting.
//   * Exits non-zero on any thrown error so cron can mail the failure.
//
// Wiring: this script does NOT install itself. Add it to system cron
// separately, e.g.:
//   0 3 * * *  cd /app && node scripts/cron-module-events-summary.js
//
// The cron entry lives outside this PR because it's an ops decision
// (timing, error-mailer, log-rotation) and not a code change. The
// script ships ready-to-run.

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'life.db');

function main() {
  const startedAt = new Date();
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[cron-module-events-summary] DB not found at ${DB_PATH}`);
    process.exit(2);
  }
  const db = new Database(DB_PATH);
  try {
    // Ensure the schema exists (idempotent on a fresh install that
    // hasn't been booted by server.js yet — cheap CREATE IF NOT EXISTS).
    userModel.migrate(db);

    const rowsWritten = userModel.summarizeModuleEvents(db);
    const totalEvents = db.prepare('SELECT COUNT(*) c FROM module_events').get().c;
    const usersWithSignals = db.prepare('SELECT COUNT(*) c FROM user_signals').get().c;
    const finishedAt = new Date();
    const ms = finishedAt - startedAt;
    console.log(
      `[cron-module-events-summary] OK rows_written=${rowsWritten} ` +
      `users_with_signals=${usersWithSignals} ` +
      `total_module_events=${totalEvents} ` +
      `started=${startedAt.toISOString()} ` +
      `duration_ms=${ms}`
    );
  } catch (err) {
    console.error('[cron-module-events-summary] FAILED', err && err.stack ? err.stack : err);
    process.exit(1);
  } finally {
    try { db.close(); } catch (_) { /* ignore close errors */ }
  }
}

main();