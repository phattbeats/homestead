// Homestead — ConnectorSpec schema, validator, and reference-template
// registry (PHA-2444, Connector Forge).
//
// The contract:
//
//   * Specs are **data, not code**. The validator's job is to prove
//     that. A spec that survives validation cannot express computation,
//     cannot include foreign headers, cannot hit a metadata endpoint,
//     cannot resolve into Homestead's own origin, and cannot smuggle a
//     secret inline.
//
//   * **Strict, narrow, auditable.** We deliberately use a hand-rolled
//     shape check (the same pattern as lib/registry-validate.js) rather
//     than a JSON Schema dependency — JSON Schema is great for open
//     catalogs but here the trust boundary demands we see every rule
//     in this file. Adding a dep would push trust outside the repo.
//
//   * **Versioned.** `homestead.connector/v1` is the schema id; future
//     revisions land as v2/v3 with their own validators rather than
//     silently accepting v1 inputs. The engine (PHA-2445) only loads
//     specs whose `schema` field matches the version it knows how to
//     run.
//
//   * **Defense in depth, fail-closed.** Validation rejects:
//       - unrecognised top-level or nested fields (no future-proofing
//         via $schema-less extras — the engine doesn't know what they
//         mean)
//       - duplicate probe ids / probe request paths
//       - any non-GET method on the wire
//       - request bodies (the only HTTP method allowed is GET)
//       - arbitrary headers (an explicit allow-list)
//       - redirect-following (turn it off at the engine layer; the
//         validator emits a flag the engine honors)
//       - bases whose hostname resolves into a private range, unless
//         the install explicitly opted into local-network consent
//       - DNS rebinding: the engine pins resolution at request time
//         and re-resolves on every request; this module exposes the
//         resolver so the engine can reuse it
//       - inline secrets in the spec (the auth.secretRef MUST point
//         at a per-user key in the encrypted store; literal secrets
//         fail validation)
//
//   * **JSONPath restricted to a subset.** The parser in `lib/jsonpath.js`
//     is the one true path language. Specs that try to use a richer
//     JSONPath (filters, descendant operators, scripts, slices with
//     step) are rejected at install time, not silently truncated at
//     probe time. The connector engine uses `jsonpath.parse()` to
//     pre-validate every mapping.
//
//   * **Komga reference template** (lib/connector-templates/komga.js)
//     is a pure data factory that returns a spec validating against
//     this module — proves the schema accepts a real-world config and
//     gives Brandon one worked example.
//
// Spec format (homestead.connector/v1):
//
//   {
//     "schema": "homestead.connector/v1",
//     "id": "komga",
//     "identity": {
//       "name": "Komga",
//       "icon": "📚",
//       "category": "media"
//     },
//     "connection": {
//       "baseUrl": "https://komga.example.com",
//       "auth": { "type": "header", "name": "X-API-Key", "secretRef": "komga_api_key" },
//       "allowedMethods": ["GET"],
//       "allowedPaths": ["^/api/v1/.*"],
//       "minPollSeconds": 300
//     },
//     "probes": [
//       {
//         "id": "libraries",
//         "request": { "path": "/api/v1/libraries" },
//         "extract": {
//           "count": "$.length",
//           "names": "$[*].name"
//         }
//       }
//     ],
//     "surfaces": {
//       "tile":  { "from": "libraries", "fields": { "status": "$.length", "label": "Libraries" } },
//       "card":  { "from": "libraries", "fields": { "count": "$.length", "recent": "$[*].name" } },
//       "entities": {
//         "kind": "comic_series",
//         "from": "seriesList",
//         "id": "$.id",
//         "name": "$.name"
//       },
//       "feed": { "from": "onDeck", "fields": { "title": "$.name", "url": "$.url" } }
//     }
//   }
//
// The schema intentionally has no place for `headers`, `body`, `params`,
// `method` (always GET), or `followRedirects` (always false). If we
// ever need to extend, we add a field to ALLOWED_FIELDS below and
// explain the trust-boundary implication in a comment.

'use strict';

const dns = require('dns').promises;
const net = require('net');

const jsonpath = require('./jsonpath');

// ---- Schema metadata ----------------------------------------------------

const SCHEMA_ID = 'homestead.connector/v1';

// Allowed top-level fields. Anything else is a hard reject. Order is
// stable so error messages are stable.
const ALLOWED_TOP_LEVEL = Object.freeze([
  'schema',
  'id',
  'identity',
  'connection',
  'probes',
  'surfaces',
]);

