#!/usr/bin/env node
// PHA-2444 acceptance tests for the ConnectorSpec schema, validator,
// JSONPath parser, and Komga reference template.
//
// Acceptance criteria (from PHA-2444 issue body):
//   * Schema is versioned (homestead.connector/v1).
//   * Validator unit tests cover rejection cases:
//       - POST method
//       - request body
//       - foreign header
//       - loopback host
//       - RFC1918 without consent
//       - unsafe JSONPath
//       - inline secret
//   * Komga template validates against the schema and produces a
//     deterministic ConnectorSpec document.
//   * JSONPath parser (RFC 9535 grammar subset) lives in core, not
//     eval'd.
//
// We also exercise the helper surfaces (jsonpath parser, network
// policy classification, Komga template overrides) so a future
// regression is caught close to its source.

'use strict';

const path = require('path');

const jsonpath = require('../lib/jsonpath');
const spec = require('../lib/connector-spec');
const komgaTemplate = require('../lib/connector-templates/komga');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) {
  fail++;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    ok(label);
  } else {
    ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}
function assertThrows(fn, matcher, label) {
  let thrown = null;
  try { fn(); } catch (err) { thrown = err; }
  if (!thrown) { ng(label, 'expected to throw, did not'); return; }
  if (typeof matcher === 'function' && !matcher(thrown)) {
    ng(label, `threw but did not match: ${thrown.message}`);
    return;
  }
  if (matcher instanceof RegExp && !matcher.test(thrown.message)) {
    ng(label, `threw with wrong message: ${thrown.message}`);
    return;
  }
  if (typeof matcher === 'string' && !thrown.message.includes(matcher)) {
    ng(label, `threw with wrong message: ${thrown.message}`);
    return;
  }
  ok(label);
}
function assertDoesNotThrow(fn, label) {
  try { fn(); ok(label); }
  catch (err) { ng(label, `unexpected throw: ${err.message}`); }
}

// ---- Helpers ------------------------------------------------------------

function baseKomgaSpec() {
  return {
    schema: 'homestead.connector/v1',
    id: 'komga',
    identity: { name: 'Komga', icon: '📚', category: 'media' },
    connection: {
      baseUrl: 'https://komga.example.com',
      auth: { type: 'header', name: 'X-API-Key', secretRef: 'komga_api_key' },
      allowedMethods: ['GET'],
      allowedPaths: ['^/api/v1/'],
      minPollSeconds: 300,
    },
    probes: [
      {
        id: 'libraries',
        request: { path: '/api/v1/libraries' },
        extract: { count: '$.length', names: '$[*].name' },
      },
    ],
    surfaces: {
      tile: { from: 'libraries', fields: { path: '$.count' } },
    },
  };
}

function freshConnectivityOpt(overrides = {}) {
  return Object.assign({
    localNetworkConsent: false,
    homesteadOrigin: null,
  }, overrides);
}

console.log('PHA-2444 ConnectorSpec tests\n');

// ---- Schema versioning --------------------------------------------------

console.log('Test 1: schema id is homestead.connector/v1');
{
  assertEq(spec.SCHEMA_ID, 'homestead.connector/v1', 'SCHEMA_ID constant');
}

// ---- Happy path ---------------------------------------------------------

console.log('\nTest 2: minimal valid spec passes');
{
  const s = baseKomgaSpec();
  const r = spec.validate(s);
  assertEq(r.ok, true, 'validate returns ok=true');
  assertEq(r.schema, 'homestead.connector/v1', 'echoes schema id');
}

