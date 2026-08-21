#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1872 (design doc PHA-1624 §11) — the Dune walkthrough, on disk.
//
// Direct DB calls only (no write API — Phase A ships read-only). Idempotent:
// re-running this script must not duplicate entities or edges. Entities use
// literal ids (ent_dune_book, etc.) with INSERT OR IGNORE so a second run is
// a no-op; edges rely on the schema's UNIQUE(from_id,to_id,type,source_service,source_id)
// constraint via INSERT OR IGNORE as well.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const entityGraph = require('../lib/sync/_schema');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
require('fs').mkdirSync(DATA_DIR, { recursive: true });

function seed(db) {
  entityGraph.migrate(db);
  const now = new Date().toISOString();

  function upsertEntity({ id, kind, name, slug, meta, source_service, source_id, created_by }) {
    db.prepare(`INSERT OR IGNORE INTO entities
        (id, kind, name, slug, meta_json, created_at, updated_at, created_by, source_service, source_id, name_lower)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, kind, name, slug, JSON.stringify(meta || {}), now, now, created_by,
           source_service || null, source_id || null, name.toLowerCase());
    return db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  }

  function upsertEdge({ id, from_id, to_id, type, source_service, source_id, deep_link, meta, created_by }) {
    db.prepare(`INSERT OR IGNORE INTO entity_edges
        (id, from_id, to_id, type, source_service, source_id, deep_link, meta_json, weight, created_by, created_at, updated_at, stale)
        VALUES (?,?,?,?,?,?,?,?,1.0,?,?,?,0)`)
      .run(id, from_id, to_id, type, source_service, source_id || null, deep_link || null,
           JSON.stringify(meta || {}), created_by, now, now);
  }

  // Step 1 — Kavita worker first run.
  upsertEntity({
    id: 'ent_dune_book', kind: 'work', name: 'Dune', slug: 'dune-book',
    meta: { isbn: '978-0-441-01359-3', year: 1965, deep_link: 'https://kavita.phatt.vip/series/1247' },
    source_service: 'kavita', source_id: 'series-1247', created_by: 'sync:kavita',
  });
  upsertEntity({
    id: 'ent_frank_herbert', kind: 'person', name: 'Frank Herbert', slug: 'frank-herbert',
    meta: {}, source_service: 'kavita', source_id: null, created_by: 'sync:kavita',
  });

  // Step 2 — Audiobookshelf worker first run.
  upsertEntity({
    id: 'ent_dune_audiobook', kind: 'work', name: 'Dune', slug: 'dune-audiobook',
    meta: { audible_id: 'B0725G4QK8', deep_link: 'https://audiobookshelf.phatt.vip/item/dune-B0725G4QK8' },
    source_service: 'audiobookshelf', source_id: 'B0725G4QK8', created_by: 'sync:audiobookshelf',
  });

  // Step 3 — Plex worker first run.
  upsertEntity({
    id: 'ent_dune_film_1984', kind: 'work', name: 'Dune', slug: 'dune-film-1984',
    meta: { tmdb_id: 693, year: 1984, deep_link: 'https://plex.phatt.vip/web/index.html#!/details?key=%2Flibrary%2Fmetadata%2F8435' },
    source_service: 'plex', source_id: '8435', created_by: 'sync:plex',
  });
  upsertEntity({
    id: 'ent_david_lynch', kind: 'person', name: 'David Lynch', slug: 'david-lynch',
    meta: {}, source_service: 'plex', source_id: null, created_by: 'sync:plex',
  });

  // Step 5 — manual concept link.
  upsertEntity({
    id: 'ent_concept_dune', kind: 'concept', name: 'Dune franchise', slug: 'dune-franchise',
    meta: {}, source_service: null, source_id: null, created_by: 'user:brandon',
  });

  // Edges per design doc §11 steps 1/2/3/5.
  upsertEdge({ id: 'edge_dune_book_authored_by', from_id: 'ent_dune_book', to_id: 'ent_frank_herbert',
    type: 'authored_by', source_service: 'kavita', source_id: 'series-1247', meta: { role: 'author' }, created_by: 'sync:kavita' });
  upsertEdge({ id: 'edge_dune_audiobook_authored_by', from_id: 'ent_dune_audiobook', to_id: 'ent_frank_herbert',
    type: 'authored_by', source_service: 'audiobookshelf', source_id: 'B0725G4QK8', meta: { role: 'author' }, created_by: 'sync:audiobookshelf' });
  upsertEdge({ id: 'edge_dune_film_directed_by', from_id: 'ent_dune_film_1984', to_id: 'ent_david_lynch',
    type: 'directed_by', source_service: 'plex', source_id: '8435', meta: {}, created_by: 'sync:plex' });

  upsertEdge({ id: 'edge_dune_book_tagged_concept', from_id: 'ent_dune_book', to_id: 'ent_concept_dune',
    type: 'tagged_with', source_service: 'kavita', source_id: 'series-1247', meta: { score: 1.0 }, created_by: 'user:brandon' });
  upsertEdge({ id: 'edge_dune_audiobook_tagged_concept', from_id: 'ent_dune_audiobook', to_id: 'ent_concept_dune',
    type: 'tagged_with', source_service: 'audiobookshelf', source_id: 'B0725G4QK8', meta: { score: 1.0 }, created_by: 'user:brandon' });
  upsertEdge({ id: 'edge_dune_film_tagged_concept', from_id: 'ent_dune_film_1984', to_id: 'ent_concept_dune',
    type: 'tagged_with', source_service: 'plex', source_id: '8435', meta: { score: 1.0 }, created_by: 'user:brandon' });

  // Available-as edges from the concept node so the concept's entity page
  // can render "Available as (3)" + quick-action deep links (design doc §11 step 6).
  upsertEdge({ id: 'edge_concept_available_book', from_id: 'ent_concept_dune', to_id: 'ent_dune_book',
    type: 'available_as', source_service: 'kavita', source_id: 'series-1247',
    deep_link: 'https://kavita.phatt.vip/series/1247', meta: { format: 'ebook' }, created_by: 'user:brandon' });
  upsertEdge({ id: 'edge_concept_available_audiobook', from_id: 'ent_concept_dune', to_id: 'ent_dune_audiobook',
    type: 'available_as', source_service: 'audiobookshelf', source_id: 'B0725G4QK8',
    deep_link: 'https://audiobookshelf.phatt.vip/item/dune-B0725G4QK8', meta: { format: 'audiobook' }, created_by: 'user:brandon' });
  upsertEdge({ id: 'edge_concept_available_film', from_id: 'ent_concept_dune', to_id: 'ent_dune_film_1984',
    type: 'available_as', source_service: 'plex', source_id: '8435',
    deep_link: 'https://plex.phatt.vip/web/index.html#!/details?key=%2Flibrary%2Fmetadata%2F8435', meta: { format: 'video' }, created_by: 'user:brandon' });

  upsertEdge({ id: 'edge_dune_film_adaptation_of', from_id: 'ent_dune_film_1984', to_id: 'ent_dune_book',
    type: 'adaptation_of', source_service: 'manual', source_id: null, meta: { medium: 'film' }, created_by: 'user:brandon' });

  // Aliases so search hits the concept + siblings.
  const aliasRows = [
    ['ent_dune_book', 'dune', 'canonical'],
    ['ent_dune_book', 'dune chronicles vol 1', 'manual'],
    ['ent_dune_audiobook', 'dune', 'canonical'],
    ['ent_dune_film_1984', 'dune', 'canonical'],
    ['ent_concept_dune', 'dune', 'canonical'],
  ];
  for (const [entity_id, alias, source] of aliasRows) {
    db.prepare(`INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_lower, source)
        VALUES (?,?,?,?)`).run(entity_id, alias, alias.toLowerCase(), source);
  }
}

if (require.main === module) {
  const db = new Database(path.join(DATA_DIR, 'life.db'));
  seed(db);
  console.log('[seed-dune] seeded Dune walkthrough entities/edges (idempotent).');
  db.close();
}

module.exports = { seed };