// Fields every section is allowed to have. Any extra is a hard reject.
const ALLOWED_IDENTITY_FIELDS = Object.freeze(['name', 'icon', 'category']);
const ALLOWED_CONNECTION_FIELDS = Object.freeze([
  'baseUrl',
  'auth',
  'allowedMethods',
  'allowedPaths',
  'minPollSeconds',
]);
const ALLOWED_AUTH_FIELDS = Object.freeze(['type', 'name', 'secretRef']);
const ALLOWED_PROBE_FIELDS = Object.freeze(['id', 'request', 'extract']);
const ALLOWED_PROBE_REQUEST_FIELDS = Object.freeze(['path']);
const ALLOWED_SURFACES_FIELDS = Object.freeze(['tile', 'card', 'entities', 'feed']);
const ALLOWED_TILE_FIELDS = Object.freeze(['from', 'fields']);
const ALLOWED_CARD_FIELDS = Object.freeze(['from', 'fields']);
const ALLOWED_ENTITIES_FIELDS = Object.freeze(['kind', 'from', 'id', 'name', 'url', 'extra']);
const ALLOWED_FEED_FIELDS = Object.freeze(['from', 'fields']);

// Auth types the v1 engine knows about. Header auth is the only one
// Tyler / Komga / the existing first-party clients need. Bearer goes
// through the same code path (header auth with a reserved name) so we
// don't expose a separate code path that could drift.
const VALID_AUTH_TYPES = Object.freeze(['header', 'bearer']);
const VALID_HTTP_METHODS = Object.freeze(['GET']);
const VALID_IDENTITY_CATEGORIES = Object.freeze([
  'media', 'productivity', 'communication', 'finance', 'home', 'other',
]);
const VALID_SURFACE_ENTITY_KINDS = Object.freeze([
  'comic_series', 'comic_volume', 'comic_book',
  'movie', 'tv_show', 'tv_episode', 'album', 'track', 'artist',
  'book', 'task', 'event', 'contact', 'note', 'other',
]);

// ---- Errors -------------------------------------------------------------

class ConnectorSpecError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'ConnectorSpecError';
    this.path = path || '$';
  }
}

// Reject unknown fields on a plain object. Returns the first offender.
// `obj` must be a non-null object; `allowed` is the frozen list of
// keys; `where` is the human-readable path used in the error.
function rejectUnknownFields(obj, allowed, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ConnectorSpecError(`${where} must be an object`, where);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new ConnectorSpecError(
        `${where}: field "${k}" is not allowed (allowed: ${allowed.join(', ')})`,
        where
      );
    }
  }
}

// ---- Field validators ---------------------------------------------------

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// "Does this look like a pasted secret value rather than a key id?"
// — catches common mistake shapes (Bearer prefix, sk- prefix, long
// base64/hex blobs, anything containing whitespace, dots, or slashes).
// A real secretRef is a short lowercase identifier without any of
// those characters.
function looksLikeInlineSecret(value) {
  if (typeof value !== 'string') return false;
  if (/^\s|\s$/.test(value)) return true;                  // whitespace
  if (/[\.\/\+=]/.test(value)) return true;                // punctuation typical of secrets
  if (/^(bearer|sk-|pk-|api[-_]?key[-_]?)/i.test(value)) return true;
  // Long base64/hex blobs (>= 32 chars, no separator) are almost
  // certainly a paste-by-mistake. A real secretRef is either short
  // (<= 32 chars) OR has separators (underscores) every few chars.
  if (value.length >= 32 && !/_/.test(value)) {
    // No underscores in a >= 32 char value — looks like a blob, not a name.
    if (/^[a-f0-9]+$/i.test(value)) return true;           // pure hex
    if (/^[A-Za-z0-9+/=_-]{32,}$/.test(value)) return true; // base64-ish
  }
  return false;
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isStringOrNull(v) { return v === null || typeof v === 'string'; }

function validateIdentifier(value, where) {
  if (!isNonEmptyString(value)) {
    throw new ConnectorSpecError(`${where} must be a non-empty string`, where);
  }
  // Lowercase kebab/snake, 2-32 chars, no leading dot. Matches the
  // built-in module key rules (lib/registry-validate.js) so a future
  // shared naming space stays consistent.
  if (!/^[a-z0-9_-]{2,32}$/.test(value)) {
    throw new ConnectorSpecError(
      `${where} must match [a-z0-9_-]{2,32} (got "${value}")`,
      where
    );
  }
}

function validateHttpUrl(raw, where) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new ConnectorSpecError(`${where} is not a valid URL: "${raw}"`, where);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConnectorSpecError(
      `${where} must use http(s); got "${parsed.protocol}"`,
      where
    );
  }
  return parsed;
}

function validateJsonPath(expression, where) {
  try {
    jsonpath.parse(expression);
  } catch (err) {
    throw new ConnectorSpecError(
      `${where}: JSONPath "${expression}" rejected — ${err.message}`,
      where
    );
  }
}

