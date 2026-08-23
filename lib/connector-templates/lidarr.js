// Homestead — Lidarr reference template (PHA-2448, *arr family).
//
// Lidarr is the music PVR. Same family: /api/v1/artist returns the
// library as a bare array; X-Api-Key auth. Per-artist nodes feed the
// entity graph under the `music_artist` kind — [[The National]]
// references here flow into the same canonical identity that a future
// Plex-style music library would contribute.

'use strict';

const { arrFactory, FAMILY_DEFAULTS } = require('./_arr-base');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://lidarr.example.com',
  secretRef: 'lidarr_api_key',
  minPollSeconds: 600,
  apiPrefix: '/api/v1',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return arrFactory({
    id: 'lidarr',
    name: 'Lidarr',
    icon: '🎵',
    category: 'media',
    listingPath: '/api/v1/artist',
    namePath: '$[*].artistName',
    lastAddedPath: '$[*].added',
    tileLabel: 'Artists',
    entityKind: 'artist',
    defaults: {
      baseUrl: opts.baseUrl,
      secretRef: opts.secretRef,
      minPollSeconds: opts.minPollSeconds,
      apiPrefix: opts.apiPrefix,
      name: opts.name || 'Lidarr',
    },
  });
}

module.exports = {
  factory,
  DEFAULTS,
};
