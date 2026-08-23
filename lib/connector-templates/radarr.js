// Homestead — Radarr reference template (PHA-2448, *arr family).
//
// Radarr is the movies PVR: same API shape as Sonarr (a fork of it).
// /api/v3/movies returns the library as a bare array; X-Api-Key auth
// header. Per-movie nodes feed the entity graph under the `movie` kind
// so [[Dune]] references flow through the movies pathway (parallel to
// Komga's comics pathway via `comic_series`).

'use strict';

const { arrFactory, FAMILY_DEFAULTS } = require('./_arr-base');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://radarr.example.com',
  secretRef: 'radarr_api_key',
  minPollSeconds: 600,
  apiPrefix: '/api/v3',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return arrFactory({
    id: 'radarr',
    name: 'Radarr',
    icon: '🎬',
    category: 'media',
    listingPath: '/api/v3/movie',
    namePath: '$[*].title',
    lastAddedPath: '$[*].added',
    tileLabel: 'Movies',
    entityKind: 'movie',
    defaults: {
      baseUrl: opts.baseUrl,
      secretRef: opts.secretRef,
      minPollSeconds: opts.minPollSeconds,
      apiPrefix: opts.apiPrefix,
      name: opts.name || 'Radarr',
    },
  });
}

module.exports = {
  factory,
  DEFAULTS,
};