console.log('\nTest 3: Komga reference template validates as-is');
{
  const s = komgaTemplate.factory();
  const r = spec.validate(s);
  assertEq(r.ok, true, 'factory() output passes validation');
  assertEq(s.schema, 'homestead.connector/v1', 'komga spec has correct schema');
  assertEq(s.id, 'komga', 'komga spec has correct id');
  assertEq(s.identity.name, 'Komga', 'identity.name = Komga');
  assertEq(s.connection.auth.name, 'X-API-Key', 'uses X-API-Key header');
  assertEq(s.connection.auth.type, 'header', 'uses header auth');
  assertEq(s.connection.allowedMethods[0], 'GET', 'GET only');
  assertEq(s.connection.allowedPaths[0], '^/api/v1/', 'anchored to /api/v1/');
  assert(Array.isArray(s.probes) && s.probes.length === 4, '4 probes');
  // None of the probes should be the deprecated /api/v1/series/list endpoint.
  for (const p of s.probes) {
    assert(
      !p.request.path.startsWith('/api/v1/series/list'),
      `probe ${p.id} does not use deprecated /api/v1/series/list`
    );
  }
  // All four probes should anchor under /api/v1/.
  for (const p of s.probes) {
    assert(
      /^\/api\/v1\//.test(p.request.path),
      `probe ${p.id} is anchored under /api/v1/`
    );
  }
}

console.log('\nTest 4: Komga template is deterministic');
{
  const a = komgaTemplate.factory();
  const b = komgaTemplate.factory();
  assertEq(a, b, 'factory() returns structurally equal output across calls');
}

console.log('\nTest 5: Komga template honors overrides');
{
  const s = komgaTemplate.factory({ baseUrl: 'https://k.example.org', secretRef: 'k2' });
  assertEq(s.connection.baseUrl, 'https://k.example.org', 'baseUrl override applied');
  assertEq(s.connection.auth.secretRef, 'k2', 'secretRef override applied');
}

// ---- Rejection: schema/version -----------------------------------------

console.log('\nTest 6: missing or wrong schema is rejected');
{
  const s = baseKomgaSpec();
  delete s.schema;
  // Both messages are valid rejections; we accept either.
  assertThrows(
    () => spec.validate(s),
    /schema|must be "homestead\.connector\/v1"/,
    'missing schema rejected'
  );
}
{
  const s = baseKomgaSpec();
  s.schema = 'homestead.connector/v2';
  assertThrows(() => spec.validate(s), /schema must be "homestead\.connector\/v1"/, 'wrong schema rejected');
}

// ---- Rejection: unknown fields ------------------------------------------

console.log('\nTest 7: unrecognised top-level fields are rejected');
{
  const s = baseKomgaSpec();
  s.injectedScript = 'rm -rf /';
  assertThrows(() => spec.validate(s), /field "injectedScript" is not allowed/, 'unknown top-level field rejected');
}

console.log('\nTest 8: unrecognised connection fields are rejected');
{
  const s = baseKomgaSpec();
  s.connection.followRedirects = true;
  assertThrows(() => spec.validate(s), /field "followRedirects" is not allowed/, 'connection.followRedirects rejected');
}
{
  const s = baseKomgaSpec();
  s.connection.headers = { 'X-Custom': 'foo' };
  assertThrows(() => spec.validate(s), /field "headers" is not allowed/, 'connection.headers rejected');
}

console.log('\nTest 9: unrecognised probe fields are rejected');
{
  const s = baseKomgaSpec();
  s.probes[0].body = '{"x":1}';
  assertThrows(() => spec.validate(s), /field "body" is not allowed/, 'probe.body rejected');
}
{
  const s = baseKomgaSpec();
  s.probes[0].request.method = 'POST';
  assertThrows(() => spec.validate(s), /field "method" is not allowed/, 'probe.request.method rejected');
}
{
  const s = baseKomgaSpec();
  s.probes[0].request.headers = { 'X-Evil': 'foo' };
  assertThrows(() => spec.validate(s), /field "headers" is not allowed/, 'probe.request.headers rejected');
}

// ---- Rejection: methods / body -----------------------------------------

console.log('\nTest 10: POST in allowedMethods is rejected');
{
  const s = baseKomgaSpec();
  s.connection.allowedMethods = ['POST'];
  assertThrows(() => spec.validate(s), /"POST" is not allowed/, 'POST rejected');
}

console.log('\nTest 11: PUT in allowedMethods is rejected');
{
  const s = baseKomgaSpec();
  s.connection.allowedMethods = ['GET', 'PUT'];
  assertThrows(() => spec.validate(s), /"PUT" is not allowed/, 'PUT rejected');
}

