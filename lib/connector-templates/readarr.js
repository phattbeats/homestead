// Homestead — Readarr reference template (PHA-2448, *arr family).
//
// Readarr is the books/audiobooks PVR: same API shape as Sonarr/Radarr
// (yet another fork). /api/v1/book returns the library as a bare array;
// the books API uses /api/v1 not /api/v3 (Readarr lags the others on
// the version bump). auth is still X-Api-Key.
//
// Readarr is the natural fit for Tyler's "comics app" — if he has a
// Readarr instance for audiobooks, the read-book nodes join [[Dune]]
// across Komga, Readarr, and Radarr under different kinds but the same
// canonical external id surface.

'use strict';

const { arrFactory, FAMILY_DEFAULTS } = require('./_arr-base');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://readarr.example.com',
  secretRef: 'readarr_api_key',
  minPollSeconds: 600,
  // Readarr still uses /api/v1 where Sonarr/Radarr moved to v3.
  apiPrefix: '/api/v1',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return arrFactory({
    id: 'readarr',
    name: 'Readarr',
    icon: '📚',
    category: 'media',
    listingPath: '/api/v1/book',
    namePath: '$[*].title',
    lastAddedPath: '$[*].added',
    tileLabel: 'Books',
    entityKind: 'book',
    defaults: {
      baseUrl: opts.baseUrl,
      secretRef: opts.secretRef,
      minPollSeconds: opts.minPollSeconds,
      apiPrefix: opts.apiPrefix,
      name: opts.name || 'Readarr',
    },
  });
}

module.exports = {
  factory,
  DEFAULTS,
};