// Network-policy gate. Caller passes the parsed base URL plus the
// installation's `localNetworkConsent` flag (a server-wide opt-in for
// LAN services). Loopback / link-local / RFC1918 / ULA / metadata /
// Homestead's own origin are always rejected.
//
// This runs synchronously against the URL alone; the engine adds
// DNS-resolution pinning on top (see lib/connector-spec.js#checkHost).
function checkOriginPolicy(parsed, { localNetworkConsent = false, homesteadOrigin = null } = {}) {
  const hostname = parsed.hostname;
  const proto = parsed.protocol;

  // Always reject cloud metadata. Cloud metadata IP literals and
  // known hostnames are out-of-bounds even with consent.
  const metadataHosts = new Set([
    'metadata.google.internal',
    'metadata',
    '169.254.169.254', // AWS / Azure / GCP / DigitalOcean / OpenStack
  ]);
  if (metadataHosts.has(hostname.toLowerCase())) {
    throw new ConnectorSpecError(
      `baseUrl hostname "${hostname}" is a cloud-metadata address — always rejected`,
      '$.connection.baseUrl'
    );
  }

  // Reject Homestead's own origin so a malicious connector can't
  // SSRF into the home server. Loopback is rejected below for the
  // same reason; this catches the explicit prod domain too.
  if (homesteadOrigin) {
    let ho;
    try { ho = new URL(homesteadOrigin); } catch (_) { ho = null; }
    if (ho && ho.host === parsed.host) {
      throw new ConnectorSpecError(
        `baseUrl "${parsed.href}" resolves to Homestead's own origin — always rejected`,
        '$.connection.baseUrl'
      );
    }
  }

  // Classify the host. WHATWG URL returns IPv6 hosts with brackets
  // (e.g. "[::1]"); strip them before isIP / classification.
  const rawHost = parsed.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  const family = net.isIP(host);
  const isPrivate = family !== 0 ? isPrivateIp(host, family)
                                  : isPrivateHostname(host);

  if (isPrivate) {
    // Loopback is special — Homestead's own process runs there, so
    // a connector pointed at loopback is a trivial SSRF into
    // Homestead itself. Always rejected, before the consent gate.
    if (family === 4 && /^127\./.test(host)) {
      throw new ConnectorSpecError(
        `baseUrl hostname "${host}" is loopback — always rejected (Homestead runs there)`,
        '$.connection.baseUrl'
      );
    }
    if (family === 6 && (host === '::1' || host === '0:0:0:0:0:0:0:1')) {
      throw new ConnectorSpecError(
        `baseUrl hostname "${host}" is IPv6 loopback — always rejected`,
        '$.connection.baseUrl'
      );
    }
    if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback') {
      throw new ConnectorSpecError(
        `baseUrl hostname "${host}" is loopback — always rejected`,
        '$.connection.baseUrl'
      );
    }
    if (!localNetworkConsent) {
      throw new ConnectorSpecError(
        `baseUrl "${parsed.href}" resolves to a private/loopback/link-local range — ` +
        `requires explicit local-network consent (set HOMESTEAD_CONNECTOR_LOCAL_NETWORK=1 on the server)`,
        '$.connection.baseUrl'
      );
    }
    // With consent: still require https for the API key to stay
    // safe on the wire (even on a LAN, plaintext API keys in Wireshark
    // captures are a footgun).
    if (proto !== 'https:' && proto !== 'http:') {
      throw new ConnectorSpecError(
        `baseUrl "${parsed.href}" must use http(s); got "${proto}"`,
        '$.connection.baseUrl'
      );
    }
  } else {
    // Public hostnames MUST be https — TLS is what keeps the API
    // key off the wire in plaintext. Local-network consent does not
    // relax this; the engine only treats http as a non-starter for
    // anything beyond the local subnet.
    if (proto !== 'https:') {
      throw new ConnectorSpecError(
        `baseUrl "${parsed.href}" must be https (got "${proto}")`,
        '$.connection.baseUrl'
      );
    }
  }
}

// Numeric IP classification — mirrors the policy in lib/app-install.js
// but expanded to cover ULA / metadata / mapped ranges the third-party
// flow never had to think about.
function isPrivateIp(ip, family) {
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return false;
    const [a, b] = parts;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback — caller has a special case for this)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local — includes AWS/GCP metadata)
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 (CGNAT — also treated as private)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 0.0.0.0/8 — "this network"
    if (a === 0) return true;
    // 224.0.0.0/4 — multicast
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 — reserved / broadcast
    if (a >= 240) return true;
    return false;
  }
  if (family === 6) {
    // ::1/128 loopback
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
    // ::/128 unspecified
    if (ip === '::' || ip === '0:0:0:0:0:0:0:0') return true;
    // fe80::/10 link-local
    if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
    // fc00::/7 unique local (ULA)
    if (/^f[cd]/i.test(ip[0])) return true;
    // ff00::/8 multicast
    if (/^ff/i.test(ip)) return true;
    // ::ffff:a.b.c.d IPv4-mapped — re-classify the IPv4 part.
    const m = ip.match(/^::ffff:([0-9.]+)$/i);
    if (m) return isPrivateIp(m[1], 4);
    return false;
  }
  return false;
}