console.log('\nTest 12: allowedMethods must be exactly ["GET"]');
{
  const s = baseKomgaSpec();
  s.connection.allowedMethods = ['GET', 'GET'];
  assertThrows(() => spec.validate(s), /must be exactly \["GET"\]/, 'duplicate GET rejected (defensive)');
}

// ---- Rejection: foreign headers ----------------------------------------

console.log('\nTest 13: non-allowlisted auth header names are rejected');
{
  const s = baseKomgaSpec();
  // A header that smuggles a CRLF or contains a space is not a valid
  // HTTP token character and should fail the token-character regex.
  s.connection.auth.name = 'X-Evil\r\n-Inject';
  assertThrows(() => spec.validate(s), /valid HTTP header token/, 'CRLF-in-header rejected');
  s.connection.auth.name = 'X Evil';
  assertThrows(() => spec.validate(s), /valid HTTP header token/, 'space-in-header rejected');
}

console.log('\nTest 14: bearer auth forbids an explicit name');
{
  const s = baseKomgaSpec();
  s.connection.auth = { type: 'bearer', name: 'X-Bogus', secretRef: 'k' };
  assertThrows(() => spec.validate(s), /name must be omitted for type="bearer"/, 'bearer with name rejected');
}

console.log('\nTest 15: invalid auth types rejected');
{
  const s = baseKomgaSpec();
  s.connection.auth = { type: 'basic', name: 'Authorization', secretRef: 'k' };
  assertThrows(() => spec.validate(s), /type must be one of \[header, bearer\]/, 'basic auth rejected');
}

// ---- Rejection: inline secrets -----------------------------------------

console.log('\nTest 16: inline secrets in secretRef are rejected');
{
  const s = baseKomgaSpec();
  // A 40-char hex string starting with no prefix — looks like a pasted token.
  s.connection.auth.secretRef = 'abcdef0123456789abcdef0123456789abcdef01';
  assertThrows(() => spec.validate(s), /not an inline secret value/, 'inline hex secret rejected');

  s.connection.auth.secretRef = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb';
  assertThrows(() => spec.validate(s), /not an inline secret value/, 'inline bearer token rejected');

  s.connection.auth.secretRef = 'sk-1234567890abcdef1234567890abcdef';
  assertThrows(() => spec.validate(s), /not an inline secret value/, 'inline sk- prefixed token rejected');
}

console.log('\nTest 17: well-formed secretRef passes');
{
  const s = baseKomgaSpec();
  s.connection.auth.secretRef = 'komga_api_key_brandon';
  assertDoesNotThrow(() => spec.validate(s), 'good secretRef passes');
}

// ---- Rejection: loopback / private network ------------------------------

console.log('\nTest 18: 127.0.0.1 baseUrl is rejected (loopback)');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://127.0.0.1:8080';
  assertThrows(() => spec.validate(s), /loopback — always rejected/, 'IPv4 loopback rejected');
}

console.log('\nTest 19: localhost baseUrl is rejected');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://localhost:8080';
  assertThrows(() => spec.validate(s), /loopback/, 'localhost rejected');
}

console.log('\nTest 20: ::1 baseUrl is rejected');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://[::1]:8080';
  assertThrows(() => spec.validate(s), /loopback/, 'IPv6 loopback rejected');
}

console.log('\nTest 21: RFC1918 (10.x) baseUrl rejected without consent');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://10.0.0.5:8080';
  assertThrows(() => spec.validate(s), /local-network consent/, '10.0.0.0/8 rejected without consent');
}

console.log('\nTest 22: RFC1918 (192.168.x) baseUrl rejected without consent');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://192.168.1.10';
  assertThrows(() => spec.validate(s), /local-network consent/, '192.168.0.0/16 rejected without consent');
}

console.log('\nTest 23: RFC1918 (172.16.x) baseUrl rejected without consent');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://172.16.5.5';
  assertThrows(() => spec.validate(s), /local-network consent/, '172.16.0.0/12 rejected without consent');
}

