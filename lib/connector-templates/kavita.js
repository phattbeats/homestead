// Homestead — Kavita reference template (PHA-2448, Connector Forge
// form-wizard templates).
//
// Kavita is a comics/manga/ebook reader server: the same niche as Komga
// (the PHA-2428 Tyler's-comics scenario) with a near-identical API shape
// (libraries → series → volumes → chapters). It uses JWT auth via POST
// /api/Account/login, which is NOT in our trust-boundary safe-by-default
// surface — a connector that needs to mint credentials against a remote
// service widens the threat model.
//
// For v1 (per PHA-2428 §"No write-back in v1"), we instead accept a
// long-lived API key Kavita ships from its UI (Settings → Users →
// <user> → API Key). Kavita authenticates this key with the same JWT
// path internally but the user pastes the already-issued token, which
// sidesteps us needing to ever call the login endpoint. The header
// pattern is `Authorization: Bearer <key>` — matches our existing
// `bearer` auth-type in connector-spec.js, which uses the
// `Authorization` header implicitly (no `name` allowed).
//
// Endpoints (all GET, all under /api/, all anchored via the
// `allowedPaths` regex):
//   * /api/Library/list        — bare array; $.length gives the count
//   * /api/Series/latest       — { result: [ ... ] } envelope; $.result
//                                for items, $.result.length for count
//   * /api/Series/new          — paginated { result, totalCount } where
//                                totalCount is the page envelope's
//                                whole-page count
//
// Read-only by design (matches the PHA-2428 + PHA-2431 read-only
// posture). No POST/PUT/DELETE probed; no write surface emitted.

'use strict';

const DEFAULTS = Object.freeze({
  baseUrl: 'https://kavita.example.com',
  secretRef: 'kavita_api_key',
  // 5 minutes — same floor as Komga; user can bump down to 60s for
  // a personal server.
  minPollSeconds: 300,
  // Identity defaults. The form wizard always lets the user rename,
  // re-icon, and re-categorize their installation; these are just
  // the in-repo template starting points.
  name: 'Kavita',
  icon: '📖',
  category: 'media',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return {
    schema: 'homestead.connector/v1',
    id: 'kavita',
    identity: {
      name: opts.name,
      icon: opts.icon,
      category: opts.category,
    },
    connection: {
      baseUrl: opts.baseUrl,
      auth: {
        // `bearer` type uses the Authorization header implicitly;
        // connector-spec.js forbids setting a `name` on this path
        // (a separate header is just `type: 'header'` with the
        // explicit header name). Kavita accepts
        // `Authorization: Bearer <key>`.
        type: 'bearer',
        secretRef: opts.secretRef,
      },
      allowedMethods: ['GET'],
      allowedPaths: ['^/api/'],
      minPollSeconds: opts.minPollSeconds,
    },
    probes: [
      {
        id: 'libraries',
        request: { path: '/api/Library/list' },
        extract: {
          count: '$.length',
          names: '$[*].name',
        },
      },
      {
        id: 'latest_series',
        request: { path: '/api/Series/latest' },
        extract: {
          // Latest series envelope is `{ result: [...] }` — the
          // engine reads $.result for entity rows; count is the
          // length of that array.
          count: '$.result.length',
          ids: '$.result[*].id',
          names: '$.result[*].name',
          urls: '$.result[*].url',
        },
      },
      {
        id: 'new_series',
        request: { path: '/api/Series/new?page=0&size=20' },
        extract: {
          count: '$.totalCount',
          ids: '$.result[*].id',
          names: '$.result[*].name',
          last_added: '$.result[*].lastModifiedUtc',
        },
      },
    ],
    surfaces: {
      // Tile: "12 series · most recent: ..." — same shape as Komga.
      tile: {
        from: 'new_series',
        fields: {
          status: '$.count',
          label: 'New series',
        },
      },
      // Card: series count + recent names, parallel to Komga's
      // card. The user can rename these labels in their install.
      card: {
        from: 'latest_series',
        fields: {
          count: '$.count',
          recent: '$.names',
        },
      },
      // Entities: comic_series nodes for the latest-series probe.
      // The "kind" matches Komga's so the entity graph joins
      // comics-style series under a single kind and Tyler's existing
      // [[Dune]]-style cross-references work for Kavita too.
      entities: {
        kind: 'comic_series',
        from: 'latest_series',
        id: '$.id',
        name: '$.name',
        url: '$.url',
      },
      // Feed: new series events.
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
};
