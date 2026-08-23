// Homestead — Sonarr reference template (PHA-2448, *arr family).
//
// Sonarr is the TV-show PVR: it downloads and organizes TV episodes.
// The documented API is `/api/v3/series` (bare array of series objects),
// and `X-Api-Key` is the documented auth header. We pull the series
// list as the canonical "what's in this install" probe; counts and
// recent additions feed the tile/card surfaces; per-series nodes feed
// the entity graph under the `tv_show` kind.

'use strict';

const { arrFactory, FAMILY_DEFAULTS } = require('./_arr-base');

const DEFAULTS = Object.freeze({
  baseUrl: FAMILY_DEFAULTS.baseUrl,
  secretRef: 'sonarr_api_key',
  minPollSeconds: 600,
  apiPrefix: '/api/v3',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return arrFactory({
    id: 'sonarr',
    name: 'Sonarr',
    icon: '📺',
    category: 'media',
    listingPath: '/api/v3/series',
    namePath: '$[*].title',
    lastAddedPath: '$[*].added',
    tileLabel: 'Shows',
    entityKind: 'tv_show',
    defaults: {
      baseUrl: opts.baseUrl,
      secretRef: opts.secretRef,
      minPollSeconds: opts.minPollSeconds,
      apiPrefix: opts.apiPrefix,
      name: opts.name || 'Sonarr',
    },
  });
}

module.exports = {
  factory,
  DEFAULTS,
};