console.log('\nTest 24: CGNAT (100.64.x) baseUrl rejected without consent');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://100.64.1.1';
  assertThrows(() => spec.validate(s), /local-network consent/, '100.64.0.0/10 rejected without consent');
}

console.log('\nTest 25: cloud metadata hostname is always rejected');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://metadata.google.internal';
  assertThrows(() => spec.validate(s), /cloud-metadata/, 'metadata.google.internal rejected');
}

console.log('\nTest 26: AWS metadata IP literal is always rejected');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://169.254.169.254/latest/meta-data';
  assertThrows(() => spec.validate(s), /always rejected|cloud-metadata/, '169.254.169.254 rejected');
}

console.log('\nTest 27: RFC1918 with consent passes (loopback still rejected)');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://10.0.0.5:8080';
  assertDoesNotThrow(
    () => spec.validate(s, freshConnectivityOpt({ localNetworkConsent: true })),
    '10.0.0.5 passes with local-network consent'
  );
}

console.log('\nTest 28: loopback rejected even with consent');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://127.0.0.1:8080';
  assertThrows(
    () => spec.validate(s, freshConnectivityOpt({ localNetworkConsent: true })),
    /loopback/,
    'loopback still rejected even with consent'
  );
}

console.log('\nTest 29: Homestead origin is always rejected');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'https://life.phatt.vip';
  assertThrows(
    () => spec.validate(s, freshConnectivityOpt({ homesteadOrigin: 'https://life.phatt.vip' })),
    /Homestead's own origin/,
    'Homestead origin rejected'
  );
}

console.log('\nTest 30: public baseUrl must be https');
{
  const s = baseKomgaSpec();
  s.connection.baseUrl = 'http://komga.example.com';
  assertThrows(() => spec.validate(s), /must be https/, 'plain http to public host rejected');
}

// ---- Rejection: unsafe JSONPath ----------------------------------------

console.log('\nTest 31: descendant operator ".." is rejected');
{
  const s = baseKomgaSpec();
  s.probes[0].extract.all = '$..items';
  assertThrows(() => spec.validate(s), /descendant/, 'descendant operator rejected');
}

console.log('\nTest 32: filter expressions "[?(...)]" are rejected');
{
  const s = baseKomgaSpec();
  s.probes[0].extract.filtered = '$.items[?(@.x>1)]';
  assertThrows(() => spec.validate(s), /filter expressions/, 'filter expressions rejected');
}

console.log('\nTest 33: slice with explicit step is rejected');
{
  const s = baseKomgaSpec();
  s.probes[0].extract.sliced = '$.items[0:10:2]';
  assertThrows(() => spec.validate(s), /slices with explicit step/, 'slice step rejected');
}

console.log('\nTest 34: bracket-name must be a JSON string');
{
  const s = baseKomgaSpec();
  // Bracket-name with unterminated string.
  s.probes[0].extract.bad = "$['unterminated";
  assertThrows(() => spec.validate(s), /JSONPath/, 'unterminated bracketed name rejected');
}

console.log('\nTest 35: leading zero in integer selector is rejected');
{
  const s = baseKomgaSpec();
  s.probes[0].extract.bad = '$.items[007]';
  assertThrows(() => spec.validate(s), /JSONPath|leading zero/, 'leading-zero integer rejected');
}

console.log('\nTest 36: wildcard at root is rejected');
{
  const s = baseKomgaSpec();
  s.probes[0].extract.bad = '$[*]';
  assertThrows(() => spec.validate(s), /JSONPath/, 'wildcard at root rejected');
}

// ---- Duplicate detection ----------------------------------------------

console.log('\nTest 37: duplicate probe ids rejected');
{
  const s = baseKomgaSpec();
  s.probes.push({
    id: 'libraries',
    request: { path: '/api/v1/libraries/2' },
    extract: { name_field: '$.length' },
  });
  assertThrows(() => spec.validate(s), /duplicate probe id/, 'duplicate probe id rejected');
}

console.log('\nTest 38: duplicate probe request paths rejected');
{
  const s = baseKomgaSpec();
  s.probes.push({
    id: 'libraries_two',
    request: { path: '/api/v1/libraries' },
    extract: { name_field: '$.length' },
  });
  assertThrows(() => spec.validate(s), /duplicate probe request path/, 'duplicate probe path rejected');
}

