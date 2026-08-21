// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — calendar source adapter interface (PHA-1620).
//
// This module is the public face of the calendar-source system. The
// server.js routes and the sync orchestrator import from here; the
// provider-specific implementations (CalDAV, Graph, Google) live in
// their own modules and register through `registerAdapter`.
//
// Contract for every adapter implementation:
//
//   const adapter = createAdapter(sourceConfig, deps);
//   // sourceConfig is the per-source row from calendar_sources, with
//   //   `cred_blob` already decrypted into a structured payload
//   //   (e.g. { app_password } for CalDAV).
//   await adapter.listCalendars() -> [{ href, displayName, color? }]
//   await adapter.listEvents({ start, end, calendarHref }) -> [event]
//   // Phase 2:
//   await adapter.createEvent({ calendarHref, vevent })
//   await adapter.updateEvent({ calendarHref, externalId, vevent })
//   await adapter.deleteEvent({ calendarHref, externalId })
//
// All adapters must:
//   * Treat credentials as opaque secrets — never log them, never
//     include them in error messages, never return them.
//   * Surface HTTP / network errors with the provider's status code
//     attached (caller decides retry / cached-fallback).
//   * Honor `start` / `end` as inclusive ISO 8601 strings. Single-day
//     and multi-day ranges both work; the adapter may pre-filter for
//     performance but the merge layer does its own overlap math.
//
// `syncSource(db, sourceRow, deps)` is the orchestrator: it fetches
// events from the provider, upserts them into calendar_event_cache,
// and stamps last_synced_at / last_error on the source row. It is
// invoked from /api/calendar-sources/:id/refresh AND from the merge
// endpoint when the cache is older than `FRESHNESS_MS`.

'use strict';

const { makeCalDAVSource } = require('./caldav-source');
const { makeGraphSource } = require('./graph-source');
const { decryptString } = require('./secret-box');

// FRESHNESS_MS is the contract the work order calls out: "Target
// freshness ≤5 min; degrade gracefully when a provider is unreachable".
// The merge endpoint compares the cache's last_synced_at against now()
// and re-syncs if it's older than this.
const FRESHNESS_MS = 5 * 60 * 1000;

// --- Adapter registry ----------------------------------------------------

const ADAPTERS = new Map();

function registerAdapter(kind, factory) {
  if (typeof kind !== 'string' || typeof factory !== 'function') {
    throw new TypeError('registerAdapter(kind, factory): bad arguments');
  }
  ADAPTERS.set(kind, factory);
}

// Built-in adapters registered on require() so callers don't need to
// wire them manually.
registerAdapter('caldav', (config) => makeCalDAVSource(config));
// PHA-1864: Microsoft Graph adapter for MS365 calendars. The decrypted
// cred_blob for provider='ms365' must contain { access_token,
// refresh_token, expires_at, client_id, tenant_id?, scope? } — see
// lib/graph-source.js for the refresh-on-401 contract.
registerAdapter('graph', (config, deps) => makeGraphSource(config, deps));

function listAdapterKinds() {
  return Array.from(ADAPTERS.keys());
}

// --- Source row -> decrypted adapter config -----------------------------

// `sourceRow` is the calendar_sources row. We decrypt cred_blob here so
// adapter implementations can treat the resulting object as plaintext
// structured config (no further crypto to think about).
function adapterConfigFor(sourceRow) {
  if (!sourceRow) throw new Error('adapterConfigFor: sourceRow is required');
  const plain = decryptString(sourceRow.cred_blob);
  let parsed;
  try { parsed = JSON.parse(plain); }
  catch (e) { throw new Error('adapterConfigFor: cred_blob is not valid JSON: ' + e.message); }
  return {
    provider: sourceRow.provider,
    account_id: sourceRow.account_id,
    base_url: sourceRow.base_url,
    calendar_id: sourceRow.calendar_id,
    ...parsed,
  };
}

function createAdapter(sourceRow, deps = {}) {
  const config = adapterConfigFor(sourceRow);
  // Map provider -> adapter kind. Today every CalDAV-flavoured provider
  // uses the caldav kind; Graph/Google register their own kinds.
  const kind = providerToKind(sourceRow.provider);
  const factory = ADAPTERS.get(kind);
  if (!factory) {
    throw new Error(`No adapter registered for kind "${kind}" (provider "${sourceRow.provider}")`);
  }
  return factory(config, deps);
}

function providerToKind(provider) {
  if (provider === 'caldav_nextcloud' || provider === 'caldav_icloud') return 'caldav';
  if (provider === 'ms365') return 'graph';
  if (provider === 'google') return 'google';
  throw new Error('Unknown provider: ' + provider);
}

// --- Migrations ----------------------------------------------------------

// Called from lib/user-model.js so the migration is in one place.
function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS calendar_sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  base_url TEXT,
  display_name TEXT,
  color TEXT NOT NULL DEFAULT '#7c9eb8',
  cred_blob TEXT NOT NULL,
  sync_token TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_sources_unique
  ON calendar_sources(user_id, provider, account_id, calendar_id);

