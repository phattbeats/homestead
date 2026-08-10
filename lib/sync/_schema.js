// Homestead — Entity / Relationship Graph: SQLite schema (PHA-1624 design doc §3).
//
// This module exports the raw SQL DDL for the entity graph tables and the
// `migrate(db)` idempotent installer. It is shared by:
//
//   * Phase A (PHA-1872) — server boot wires it into the boot migration
//     alongside userModel.migrate() / calendarSources.migrate()
//   * Phase B-1 (PHA-1873) — `lib/sync/plex.js` calls `migrate(db)` from
//     its test/smoke bootstrap and from the `POST /api/admin/sync/plex`
//     admin endpoint as a self-healing fallback (no-op when the schema
//     already exists)
//
// Idempotent: every CREATE uses IF NOT EXISTS / IF NOT EXISTS on indices,
// and the FTS5 triggers use `CREATE TRIGGER IF NOT EXISTS`. Safe to call
// on every boot. This is the same pattern as `lib/user-model.js:migrate`
// (PHA-1618).

'use strict';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  meta_json       TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  source_service  TEXT,
  source_id       TEXT,
  name_lower      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS entities_kind_name_lower_idx ON entities(kind, name_lower);
CREATE UNIQUE INDEX IF NOT EXISTS entities_kind_source_id_idx
  ON entities(kind, source_service, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  alias_lower  TEXT NOT NULL,
  source       TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias_lower)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias_lower ON entity_aliases(alias_lower);

CREATE TABLE IF NOT EXISTS entity_edges (
  id              TEXT PRIMARY KEY,
  from_id         TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id           TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  source_service  TEXT NOT NULL,
  source_id       TEXT,
  deep_link       TEXT,
  meta_json       TEXT NOT NULL DEFAULT '{}',
  weight          REAL NOT NULL DEFAULT 1.0,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (from_id, to_id, type, source_service, source_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON entity_edges(from_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON entity_edges(to_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_service ON entity_edges(source_service, source_id);

CREATE TABLE IF NOT EXISTS entity_review_queue (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  candidate_a     TEXT NOT NULL REFERENCES entities(id),
  candidate_b     TEXT NOT NULL REFERENCES entities(id),
  confidence      REAL NOT NULL,
  reason          TEXT NOT NULL,
  source_service  TEXT NOT NULL,
  evidence_json   TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  decided_by      TEXT,
  decided_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_status ON entity_review_queue(status, confidence);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, alias, kind, meta_text,
  content='entities', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, alias, kind, meta_text)
  VALUES (new.rowid, new.name, '', new.kind, new.meta_json);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, alias, kind, meta_text)
  VALUES('delete', old.rowid, old.name, '', old.kind, old.meta_json);
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, alias, kind, meta_text)
  VALUES('delete', old.rowid, old.name, '', old.kind, old.meta_json);
  INSERT INTO entities_fts(rowid, name, alias, kind, meta_text)
  VALUES (new.rowid, new.name, '', new.kind, new.meta_json);
END;
`;

function migrate(db) {
  db.exec(SCHEMA_SQL);
}

module.exports = { SCHEMA_SQL, migrate };