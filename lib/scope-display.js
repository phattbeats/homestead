// Homestead third-party app scope → plain-language display mapping
// (PHA-2201.2 / PHA-2230). Design note: PHA-2201 §3 (scope vocabulary,
// locked for v0.3.0) and §4 (consent-screen copy).
//
// Pure display logic — no DB, no express, no side effects. Runs in two
// places, from the SAME source file:
//   * Node (server.js, scripts/test-scope-display.js) via
//     `require('./lib/scope-display')`
//   * The browser (public/consent.js today; Settings → Apps →
//     "what this app can do" in PHA-2201.4) via a <script src="/lib/
//     scope-display.js"> tag that server.js serves directly from this
//     file — see the dual CommonJS/global export at the bottom.
//
// Contract (design note §3): the scopes below are the ONLY scopes a
// manifest may declare. A scope that isn't in this vocabulary — typo,
// future scope not yet added here, or one of the explicitly rejected
// admin/internal scopes — must fail loudly (describeScope throws)
// rather than render its raw `read:foo:bar` form to a user. Adding a
// new scope to the vocabulary is a change to this file, not a per-app
// escape hatch.

'use strict';

// ---- Fixed scopes: exact string → phrase. -------------------------------
// `read:walls:media_club` lives here (not in the dynamic wall_id pattern
// below) because §3 calls it out as its own fixed sub-vocabulary entry,
// not an arbitrary wall id.
const SCOPE_PHRASES = {
  'read:me': 'See your profile and which modules you have turned on',
  'write:me': 'Update your profile',

  'read:walls': 'Read posts on walls you belong to',
  'read:walls:media_club': 'Read posts on the media-club wall',
  'write:walls:post': 'Post to walls you belong to',
  'write:walls:react': 'React to posts on walls you belong to',
  'write:walls:moderate': 'Delete or pin posts on walls you moderate',

  'read:lists': 'Read your shared lists',
  'write:lists': 'Add to or edit your shared lists',

  'read:tasks': 'Read your chore rotations',
  'write:tasks': 'Update your chore rotations',

  'read:events': 'Read your household calendar',
  'write:events': 'Add or edit events on your household calendar',
  'read:event_series': 'Read recurring events on your calendar',
  'write:event_series': 'Add or edit recurring events on your calendar',

  'agent:invoke': 'Invoke your drawer agent',
  'agent:events:read': "Read your agent's event log",
  'agent:events:subscribe': "Receive webhooks for your agent's events",

  // `apps` (the tiled launcher, PHA-1863) is a built-in per design
  // note §6's built-in mapping table, dogfooding the same vocabulary —
  // this scope has no third-party equivalent (an app can't grant
  // itself the launcher's own view), but the built-in must still
  // describe through this file like every other module (PHA-2232:
  // Settings → Apps renders built-ins through the same mapping).
  'read:services': 'See the services tiles you have turned on',
};

// Scopes named in §3 as explicitly rejected, never grantable to a
// third-party app. Listed here (rather than just falling through to the
// generic "unmapped" error) so describeScope can say why, not just that
// it failed.
const REJECTED_SCOPES = new Set([
  'admin:*',
  'read:audit_log',
  'write:users',
  'read:secrets',
]);

// The full set of fixed, non-templated scope strings — used by the
// vocabulary-exhaustiveness test (scripts/test-scope-display.js) so a
// scope added to §3 without a phrase here fails CI instead of shipping
// as raw text on the consent screen.
const SCOPE_VOCABULARY = Object.freeze(Object.keys(SCOPE_PHRASES));

function pluralize(word) {
  if (/[sxz]$/.test(word) || /[cs]h$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

function humanize(word) {
  return word.replace(/_/g, ' ');
}

// Dynamic patterns, tried only after the exact-match map misses. Each
// `describe` returns a phrase string, or null to mean "shape matched but
// this isn't actually valid" (falls through to the unmapped-scope error).
const PATTERNS = [
  {
    // read:walls:{wall_id} — any wall id other than the fixed
    // media_club sub-vocabulary entry above.
    test: /^read:walls:([a-zA-Z0-9_-]+)$/,
    describe(m) {
      return `Read posts on the "${m[1]}" wall`;
    },
  },
  {
    // read:{entity_kind} / write:{entity_kind} — §3's generic entity
    // CRUD pattern. Only valid for kinds the manifest actually declared
    // in entity_kinds[]; an app cannot escape its declared kinds by
    // guessing a plural.
    test: /^(read|write):([a-z][a-z0-9_]*)$/,
    describe(m, context) {
      const [, verb, kind] = m;
      const entityKinds = (context && context.entityKinds) || [];
      const known = entityKinds.some((k) => pluralize(k) === kind);
      if (!known) return null;
      const action = verb === 'read' ? 'Read' : 'Create and edit';
      return `${action} ${humanize(kind)}`;
    },
  },
];

// describeScope(scope, context?) -> phrase string, or throws.
//
// `context.entityKinds` is a manifest's entity_kinds[] array (needed to
// resolve the read:{kind}/write:{kind} pattern). Omit it for scopes that
// don't need it.
function describeScope(scope, context) {
  if (Object.prototype.hasOwnProperty.call(SCOPE_PHRASES, scope)) {
    return SCOPE_PHRASES[scope];
  }
  if (REJECTED_SCOPES.has(scope)) {
    throw new Error(`scope "${scope}" is never grantable to a third-party app (PHA-2201 §3)`);
  }
  for (const pattern of PATTERNS) {
    const m = scope.match(pattern.test);
    if (!m) continue;
    const phrase = pattern.describe(m, context);
    if (phrase) return phrase;
  }
  throw new Error(`unmapped scope "${scope}" — not in the PHA-2201 §3 vocabulary`);
}

// describeScopes(scopes, context?) -> phrase[]. Collects every unmapped
// scope into a single error instead of failing on the first one, so a
// bad manifest's whole scopes[] list can be reported at once.
function describeScopes(scopes, context) {
  const phrases = [];
  const errors = [];
  for (const scope of scopes || []) {
    try {
      phrases.push(describeScope(scope, context));
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
  return phrases;
}

// This file is included by public/index.html as a plain script. Keep its
// export binding distinct from the inline page's `api` helper: plain scripts
// share the global lexical scope, so a second top-level `const api` prevents
// the entire SPA from parsing.
const __scopeDisplay = { describeScope, describeScopes, SCOPE_VOCABULARY };

/* eslint-disable no-undef */
if (typeof module === 'object' && module.exports) {
  module.exports = __scopeDisplay;
}
if (typeof window !== 'undefined') {
  window.ScopeDisplay = __scopeDisplay;
}
/* eslint-enable no-undef */