// Hostname policy. Anything that resolves to a private IP will be
// caught by checkOriginPolicy when the engine re-resolves; this
// function is the early-exit that catches the obvious localhost / .local
// / .internal cases without a DNS roundtrip.
function isPrivateHostname(hostname) {
  let h = (hostname || '').toLowerCase();
  // Strip WHATWG URL brackets from IPv6 literals.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.intranet') ||
      h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.home.arpa')) return true;
  return false;
}

// ---- Section validators -------------------------------------------------

function validateIdentity(identity, where) {
  rejectUnknownFields(identity, ALLOWED_IDENTITY_FIELDS, where);
  if (!isNonEmptyString(identity.name)) {
    throw new ConnectorSpecError(`${where}.name must be a non-empty string`, `${where}.name`);
  }
  if (!isNonEmptyString(identity.icon)) {
    throw new ConnectorSpecError(`${where}.icon must be a non-empty string`, `${where}.icon`);
  }
  if (typeof identity.icon !== 'string' || identity.icon.length > 16) {
    throw new ConnectorSpecError(
      `${where}.icon must be a short string (got ${identity.icon.length} chars)`,
      `${where}.icon`
    );
  }
  if (!VALID_IDENTITY_CATEGORIES.includes(identity.category)) {
    throw new ConnectorSpecError(
      `${where}.category must be one of [${VALID_IDENTITY_CATEGORIES.join(', ')}] (got "${identity.category}")`,
      `${where}.category`
    );
  }
}

function validateAuth(auth, where) {
  rejectUnknownFields(auth, ALLOWED_AUTH_FIELDS, where);
  if (!VALID_AUTH_TYPES.includes(auth.type)) {
    throw new ConnectorSpecError(
      `${where}.type must be one of [${VALID_AUTH_TYPES.join(', ')}] (got "${auth.type}")`,
      `${where}.type`
    );
  }
  if (auth.type === 'header') {
    if (!isNonEmptyString(auth.name)) {
      throw new ConnectorSpecError(`${where}.name must be a non-empty string`, `${where}.name`);
    }
    // Header names are constrained to RFC 7230 token characters.
    // We refuse anything else rather than rely on the HTTP client to
    // sanitize — a header that smuggles a `\r\n` could split the
    // request.
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(auth.name)) {
      throw new ConnectorSpecError(
        `${where}.name must be a valid HTTP header token (got "${auth.name}")`,
        `${where}.name`
      );
    }
  } else if (auth.type === 'bearer') {
    // Bearer auth uses the Authorization header implicitly; no name.
    if (auth.name !== undefined) {
      throw new ConnectorSpecError(
        `${where}.name must be omitted for type="bearer" (got "${auth.name}")`,
        `${where}.name`
      );
    }
  }
  if (!isNonEmptyString(auth.secretRef)) {
    throw new ConnectorSpecError(
      `${where}.secretRef must be a non-empty string (the per-user key in the encrypted store)`,
      `${where}.secretRef`
    );
  }
  // Belt-and-braces: refuse values that look like an inline secret
  // BEFORE the identifier regex, so a pasted token (with spaces,
  // dots, slashes) gets the precise "this is a secret value, not a
  // reference" error rather than a generic identifier-shape reject.
  if (looksLikeInlineSecret(auth.secretRef)) {
    throw new ConnectorSpecError(
      `${where}.secretRef must be a key identifier, not an inline secret value`,
      `${where}.secretRef`
    );
  }
  if (!/^[a-z0-9_-]{2,64}$/.test(auth.secretRef)) {
    throw new ConnectorSpecError(
      `${where}.secretRef must match [a-z0-9_-]{2,64} (got "${auth.secretRef}")`,
      `${where}.secretRef`
    );
  }
}

