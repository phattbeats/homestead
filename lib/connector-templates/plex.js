// Homestead — Plex reference template (PHA-2448, Connector Forge
// form-wizard templates).
//
// Plex is a media server (movies / TV / music). Auth model: an
// X-Plex-Token is preferred (a long-lived token from the user's
// account settings). ConnectorSpec supports `header` auth with a
// user-chosen header name; the documented Plex token header is
// `X-Plex-Token`, distinct from `Authorization` (which is reserved
// for bearer/JWT).
//
// Endpoints (Plex Media Server, GET-only):
//   * /library/sections         — bare array of library sections; each
//                                 carries type ("movie"/"show"/"artist")
//                                 and title
//   * /library/sections/<id>/all?type=<n>&X-Plex-Container-Size=20
//                              — paginated Metadata container; the
//                                 container has a `size` attribute
//                                 (NOT a JSONPath — but we treat the
//                                 response envelope's `MediaContainer`
//                                 wrapper as the root). For v1 we use
//                                 /library/sections only and let the
//                                 user opt into the per-library drill
//                                 via the agent-authored ramp.
//
// Plex's documented headers also include `X-Plex-Product`,
// `X-Plex-Version`, etc. — we deliberately do NOT include any of
// these (the validator allows only `type`, `name`, `secretRef` on
// the auth block, and `name` becomes the literal header name). If a
// future user needs custom Plex headers, that's a v2 spec extension,
// not a v1 workaround.

'use strict';

const PLEX_AUTH_HEADER = 'X-Plex-Token';

const DEFAULTS = Object.freeze({
  baseUrl: 'https://plex.example.com',
  secretRef: 'plex_token',
  minPollSeconds: 600,
  name: 'Plex',
  icon: '🎞️',
  category: 'media',
});

function factory(overrides) {
  const opts = Object.assign({}, DEFAULTS, overrides || {});
  return {
    schema: 'homestead.connector/v1',
    id: 'plex',
    identity: {
      name: opts.name,
      icon: opts.icon,
      category: opts.category,
    },
    connection: {
      baseUrl: opts.baseUrl,
      auth: {
        type: 'header',
        name: PLEX_AUTH_HEADER,
        secretRef: opts.secretRef,
      },
      allowedMethods: ['GET'],
      // Plex Media Server's HTTP root is typically `:32400/web/...`
      // or `:32400/...` (no /api/ prefix). The resources this
      // template probes are all under `/library/...`, the documented
      // base for the REST-style surface. A user with a Plex server
      // behind a reverse proxy can override baseUrl without
      // changing allowedPaths (e.g.,
      // `https://plex.example.com` resolves to /library/sections
      // via a typical SWAG/Nginx config).
      allowedPaths: ['^/library/'],
      minPollSeconds: opts.minPollSeconds,
    },
    probes: [
      {
        id: 'sections',
        request: { path: '/library/sections' },
        extract: {
          // /library/sections returns a MediaContainer whose
          // `Directory` array is the section list. We extract the
          // array length and titles. The wrapper key (Directory)
          // is deliberately not part of the JSONPath subset — for
          // v1 we recommend users browse the response and trust the
          // adapter read; the shape changes between Plex versions.
          // For now: a permissive $.length, with names fallback.
          count: '$.length',
          names: '$[*].title',
        },
      },
    ],
    surfaces: {
      tile: {
        from: 'sections',
        fields: {
          status: '$.count',
          label: 'Libraries',
        },
      },
      card: {
        from: 'sections',
        fields: {
          count: '$.count',
          recent: '$.names',
        },
      },
      entities: {
        // Plex sections are typed (movie/show/artist). We pick
        // `other` because a section is a *container*, not a single
        // media row; per-row entities come in ramp-2 when the
        // wizard lets users pick a specific library to drill into.
        kind: 'other',
        from: 'sections',
        id: '$.id',
        name: '$.title',
      },
    },
  };
}

module.exports = {
  factory,
  DEFAULTS,
  PLEX_AUTH_HEADER,
};