CREATE TABLE IF NOT EXISTS calendar_event_cache (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  href TEXT,
  etag TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_cache_unique
  ON calendar_event_cache(source_id, external_id);
CREATE INDEX IF NOT EXISTS calendar_event_cache_start
  ON calendar_event_cache(start_at);
  `);

  // v0.0.6: add base_url if it landed before this migration
  // (idempotent — PRAGMA table_info check guards the ADD COLUMN).
  const srcCols = db.prepare("PRAGMA table_info(calendar_sources)").all().map(c => c.name);
  if (!srcCols.includes('base_url')) {
    db.exec("ALTER TABLE calendar_sources ADD COLUMN base_url TEXT");
  }
  const cecCols = db.prepare("PRAGMA table_info(calendar_event_cache)").all().map(c => c.name);
  if (!cecCols.includes('href')) {
    db.exec("ALTER TABLE calendar_event_cache ADD COLUMN href TEXT");
  }
}

// --- Sync orchestration --------------------------------------------------

// syncSource fetches events from the provider, upserts into
// calendar_event_cache, and updates the source row's sync metadata.
// On any thrown error, the error is captured on last_error /
// last_error_at and re-thrown so the HTTP caller can return 502 with
// a per-provider stale badge.
async function syncSource(db, sourceRow, deps = {}) {
  if (!sourceRow || !sourceRow.id) throw new Error('syncSource: sourceRow.id required');
  const adapter = createAdapter(sourceRow, deps);
  // Default range: 60 days back -> 365 days forward. Wide enough that
  // the month grid never misses a long-recurring event but narrow
  // enough that the initial sync stays bounded.
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 86400 * 1000);
  const end = new Date(now.getTime() + 365 * 86400 * 1000);
  // We rely on the caller (or the source row) to have resolved the
  // concrete calendar href at config time. For now the calendar_id is
  // stored verbatim and the adapter interprets it; CalDAV takes a
  // href-style calendar_id; Graph/Google take their own id forms.
  const events = await adapter.listEvents({
    start: start.toISOString(),
    end: end.toISOString(),
    calendarHref: sourceRow.calendar_id,
  });
  // Upsert in a single transaction for atomicity.
  const tx = db.transaction((sid, evs) => {
    db.prepare('DELETE FROM calendar_event_cache WHERE source_id = ?').run(sid);
    const ins = db.prepare(`INSERT INTO calendar_event_cache
      (source_id, external_id, title, description, start_at, end_at, all_day, location, href, etag, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    for (const e of evs) {
      ins.run(
        sid,
        String(e.externalId || '').slice(0, 512),
        String(e.title || '(untitled)').slice(0, 512),
        e.description ? String(e.description).slice(0, 4096) : null,
        e.start,
        e.end || null,
        e.allDay ? 1 : 0,
        e.location ? String(e.location).slice(0, 512) : null,
        e.href ? String(e.href).slice(0, 1024) : null,
        e.etag ? String(e.etag).slice(0, 256) : null,
      );
    }
  });
  tx(sourceRow.id, events);
  db.prepare(`UPDATE calendar_sources SET
      last_synced_at = datetime('now'),
      last_error = NULL,
      last_error_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?`).run(sourceRow.id);
  return { fetched: events.length };
}

// isStale(sourceRow, now) returns true when the cache is older than
// FRESHNESS_MS (or has never been synced). The merge endpoint uses
// this to decide whether to re-sync on the read path.
function isStale(sourceRow, now = Date.now()) {
  if (!sourceRow.last_synced_at) return true;
  const t = new Date(sourceRow.last_synced_at + 'Z').getTime();
  if (isNaN(t)) return true;
  return (now - t) > FRESHNESS_MS;
}

// --- Public DTOs ---------------------------------------------------------

// publicView(sourceRow) is the JSON shape the API returns to the
// browser. NEVER include cred_blob or its components. This is the
// single source of truth for "what is safe to ship to the client".
function publicView(sourceRow) {
  return {
    id: sourceRow.id,
    user_id: sourceRow.user_id,
    provider: sourceRow.provider,
    account_id: sourceRow.account_id,
    calendar_id: sourceRow.calendar_id,
    base_url: sourceRow.base_url,
    display_name: sourceRow.display_name,
    color: sourceRow.color,
    sync_token: sourceRow.sync_token, // opaque, non-secret
    last_synced_at: sourceRow.last_synced_at,
    last_error: sourceRow.last_error,
    last_error_at: sourceRow.last_error_at,
    enabled: !!sourceRow.enabled,
    created_by: sourceRow.created_by,
    created_at: sourceRow.created_at,
    updated_at: sourceRow.updated_at,
  };
}

module.exports = {
  // Adapter registry
  registerAdapter,
  listAdapterKinds,
  providerToKind,
  // Migrations
  migrate,
  // Public DTO
  publicView,
  // Sync orchestration
  syncSource,
  isStale,
  FRESHNESS_MS,
  // For tests
  adapterConfigFor,
  createAdapter,
};