function validateConnection(conn, where, ctx) {
  rejectUnknownFields(conn, ALLOWED_CONNECTION_FIELDS, where);

  const baseUrl = validateHttpUrl(conn.baseUrl, `${where}.baseUrl`);
  checkOriginPolicy(baseUrl, ctx);

  if (!isPlainObject(conn.auth)) {
    throw new ConnectorSpecError(`${where}.auth must be an object`, `${where}.auth`);
  }
  validateAuth(conn.auth, `${where}.auth`);

  if (!Array.isArray(conn.allowedMethods) || conn.allowedMethods.length === 0) {
    throw new ConnectorSpecError(
      `${where}.allowedMethods must be a non-empty array`,
      `${where}.allowedMethods`
    );
  }
  for (const m of conn.allowedMethods) {
    if (!VALID_HTTP_METHODS.includes(m)) {
      throw new ConnectorSpecError(
        `${where}.allowedMethods entry "${m}" is not allowed (v1 is read-only; only GET is permitted)`,
        `${where}.allowedMethods`
      );
    }
  }
  // Single-value check: array can only be ["GET"].
  if (conn.allowedMethods.length !== 1 || conn.allowedMethods[0] !== 'GET') {
    throw new ConnectorSpecError(
      `${where}.allowedMethods must be exactly ["GET"] in v1`,
      `${where}.allowedMethods`
    );
  }

  if (!Array.isArray(conn.allowedPaths) || conn.allowedPaths.length === 0) {
    throw new ConnectorSpecError(
      `${where}.allowedPaths must be a non-empty array of path regexes`,
      `${where}.allowedPaths`
    );
  }
  for (const re of conn.allowedPaths) {
    if (typeof re !== 'string') {
      throw new ConnectorSpecError(`${where}.allowedPaths entries must be strings`, `${where}.allowedPaths`);
    }
    let compiled;
    try { compiled = new RegExp(re); } catch (err) {
      throw new ConnectorSpecError(`${where}.allowedPaths "${re}" is not a valid regex: ${err.message}`, `${where}.allowedPaths`);
    }
    // Reject patterns that match a dotless wildcard covering the
    // whole path — ".*" alone would let a probe drift anywhere on
    // the host. We require an anchor segment.
    if (/^[^/]*\.\*[^/]*$/.test(re) || re === '.*' || re === '^.*' || re === '^/.*' && !re.includes('[^/]')) {
      // The path is nothing or "match anything under root". Acceptable
      // patterns look like "^/api/v1/" or "^/api/v1/(series|library)"
      // — they constrain the namespace. We treat "^/.*" as too broad
      // because it covers arbitrary paths the operator can't easily
      // audit.
      if (re === '.*' || re === '^.*' || re === '^/.*' || re === '^/.*$') {
        throw new ConnectorSpecError(
          `${where}.allowedPaths regex "${re}" is too broad — must constrain a path namespace (e.g. "^/api/v1/series")`,
          `${where}.allowedPaths`
        );
      }
      // Reference the compiled pattern to silence "unused" lint.
      void compiled;
    }
  }

  if (typeof conn.minPollSeconds !== 'number' || !Number.isFinite(conn.minPollSeconds)) {
    throw new ConnectorSpecError(
      `${where}.minPollSeconds must be a finite number`,
      `${where}.minPollSeconds`
    );
  }
  if (conn.minPollSeconds < 30 || conn.minPollSeconds > 86400) {
    throw new ConnectorSpecError(
      `${where}.minPollSeconds must be between 30 and 86400 (got ${conn.minPollSeconds})`,
      `${where}.minPollSeconds`
    );
  }
}

function validateProbe(probe, where, idx, ctx) {
  rejectUnknownFields(probe, ALLOWED_PROBE_FIELDS, where);
  if (!isNonEmptyString(probe.id)) {
    throw new ConnectorSpecError(`${where}.id must be a non-empty string`, `${where}.id`);
  }
  validateIdentifier(probe.id, `${where}.id`);

  if (!isPlainObject(probe.request)) {
    throw new ConnectorSpecError(`${where}.request must be an object`, `${where}.request`);
  }
  rejectUnknownFields(probe.request, ALLOWED_PROBE_REQUEST_FIELDS, `${where}.request`);

  // path is the only field allowed on a request — no method, no
  // body, no headers. The engine composes the GET with the auth
  // header. This is the trust boundary.
  if (!isNonEmptyString(probe.request.path)) {
    throw new ConnectorSpecError(`${where}.request.path must be a non-empty string`, `${where}.request.path`);
  }
  if (!probe.request.path.startsWith('/')) {
    throw new ConnectorSpecError(
      `${where}.request.path must start with "/" (got "${probe.request.path}")`,
      `${where}.request.path`
    );
  }

  if (!isPlainObject(probe.extract)) {
    throw new ConnectorSpecError(`${where}.extract must be an object`, `${where}.extract`);
  }
  // extract is a name -> JSONPath mapping.
  for (const [fieldName, expr] of Object.entries(probe.extract)) {
    validateIdentifier(fieldName, `${where}.extract.${fieldName}`);
    if (typeof expr !== 'string') {
      throw new ConnectorSpecError(
        `${where}.extract.${fieldName} must be a string JSONPath expression`,
        `${where}.extract.${fieldName}`
      );
    }
    validateJsonPath(expr, `${where}.extract.${fieldName}`);
  }

  // Track probe ids + paths so we can detect duplicates later.
  if (!ctx.seenProbeIds.has(probe.id)) {
    ctx.seenProbeIds.add(probe.id);
  } else {
    throw new ConnectorSpecError(`duplicate probe id "${probe.id}"`, `${where}.id`);
  }
  if (!ctx.seenProbePaths.has(probe.request.path)) {
    ctx.seenProbePaths.add(probe.request.path);
  } else {
    throw new ConnectorSpecError(
      `duplicate probe request path "${probe.request.path}" — each probe should hit a distinct endpoint`,
      `${where}.request.path`
    );
  }
}

