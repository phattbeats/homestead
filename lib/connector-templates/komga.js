// Homestead — Komga reference template (PHA-2444, Jenkins-corrected).
//
// The Komga REST API is the canonical "Tyler's comics app" use case
// from PHA-2428: real API, real auth (X-API-Key header), and a
// resource model (libraries → series → books) that maps cleanly onto
// Homestead's tile / card / entities / feed surfaces.
//
// This module is the REFERENCE TEMPLATE: a deterministic, validated
// ConnectorSpec that ships in-repo so users with a Komga server can
// import it directly. The agent-authored ramp (PHA-2428 / PHA-2448
// form wizard) uses these as worked examples; per-user overrides
// (baseUrl + secretRef name) are the only knobs a user changes.
//
// Jenkins's PHA-2431 review specifically called out:
//   1. Use header auth (X-API-Key), not the deprecated query-string
//      `?apiKey=` form.
//   2. Use /api/v1/libraries for library counts and $.length over
//      $.totalElements (Komga's libraries endpoint returns a bare
//      array, not a page envelope).
//   3. Use /api/v1/series?page=...&size=... for whole-library
//      series counts via $.totalElements (page envelope).
//   4. Avoid /api/v1/series/list — flagged as scheduled-for-removal
//      upstream and the page-size-unbounded response can DOS the
//      connector. Whole-library counts are deferred to a separately
//      reviewed read-query capability.
//   5. Use the "latest"/"new"/"updated" endpoints for tile / card /
//      recent-entity activity. These return page envelopes with
//      $.content[*] for the actual items.
//   6. The whole-library exact count is intentionally absent in v1.
//      Only the libraries-array count ($ length, fast) and the
//      per-probe recent endpoints are wired.
//
// The factory takes a small `overrides` object so the form wizard
// (PHA-2448) can stamp the user's baseUrl and secretRef name without
// rebuilding the spec from scratch:
//
//   const spec = factory({
//     baseUrl: 'https://komga.example.com',
//     secretRef: 'komga_api_key_brandon',
//   });
//
// Validation is performed by lib/connector-spec.js — this module
// only owns the data shape. If the factory ever produces a spec the
// validator rejects, that's a bug in THIS file.

'use strict';

// Komga's documented API key header (per their OpenAPI spec). The
// engine resolves the secret at request time from the encrypted
// per-user store keyed on `secretRef`.
const KOMGA_AUTH_HEADER = 'X-API-Key';

// Default knobs. The form wizard (PHA-2448) overrides these per user.
const DEFAULTS = Object.freeze({
  baseUrl: 'https://komga.example.com',
  secretRef: 'komga_api_key',
  // 5 minutes — Komga libraries rarely change; series arrive more
  // often. The form wizard lets the user bump this down to 60s for
  // a personal server, but the spec floor is 30s.
  minPollSeconds: 300,
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return {
    schema: 'homestead.connector/v1',
    id: 'komga',
    identity: {
      name: 'Komga',
      icon: '📚',
      category: 'media',
    },
    connection: {
      baseUrl: opts.baseUrl,
      auth: {
        type: 'header',
        name: KOMGA_AUTH_HEADER,
        secretRef: opts.secretRef,
      },
      // Pinned to GET-only. Komga has POST/PUT/DELETE for admin
      // operations; the v1 connector is read-only by design
      // (PHA-2428 §"No write-back in v1"), so even an allow-list
      // approach that admits other methods would widen the trust
      // surface for zero benefit.
      allowedMethods: ['GET'],
      // All four probes hit /api/v1/* — the documented namespace.
      // The regex is anchored so an accidental drift to /admin/* or
      // /api/v2/* would fail validation when a probe tries to use it.
      allowedPaths: ['^/api/v1/'],
      minPollSeconds: opts.minPollSeconds,
    },
    probes: [
      // Fast library census. Komga returns a bare array of library
      // objects; $.length gives us the count without iterating.
      {
        id: 'libraries',
        request: { path: '/api/v1/libraries' },
        extract: {
          // $.length over a top-level array works in our JSONPath
          // subset (treated as a child access — array.length is the
          // canonical name). For an array of objects, $.length is
          // the array length. Engine reads the int out of the
          // extracted value.
          count: '$.length',
          names: '$[*].name',
        },
      },
      // Recent additions — last 20 by created date. Used by the
      // card surface. $.content is the page-envelope items array.
      {
        id: 'on_deck',
        request: { path: '/api/v1/series/latest?page=0&size=20' },
        extract: {
          count: '$.totalElements',
          ids: '$.content[*].id',
          names: '$.content[*].name',
          urls: '$.content[*].url',
        },
      },
      // New series — recently added. Drives the feed surface.
      {
        id: 'new_series',
        request: { path: '/api/v1/series/new?page=0&size=20' },
        extract: {
          count: '$.totalElements',
          ids: '$.content[*].id',
          names: '$.content[*].name',
          last_added: '$.content[*].lastModified',
        },
      },
      // Updated series — recently changed. Drives tile status
      // ("last activity" timestamp). The form wizard surfaces this
      // as "X series updated in the last week" or similar.
      {
        id: 'updated_series',
        request: { path: '/api/v1/series/updated?page=0&size=20' },
        extract: {
          count: '$.totalElements',
          ids: '$.content[*].id',
          names: '$.content[*].name',
          last_modified: '$.content[*].lastModified',
        },
      },
    ],
    surfaces: {
      // Tile health: "12 series · last activity 3h ago". Status is
      // the probe-derived count, label is the human-readable name.
      tile: {
        from: 'updated_series',
        fields: {
          status: '$.count',
          label: 'Updated series',
        },
      },
      // Card summary: "3 libraries · 12 recent series". The card
      // reuses the libraries count and the onDeck names list. We
      // don't surface an exact whole-library count here — see the
      // PHA-2431 review note about deferring that until a
      // separately-reviewed read-query capability exists.
      card: {
        from: 'on_deck',
        fields: {
          // The card itself is per-probe; the engine joins across
          // probes if the surface declares a "merge" field. v1 keeps
          // it simple: the card carries the onDeck fields and a
          // separately-computed libraries count lands in the tile.
          count: '$.count',
          recent: '$.names',
        },
      },
      // Entity-graph nodes. comic_series is the canonical kind for
      // a comic-series metadata entry in Homestead's graph. We pull
      // from onDeck so the entities correspond to actually-recent
      // series, not every series ever (which is what Jenkins
      // flagged as DOS-prone).
      entities: {
        kind: 'comic_series',
        from: 'on_deck',
        id: '$.id',
        name: '$.name',
        url: '$.url',
      },
      // Feed events — new series added. The wall/feed renderer
      // formats these as "New series added: <name>".
      feed: {
        from: 'new_series',
        fields: {
          title: '$.names',
          url: '$.ids',
        },
      },
    },
  };
}

module.exports = {
  factory,
  DEFAULTS,
  KOMGA_AUTH_HEADER,
};