console.log('\nTest 39: surface references unknown probe');
{
  const s = baseKomgaSpec();
  s.surfaces.tile.from = 'unknownProbe';
  assertThrows(() => spec.validate(s), /unknown probe id/, 'unknown probe ref rejected');
}

// ---- minPollSeconds / allowedPaths guard rails ------------------------

console.log('\nTest 40: minPollSeconds below 30 rejected');
{
  const s = baseKomgaSpec();
  s.connection.minPollSeconds = 5;
  assertThrows(() => spec.validate(s), /between 30 and 86400/, 'too-small poll interval rejected');
}

console.log('\nTest 41: minPollSeconds above 86400 rejected');
{
  const s = baseKomgaSpec();
  s.connection.minPollSeconds = 100000;
  assertThrows(() => spec.validate(s), /between 30 and 86400/, 'too-large poll interval rejected');
}

console.log('\nTest 42: overscoped allowedPaths regex rejected');
{
  const s = baseKomgaSpec();
  s.connection.allowedPaths = ['.*'];
  assertThrows(() => spec.validate(s), /too broad/, 'catch-all allowedPaths rejected');
}

console.log('\nTest 43: probes empty / over-limit');
{
  const s = baseKomgaSpec();
  s.probes = [];
  assertThrows(() => spec.validate(s), /non-empty array/, 'empty probes rejected');

  s.probes = [];
  for (let i = 0; i < 33; i++) {
    s.probes.push({
      id: 'p' + i,
      request: { path: '/api/v1/x' + i },
      extract: { name_field: '$.length' },
    });
  }
  assertThrows(() => spec.validate(s), /max 32/, 'too-many probes rejected');
}

// ---- Identity field checks ---------------------------------------------

console.log('\nTest 44: bad identity.category rejected');
{
  const s = baseKomgaSpec();
  s.identity.category = 'malware';
  assertThrows(() => spec.validate(s), /category must be one of/, 'unknown category rejected');
}

console.log('\nTest 45: bad entity kind rejected');
{
  const s = baseKomgaSpec();
  s.surfaces.entities = {
    kind: 'evil_kind',
    from: 'libraries',
    id: '$.id',
    name: '$.name',
  };
  assertThrows(() => spec.validate(s), /kind must be one of/, 'unknown entity kind rejected');
}

// ---- JSONPath parser direct tests --------------------------------------

console.log('\nTest 46: JSONPath parser — supported subset');
{
  assertEq(jsonpath.parse('$').length, 0, '$ has 0 segments (root only)');
  assertEq(jsonpath.parse('$.a.b').length, 2, '$.a.b has 2 name segments');
  assertEq(jsonpath.parse('$.a[0].b').length, 3, '$.a[0].b has 3 segments');
  assertEq(jsonpath.parse('$[*].name').length, 2, '$[*].name has wildcard + name');
  assertEq(jsonpath.parse('$.items[0:10]').length, 2, '$.items[0:10] has name + slice');
  assertEq(jsonpath.parse('$.items[:5]').length, 2, '$.items[:5] has name + slice');
  assertEq(jsonpath.parse("$['name with space']").length, 1, "bracket-name parses to 1 segment");
  assertEq(jsonpath.parse('$.a[0].b[*]').length, 4, 'name + index + name + wildcard = 4');
}

console.log('\nTest 47: JSONPath parser — rejected subset');
{
  for (const bad of [
    '$.a..b',          // descendant
    '$.a[?(@.x>1)]',   // filter
    '$.a[0:10:2]',     // slice step
    '$.a[0,1,2]',      // union (out of scope)
    '$[*]',            // wildcard at root (alone)
    '$.a[(-1)]',       // negative index
  ]) {
    assertThrows(() => jsonpath.parse(bad), /JSONPath|parse error|filter expressions|union expressions/, `rejected: ${bad}`);
  }
}