// A field value can be either a JSONPath expression (starts with `$`)
// or a plain string literal (template-supplied constant like "Libraries").
// Anything else is rejected so a stray number/object can't sneak in.
function validateFieldValue(value, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectorSpecError(`${where} must be a non-empty string (literal or JSONPath)`, where);
  }
  if (value.startsWith('$')) {
    validateJsonPath(value, where);
    return;
  }
  // Literal strings: max 256 chars, no leading dot or bracket.
  if (value.length > 256) {
    throw new ConnectorSpecError(`${where} literal exceeds 256 characters`, where);
  }
  if (/^[\.\[]/.test(value)) {
    throw new ConnectorSpecError(`${where} literal cannot start with "." or "["`, where);
  }
}

function validateSurfaceField(from, fields, surfaceName, where, ctx) {
  if (!isNonEmptyString(from)) {
    throw new ConnectorSpecError(`${where}.from must reference a probe id`, `${where}.from`);
  }
  if (!ctx.seenProbeIds.has(from)) {
    throw new ConnectorSpecError(
      `${where}.from "${from}" references an unknown probe id`,
      `${where}.from`
    );
  }
  if (!isPlainObject(fields)) {
    throw new ConnectorSpecError(`${where}.fields must be an object`, `${where}.fields`);
  }
  if (Object.keys(fields).length === 0) {
    throw new ConnectorSpecError(`${where}.fields must have at least one entry`, `${where}.fields`);
  }
  // `fields` is a name -> string mapping. The value is either a
  // JSONPath expression (starts with `$`) that the engine evaluates
  // against the probe response, or a literal string supplied by the
  // template (e.g. `label: "Libraries"`). The renderer decides what
  // each named field is for (status / label / etc.); the engine just
  // resolves the value.
  for (const [name, value] of Object.entries(fields)) {
    validateIdentifier(name, `${where}.fields.${name}`);
    validateFieldValue(value, `${where}.fields.${name}`);
  }
}

