// Homestead — *arr family reference template factory (PHA-2448).
//
// Sonarr, Radarr, Readarr, Lidarr, and Prowlarr all share a
// near-identical REST API shape (originally Sonarr; the others are
// forks of it): X-Api-Key header auth, the same
// `/api/v3/<resource>` namespace, the same JSON-only envelope
// shape (`[{ ... }]` arrays for collection endpoints; `{ ... }`
// objects for single-resource lookups), and the same `{"message": ...}`
// error envelope.
//
// Rather than copy the same factory five times with different ids, we
// expose a single `arrFactory(config)` that stamps per-app identity +
// the resource paths each one actually documents. The factory
// produces a ConnectorSpec that round-trips through
// `connector-spec.validate()` unchanged.
//
// Each *arr v3 endpoint we hit is GET-only; mutations stay out of v1
// per PHA-2428 §"No write-back in v1" — the user can pull counts and
// recently-added items, but cannot trigger searches, refreshes, or
// downloads.

'use strict';

// Common knobs across the *arr family. Per-app overrides live in
// `appConfig` below; the user can override both via the form wizard.
const FAMILY_DEFAULTS = Object.freeze({
  baseUrl: 'https://sonarr.example.com',
  secretRef: 'sonarr_api_key',
  minPollSeconds: 600,
  apiPrefix: '/api/v3',
});

function arrFactory(appConfig) {
  if (!appConfig || typeof appConfig !== 'object') {
    throw new Error('arrFactory requires an appConfig object');
  }
  if (!appConfig.id || !appConfig.name || !appConfig.icon) {
    throw new Error('arrFactory requires id, name, and icon');
  }
  if (!appConfig.listingPath) {
    throw new Error(`arrFactory for ${appConfig.id} requires listingPath`);
  }

  const opts = Object.assign({}, FAMILY_DEFAULTS, appConfig.defaults || {});
  const apiPrefix = opts.apiPrefix;

  // Identity bubble: defaults carry the user's overrides (e.g. a
  // renamed "Tyler's Sonarr" install), but the icon and category
  // belong to the template — the user changes those via the wizard's
  // display-name field, not by re-picking a template.
  const identityName = opts.name || appConfig.name;
  const identityIcon = appConfig.icon;
  const identityCategory = appConfig.category || 'media';

  return {
    schema: 'homestead.connector/v1',
    id: appConfig.id,
    identity: {
      name: identityName,
      icon: identityIcon,
      category: identityCategory,
    },
    connection: {
      baseUrl: opts.baseUrl,
      auth: {
        type: 'header',
        // X-Api-Key is the documented *arr auth header name; every
        // *arr fork uses it identically.
        name: 'X-Api-Key',
        secretRef: opts.secretRef,
      },
      allowedMethods: ['GET'],
      allowedPaths: [`^${apiPrefix}/`],
      minPollSeconds: opts.minPollSeconds,
    },
    probes: [
      {
        id: 'listing',
        request: { path: appConfig.listingPath },
        extract: {
          count: '$.length',
          ids: '$[*].id',
          names: appConfig.namePath,
          last_added: appConfig.lastAddedPath || '$[*].added',
        },
      },
    ],
    surfaces: {
      // Tile: number of items in this *arr's library. Same shape
      // across the family; user can rename label.
      tile: {
        from: 'listing',
        fields: {
          status: '$.count',
          label: appConfig.tileLabel || 'Items',
        },
      },
      card: {
        from: 'listing',
        fields: {
          count: '$.count',
          recent: '$.names',
        },
      },
      // Entities: per-app kind matches the *arr's primary domain
      // (tv_show vs movie vs book vs music_artist vs indexer). The
      // entity graph joins [[The Office]] from Sonarr to [[The
      // Office]] from Readarr (the audiobook) for cross-references.
      // Per-item entity graph nodes. The runner iterates the
      // `listing` probe array and extracts one entity per row; each
      // path runs against the per-item context (so `$.id` is the
      // item's own id, not the array's).
      entities: {
        kind: appConfig.entityKind || 'media_item',
        from: 'listing',
        id: '$.id',
        name: appConfig.namePath,
      },
    },
  };
}

module.exports = {
  arrFactory,
  FAMILY_DEFAULTS,
};
