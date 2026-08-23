// Homestead — Prowlarr reference template (PHA-2448, *arr family).
//
// Prowlarr is the indexer manager that sits in front of Sonarr/Radarr
// etc. Same API shape: /api/v1/indexer returns the configured indexers
// as a bare array; X-Api-Key auth. We surface it differently from the
// media apps: it's plumbing, not a library. The entity-graph kind is
// `indexer` instead of a media kind, and the tile label is "Indexers"
// rather than "Items" so it doesn't get confused with a media library
// at a glance.
//
// Per-indexer surface details include: name, protocol, capabilities
// (movie/tv/music/etc.) — the form wizard lets the user pick whether
// to surface those as separate `extra` entity fields later if
// app-install telemetry says they want them.

'use strict';

const { arrFactory, FAMILY_DEFAULTS } = require('./_arr-base');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://prowlarr.example.com',
  secretRef: 'prowlarr_api_key',
  minPollSeconds: 1800, // 30 min — indexer list rarely changes
  apiPrefix: '/api/v1',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return arrFactory({
    id: 'prowlarr',
    name: 'Prowlarr',
    icon: '🔍',
    category: 'media',
    listingPath: '/api/v1/indexer',
    namePath: '$[*].name',
    lastAddedPath: '$[*].added',
    tileLabel: 'Indexers',
    // Indexers are infrastructure records, not media catalog items.
    // `other` is the v1 ConnectorSpec vocabulary's intentionally
    // neutral entity kind for connector-specific records.
    entityKind: 'other',
    defaults: {
      baseUrl: opts.baseUrl,
      secretRef: opts.secretRef,
      minPollSeconds: opts.minPollSeconds,
      apiPrefix: opts.apiPrefix,
      name: opts.name || 'Prowlarr',
    },
  });
}

module.exports = {
  factory,
  DEFAULTS,
};