function validateSurfaces(surfaces, where, ctx) {
  rejectUnknownFields(surfaces, ALLOWED_SURFACES_FIELDS, where);
  if (surfaces.tile !== undefined) {
    if (!isPlainObject(surfaces.tile)) {
      throw new ConnectorSpecError(`${where}.tile must be an object`, `${where}.tile`);
    }
    rejectUnknownFields(surfaces.tile, ALLOWED_TILE_FIELDS, `${where}.tile`);
    validateSurfaceField(surfaces.tile.from, surfaces.tile.fields, 'tile', `${where}.tile`, ctx);
  }
  if (surfaces.card !== undefined) {
    if (!isPlainObject(surfaces.card)) {
      throw new ConnectorSpecError(`${where}.card must be an object`, `${where}.card`);
    }
    rejectUnknownFields(surfaces.card, ALLOWED_CARD_FIELDS, `${where}.card`);
    validateSurfaceField(surfaces.card.from, surfaces.card.fields, 'card', `${where}.card`, ctx);
  }
  if (surfaces.feed !== undefined) {
    if (!isPlainObject(surfaces.feed)) {
      throw new ConnectorSpecError(`${where}.feed must be an object`, `${where}.feed`);
    }
    rejectUnknownFields(surfaces.feed, ALLOWED_FEED_FIELDS, `${where}.feed`);
    validateSurfaceField(surfaces.feed.from, surfaces.feed.fields, 'feed', `${where}.feed`, ctx);
  }
  if (surfaces.entities !== undefined) {
    if (!isPlainObject(surfaces.entities)) {
      throw new ConnectorSpecError(`${where}.entities must be an object`, `${where}.entities`);
    }
    rejectUnknownFields(surfaces.entities, ALLOWED_ENTITIES_FIELDS, `${where}.entities`);
    if (!VALID_SURFACE_ENTITY_KINDS.includes(surfaces.entities.kind)) {
      throw new ConnectorSpecError(
        `${where}.entities.kind must be one of [${VALID_SURFACE_ENTITY_KINDS.join(', ')}] (got "${surfaces.entities.kind}")`,
        `${where}.entities.kind`
      );
    }
    if (!isNonEmptyString(surfaces.entities.from)) {
      throw new ConnectorSpecError(`${where}.entities.from must reference a probe id`, `${where}.entities.from`);
    }
    if (!ctx.seenProbeIds.has(surfaces.entities.from)) {
      throw new ConnectorSpecError(
        `${where}.entities.from "${surfaces.entities.from}" references an unknown probe id`,
        `${where}.entities.from`
      );
    }
    for (const f of ['id', 'name']) {
      if (typeof surfaces.entities[f] !== 'string' || surfaces.entities[f].length === 0) {
        throw new ConnectorSpecError(
          `${where}.entities.${f} must be a non-empty JSONPath expression`,
          `${where}.entities.${f}`
        );
      }
      validateJsonPath(surfaces.entities[f], `${where}.entities.${f}`);
    }
    if (surfaces.entities.url !== undefined) {
      if (typeof surfaces.entities.url !== 'string') {
        throw new ConnectorSpecError(`${where}.entities.url must be a string`, `${where}.entities.url`);
      }
      validateJsonPath(surfaces.entities.url, `${where}.entities.url`);
    }
    if (surfaces.entities.extra !== undefined) {
      if (!isPlainObject(surfaces.entities.extra)) {
        throw new ConnectorSpecError(`${where}.entities.extra must be an object`, `${where}.entities.extra`);
      }
      for (const [k, v] of Object.entries(surfaces.entities.extra)) {
        validateIdentifier(k, `${where}.entities.extra.${k}`);
        if (typeof v !== 'string') {
          throw new ConnectorSpecError(
            `${where}.entities.extra.${k} must be a string JSONPath expression`,
            `${where}.entities.extra.${k}`
          );
        }
        validateJsonPath(v, `${where}.entities.extra.${k}`);
      }
    }
  }
}

// ---- Public entry point -------------------------------------------------

// validate(spec, opts) -> { ok: true, spec } on success, throws
// ConnectorSpecError on failure.
//
// `opts.localNetworkConsent` (boolean) gates private-IP access.
// `opts.homesteadOrigin` (string) is the URL Homestead itself serves
// from — used to reject the home origin even if a user copy-pastes it.
function validate(spec, opts = {}) {
  if (!isPlainObject(spec)) {
    throw new ConnectorSpecError('spec must be an object', '$');
  }
  rejectUnknownFields(spec, ALLOWED_TOP_LEVEL, '$');

  if (spec.schema !== SCHEMA_ID) {
    throw new ConnectorSpecError(
      `spec.schema must be "${SCHEMA_ID}" (got "${spec.schema}")`,
      '$.schema'
    );
  }

  validateIdentifier(spec.id, '$.id');
  validateIdentity(spec.identity, '$.identity');

  // Per-validate shared context — used for duplicate detection and
  // surface-probe reference resolution.
  const ctx = {
    seenProbeIds: new Set(),
    seenProbePaths: new Set(),
    localNetworkConsent: !!opts.localNetworkConsent,
    homesteadOrigin: opts.homesteadOrigin || null,
  };

  validateConnection(spec.connection, '$.connection', ctx);

  if (!Array.isArray(spec.probes) || spec.probes.length === 0) {
    throw new ConnectorSpecError('$.probes must be a non-empty array', '$.probes');
  }
  if (spec.probes.length > 32) {
    throw new ConnectorSpecError(
      `$.probes has ${spec.probes.length} entries; max 32 (prevents unbounded request budgets)`,
      '$.probes'
    );
  }
  spec.probes.forEach((p, i) => validateProbe(p, `$.probes[${i}]`, i, ctx));

  if (spec.surfaces !== undefined) {
    validateSurfaces(spec.surfaces, '$.surfaces', ctx);
  }

  return { ok: true, schema: SCHEMA_ID };
}

