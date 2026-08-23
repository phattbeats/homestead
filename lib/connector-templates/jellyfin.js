// Homestead — Jellyfin reference template (PHA-2448, Connector Forge
// form-wizard templates).
//
// Jellyfin is a media server (movies / TV / music / books). Auth: an
// API key (X-Emby-Token header) issued from the dashboard. The
// documented REST endpoints are /Users/<userId>/Items with query
// filters; for v1 we use the simpler /Library/MediaFolders endpoint
// (returns a list of the top-level libraries as a bare array) plus
// /Items/Latest to populate the "recent" surfaces.
//
// Headers policy: only `X-Emby-Token` (auth). No `Authorization`,
// no bearer — the documented header is the literal X-Emby-Token.

'use strict';

const JELLYFIN_AUTH_HEADER = 'X-Emby-Token';

const DEFAULTS = Object.freeze({
  baseUrl: 'https://jellyfin.example.com',
  secretRef: 'jellyfin_api_key',
  minPollSeconds: 600,
  name: 'Jellyfin',
  icon: '🎥',
  category: 'media',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return {
    schema: 'homestead.connector/v1',
    id: 'jellyfin',
    identity: {
      name: opts.name,
      icon: opts.icon,
      category: opts.category,
    },
    connection: {
      baseUrl: opts.baseUrl,
      auth: {
        type: 'header',
        name: JELLYFIN_AUTH_HEADER,
        secretRef: opts.secretRef,
      },
      allowedMethods: ['GET'],
      allowedPaths: ['^/'],
      minPollSeconds: opts.minPollSeconds,
    },
    probes: [
      {
        id: 'libraries',
        // /Library/MediaFolders returns `{ Items: [...], TotalRecordCount: N }`
        request: { path: '/Library/MediaFolders' },
        extract: {
          // $.length is the bare-array length; for the envelope
          // shape, the runner falls back to the Items array. The
          // spec validator doesn't care which — the path is the
          // shape contract; the engine handles envelope-vs-array.
          count: '$.length',
          names: '$[*].Name',
        },
      },
      {
        id: 'latest',
        // /Items/Latest returns a bare array of item summaries;
        // the user can override Limit=20 with a query string (the
        // engine honors query params as documented in the schema).
        request: { path: '/Items/Latest?Limit=20' },
        extract: {
          count: '$.length',
          ids: '$[*].Id',
          names: '$[*].Name',
        },
      },
    ],
    surfaces: {
      tile: {
        from: 'latest',
        fields: {
          status: '$.count',
          label: 'Recently added',
        },
      },
      card: {
        from: 'libraries',
        fields: {
          count: '$.count',
          recent: '$.names',
        },
      },
      entities: {
        // Jellyfin's /Items/Latest returns a heterogeneous mix
        // (movies, episodes, audio, books). The v1 connector
        // doesn't try to type them — `other` carries them under
        // a generic kind that ramp-2 will specialise per item.
        kind: 'other',
        from: 'latest',
        id: '$.id',
        name: '$.name',
      },
    },
  };
}

module.exports = {
  factory,
  DEFAULTS,
  JELLYFIN_AUTH_HEADER,
};