console.log('\nTest 48: JSONPath parser — escape sequences');
{
  // \uXXXX escape in a bracketed name.
  const segs = jsonpath.parse("$['caf\\u00e9']");
  assertEq(segs[0].value, 'café', '\\uXXXX decoded');

  // Bad \u escape should throw.
  assertThrows(() => jsonpath.parse("$['\\uXYZW']"), /JSONPath|parse error|bad \\u escape/, 'bad \\u escape rejected');

  // Unterminated string.
  assertThrows(() => jsonpath.parse("$['unterminated"), /JSONPath|parse error|unterminated/, 'unterminated string rejected');
}

console.log('\nTest 49: JSONPath evaluator — single match');
{
  const data = { name: 'Sandy', counts: { series: 12 }, nested: { deep: { value: 42 } } };
  assertEq(jsonpath.query('$.name', data), 'Sandy', '$.name');
  assertEq(jsonpath.query('$.counts.series', data), 12, '$.counts.series');
  assertEq(jsonpath.query('$.nested.deep.value', data), 42, 'three-level deep');
  assertEq(jsonpath.query('$.missing', data), undefined, 'missing returns undefined');
}

console.log('\nTest 50: JSONPath evaluator — wildcard');
{
  const data = { content: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] };
  const names = jsonpath.queryAll('$.content[*].name', data);
  assertEq(names, ['a', 'b'], '$[*].name returns array');
  const ids = jsonpath.queryAll('$.content[*].id', data);
  assertEq(ids, [1, 2], '$[*].id returns array');
}

console.log('\nTest 51: JSONPath evaluator — slice');
{
  const data = { items: [10, 20, 30, 40, 50] };
  assertEq(jsonpath.queryAll('$.items[1:4]', data), [20, 30, 40], '[1:4] inclusive start, exclusive end');
  assertEq(jsonpath.queryAll('$.items[:3]', data), [10, 20, 30], '[:3] slices from start');
  assertEq(jsonpath.queryAll('$.items[2:]', data), [30, 40, 50], '[2:] slices to end');
}

console.log('\nTest 52: JSONPath evaluator — no eval');
{
  // Make sure no path string can run arbitrary code. We try a path
  // that LOOKS like code injection; it must throw.
  const sneaky = "$.a; require('fs');";
  assertThrows(() => jsonpath.parse(sneaky), /JSONPath|parse error|unexpected/, 'injection rejected by parser');
}

// ---- DNS resolveAndCheck helper ---------------------------------------

console.log('\nTest 53: resolveAndCheck rejects literal private IP without consent');
(async () => {
  try {
    await spec.resolveAndCheck(new URL('https://10.0.0.5/api'), {});
    ng('literal RFC1918 IP rejected without consent', 'did not throw');
  } catch (err) {
    if (/private|loopback/i.test(err.message)) ok('literal RFC1918 IP rejected without consent');
    else ng('literal RFC1918 IP rejected without consent', err.message);
  }
})();

console.log('\nTest 54: resolveAndCheck rejects literal loopback');
(async () => {
  try {
    await spec.resolveAndCheck(new URL('http://127.0.0.1/'));
    ng('literal 127.0.0.1 rejected', 'did not throw');
  } catch (err) {
    if (/loopback/i.test(err.message)) ok('literal 127.0.0.1 rejected');
    else ng('literal 127.0.0.1 rejected', err.message);
  }
})();

// ---- Template registry --------------------------------------------------

console.log('\nTest 55: template registry has komga');
{
  const list = spec.listTemplates();
  assert(list.includes('komga'), 'komga is registered');
  const s = spec.getTemplate('komga');
  assertEq(s.id, 'komga', 'getTemplate("komga") returns the right spec');
  spec.validate(s); // Should not throw.
  ok('getTemplate("komga") produces a valid spec');
}

console.log('\nTest 56: template registry rejects unknown ids');
{
  assertThrows(() => spec.getTemplate('nope'), /unknown template/, 'unknown template id rejected');
}

// ---- Final report -------------------------------------------------------

(async () => {
  // Give the async DNS tests a moment to settle.
  await new Promise(r => setTimeout(r, 100));
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('test harness threw:', err);
  process.exit(2);
});