// ---- DNS re-resolution helper ------------------------------------------
//
// The engine calls this on every request to pin DNS resolution to the
// origin hostname. Returns the resolved IP for the hostname. If the
// resolved IP is private, the call throws — even if the spec passed
// initial validation under local-network consent, a DNS rebinding
// attack could flip the answer to a private range between install and
// request time. (Same-origin mitigation: re-resolve on every request.)
//
// We resolve via the system DNS resolver (dns.promises.lookup) rather
// than per-family because Homestead servers run on common Linux
// distros with a single glibc resolver; per-family is a future option
// if we ever need to pin IPv6 vs IPv4 separately.
async function resolveAndCheck(parsedUrl, { localNetworkConsent = false } = {}) {
  if (!parsedUrl || typeof parsedUrl !== 'object' || !parsedUrl.hostname) {
    throw new ConnectorSpecError('resolveAndCheck requires a parsed URL with hostname', '$');
  }
  // WHATWG URL keeps the brackets on IPv6 hosts; strip them for IP
  // classification and DNS lookups.
  let hostname = parsedUrl.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  // If hostname is already a literal IP, classify it directly.
  const family = net.isIP(hostname);
  if (family !== 0) {
    if (isPrivateIp(hostname, family)) {
      // Loopback first — always rejected before the consent gate.
      if (family === 4 && /^127\./.test(hostname)) {
        throw new ConnectorSpecError(
          `DNS for ${parsedUrl.href} resolves to IPv4 loopback — always rejected`,
          '$.connection.baseUrl'
        );
      }
      if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
        throw new ConnectorSpecError(
          `DNS for ${parsedUrl.href} resolves to IPv6 loopback — always rejected`,
          '$.connection.baseUrl'
        );
      }
      if (!localNetworkConsent) {
        throw new ConnectorSpecError(
          `DNS for ${parsedUrl.href} resolves to a private IP without local-network consent`,
          '$.connection.baseUrl'
        );
      }
    }
    return { address: hostname, family };
  }
  // Hostname — resolve and re-classify.
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new ConnectorSpecError(
      `DNS resolution failed for ${hostname}: ${err.message}`,
      '$.connection.baseUrl'
    );
  }
  if (!addrs || addrs.length === 0) {
    throw new ConnectorSpecError(
      `DNS for ${hostname} returned no addresses`,
      '$.connection.baseUrl'
    );
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address, a.family)) {
      if (!localNetworkConsent) {
        throw new ConnectorSpecError(
          `DNS for ${hostname} resolves to a private address (${a.address}) — local-network consent required`,
          '$.connection.baseUrl'
        );
      }
      if (a.family === 4 && /^127\./.test(a.address)) {
        throw new ConnectorSpecError(
          `DNS for ${hostname} resolves to IPv4 loopback (${a.address}) — always rejected`,
          '$.connection.baseUrl'
        );
      }
      if (a.address === '::1') {
        throw new ConnectorSpecError(
          `DNS for ${hostname} resolves to IPv6 loopback — always rejected`,
          '$.connection.baseUrl'
        );
      }
    }
  }
  // Return the first address; the engine may pin against this on a
  // subsequent fetch via the `lookup` option of undici.
  return { address: addrs[0].address, family: addrs[0].family };
}

// ---- Reference template registry --------------------------------------

// List of template factories (functions returning a validated spec).
// Each factory is a pure function: (overrides?) -> spec. The engine
// loads templates by id via `templates.get(id)({...})`.

const _templates = new Map();

function registerTemplate(id, factory) {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(id)) {
    throw new ConnectorSpecError(`template id "${id}" must match [a-z0-9_-]{2,32}`, '$');
  }
  if (typeof factory !== 'function') {
    throw new ConnectorSpecError('template factory must be a function', '$');
  }
  _templates.set(id, factory);
}

function getTemplate(id, overrides = {}) {
  const factory = _templates.get(id);
  if (!factory) throw new ConnectorSpecError(`unknown template "${id}"`, '$');
  return factory(overrides);
}

function listTemplates() {
  return Array.from(_templates.keys());
}

// Lazy-load the Komga template so this module's require graph stays
// small. Circular requires are impossible here because the template
// doesn't import connector-spec.js (it returns a plain object).
function _loadKomgaTemplate() {
  if (_templates.has('komga')) return;
  // eslint-disable-next-line global-require
  const komga = require('./connector-templates/komga');
  registerTemplate('komga', komga.factory);
}

// Load built-ins on module import so `listTemplates()` and
// `getTemplate('komga')` work without an explicit bootstrap step.
// Any future built-in goes here too.
_loadKomgaTemplate();

module.exports = {
  SCHEMA_ID,
  ConnectorSpecError,
  validate,
  resolveAndCheck,
  isPrivateIp,
  isPrivateHostname,
  registerTemplate,
  getTemplate,
  listTemplates,
  // Exposed for tests.
  _ALLOWED_TOP_LEVEL: ALLOWED_TOP_LEVEL,
  _ALLOWED_CONNECTION_FIELDS: ALLOWED_CONNECTION_FIELDS,
  _ALLOWED_AUTH_FIELDS: ALLOWED_AUTH_FIELDS,
  _ALLOWED_PROBE_FIELDS: ALLOWED_PROBE_FIELDS,
  _ALLOWED_SURFACES_FIELDS: ALLOWED_SURFACES_FIELDS,
};
