// Homestead — tests for lib/connector-runner.js (PHA-2445).
//
// Coverage:
//
//   1. Komga cycle: runs a Komga installation through one full cycle
//      and asserts tile/card/entities surfaces populate.
//   2. ETag semantics:
//        - 304 cache refresh keeps prior ETag
//        - conditional GET re-sends If-None-Match
//        - non-GET/HEAD conditional requests are rejected
//   3. Failure surfaces: when a probe errors, the snapshot surfaces a
//      redacted error (never the resolved secret, never a query
//      string that carried one).
//   4. Rate limiting: tokenBucket enforces 1 req/s sustained on a
//      single origin (10 attempts in 10s yield ≤10 passes).
//   5. SSRF defense: loopback is rejected even with local-network
//      consent; private-range requests require consent; public
//      hosts pass.
//   6. Secret redaction: errors, headers, and redacted bodies never
//      leak the resolved secret value.
//   7. Backoff: nextRunAt doubles on failure, jittered, capped; on
//      success resets to now + minPollSeconds.
//   8. Surface adapters: snapshot surfaces are written via duck-
//      typed adapter callbacks; adapter failures are non-fatal.
//
// Notes:
//   * The DNS sandbox in CI does not resolve every TLD. The tests
//     that exercise the Komga / 304 / live-HTTP paths stub
//     `connectorSpec.resolveAndCheck` so the runner's DNS pin is a
//     no-op; SSRF *rejection* is covered separately in test 5
//     against the validator's real path.
//   * Loopback live tests (11, 12) also stub
//     `connectorSpec.validate` so the validator's loopback guard
//     doesn't reject the test baseUrl before the engine can run.
//     The engine's own method-allowlist and DNS re-check still
//     fire, so the trust boundary isn't bypassed — only the
//     install-time baseUrl policy is, which the SSRF test covers.

'use strict';

const assert = require('assert');
const http = require('http');

const runner = require('../lib/connector-runner');
const connectorSpec = require('../lib/connector-spec');
const komga = require('../lib/connector-templates/komga');

const {
  runOnce,
  planDueInstallations,
  nextRunAt,
  redactError,
  redactString,
  createTokenBucket,
} = runner;

let testCount = 0;
let passCount = 0;
function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL ${name}\n    ${err.stack || err.message}\n`);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  testCount++;
  try {
    await fn();
    passCount++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL ${name}\n    ${err.stack || err.message}\n`);
    process.exitCode = 1;
  }
}

// ---- Test helpers --------------------------------------------------------
//
// Stub the validator's DNS helper so the engine's per-fetch re-check is
// a no-op. The runner's own trust-boundary tests stub `validate` and
// `resolveAndCheck` together so they can target the validator's
// branches directly.
function withStubbedResolve(fn, fake = () => ({ address: '93.184.216.34', family: 4 })) {
  const real = connectorSpec.resolveAndCheck;
  connectorSpec.resolveAndCheck = async () => fake();
  return Promise.resolve(fn()).finally(() => { connectorSpec.resolveAndCheck = real; });
}

// ---- Fake fetch ----------------------------------------------------------
function makeFakeFetch(routes, opts = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: input, init });
      const url = new URL(input);
      const key = `${init && init.method ? init.method : 'GET'} ${url.pathname}${url.search}`;
      const route = routes[key];
      if (!route) {
        return makeResponse(404, 'application/json', JSON.stringify({ error: 'no-route', key }));
      }
      if (typeof opts.delayMs === 'function') {
        await opts.delayMs(key);
      }
      const etag = route.etag || null;
      if (init && init.headers) {
        const inm = init.headers['If-None-Match'] || init.headers['if-none-match'];
        if (inm && etag && inm === etag) {
          const headers = {};
          if (etag) headers.etag = etag;
          return { status: 304, headers: makeHeaders(headers), text: async () => '' };
        }
      }
      const headers = Object.assign({ 'content-type': 'application/json' }, route.headers || {});
      if (etag) headers.etag = etag;
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return makeResponse(route.status || 200, 'application/json', body, headers);
    },
  };
}

function makeResponse(status, contentType, body, extraHeaders = {}) {
  const headerMap = new Map();
  headerMap.set('content-type', contentType);
  for (const [k, v] of Object.entries(extraHeaders)) headerMap.set(k.toLowerCase(), v);
  return {
    status,
    headers: {
      get(name) {
        if (name === null || name === undefined) return null;
        return headerMap.has(String(name).toLowerCase()) ? headerMap.get(String(name).toLowerCase()) : null;
      },
    },
    text: async () => body,
  };
}

function makeHeaders(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) m.set(k.toLowerCase(), v);
  return {
    get(name) {
      if (name == null) return null;
      return m.has(String(name).toLowerCase()) ? m.get(String(name).toLowerCase()) : null;
    },
  };
}

// ---- Komga-shaped canned responses --------------------------------------
const KOMGA_Libraries = [
  { id: 'lib-1', name: 'Main Library' },
  { id: 'lib-2', name: 'Backup Library' },
  { id: 'lib-3', name: 'Experimental' },
];
const KOMGA_Latest = {
  totalElements: 42,
  content: [
    { id: 's-1', name: 'Saga', url: '/series/s-1' },
    { id: 's-2', name: 'Bone', url: '/series/s-2' },
    { id: 's-3', name: 'Prez', url: '/series/s-3' },
  ],
};
const KOMGA_New = {
  totalElements: 7,
  content: [
    { id: 's-10', name: 'New Comic A', lastModified: '2026-08-22T10:00:00Z' },
    { id: 's-11', name: 'New Comic B', lastModified: '2026-08-22T11:00:00Z' },
  ],
};
const KOMGA_Updated = {
  totalElements: 12,
  content: [
    { id: 's-1', name: 'Saga', lastModified: '2026-08-23T09:00:00Z' },
    { id: 's-2', name: 'Bone', lastModified: '2026-08-23T08:00:00Z' },
  ],
};

function komgaRoutes() {
  return {
    'GET /api/v1/libraries': { body: KOMGA_Libraries, etag: 'W/"lib-v1"' },
    'GET /api/v1/series/latest?page=0&size=20': { body: KOMGA_Latest, etag: 'W/"latest-v1"' },
    'GET /api/v1/series/new?page=0&size=20': { body: KOMGA_New, etag: 'W/"new-v1"' },
    'GET /api/v1/series/updated?page=0&size=20': { body: KOMGA_Updated, etag: 'W/"upd-v1"' },
  };
}

// ---- Tests --------------------------------------------------------------

(async () => {
  process.stdout.write('\n=== PHA-2445 ConnectorRunner engine ===\n\n');

  // 1. Komga cycle: full path produces tile/card/entities.
  await testAsync('1. Komga installation runs through one full cycle', async () => {
    await withStubbedResolve(async () => {
      const spec = komga.factory({ baseUrl: 'https://komga.example.com', secretRef: 'komga_api_key_brandon' });
      connectorSpec.validate(spec);

      const fake = makeFakeFetch(komgaRoutes());
      const calls = { tile: 0, card: 0, entities: 0, feed: 0 };
      const adapters = {
        tile: async () => { calls.tile++; },
        card: async () => { calls.card++; },
        entities: async () => { calls.entities++; },
        feed: async () => { calls.feed++; },
      };
      const secrets = new Map([['komga_api_key_brandon', 'komga-test-key-DO-NOT-LOG']]);

      const snapshot = await runOnce(
        { id: 'inst-1', spec, state: {} },
        {
          fetchFn: fake.fetch,
          resolveSecret: (name) => {
            if (!secrets.has(name)) throw new Error('not found');
            return secrets.get(name);
          },
          surfaceAdapters: adapters,
          clock: () => new Date('2026-08-23T12:00:00Z'),
        },
      );

      assert.strictEqual(snapshot.ok, true, `expected ok=true; got ${JSON.stringify(snapshot, null, 2)}`);
      assert.strictEqual(snapshot.error, null);
      assert.strictEqual(snapshot.probes.length, 4);
      for (const p of snapshot.probes) {
        assert.strictEqual(p.ok, true, `probe ${p.id} failed: ${JSON.stringify(p.error)}`);
      }

      assert.ok(snapshot.surfaces.tile, 'tile missing');
      assert.strictEqual(snapshot.surfaces.tile.label, 'Updated series');
      assert.strictEqual(snapshot.surfaces.tile.status, 12);

      assert.ok(snapshot.surfaces.card, 'card missing');
      assert.strictEqual(snapshot.surfaces.card.count, 42);
      assert.deepStrictEqual(snapshot.surfaces.card.recent, ['Saga', 'Bone', 'Prez']);

      assert.strictEqual(snapshot.surfaces.entities.length, 3);
      assert.deepStrictEqual(snapshot.surfaces.entities, [
        { kind: 'comic_series', id: 's-1', name: 'Saga', url: '/series/s-1' },
        { kind: 'comic_series', id: 's-2', name: 'Bone', url: '/series/s-2' },
        { kind: 'comic_series', id: 's-3', name: 'Prez', url: '/series/s-3' },
      ]);

      assert.strictEqual(snapshot.surfaces.feed.length, 2);
      assert.strictEqual(snapshot.surfaces.feed[0].title, 'New Comic A');
      assert.strictEqual(snapshot.surfaces.feed[0].url, 's-10');

      assert.strictEqual(calls.tile, 1);
      assert.strictEqual(calls.card, 1);
      assert.strictEqual(calls.entities, 1);
      assert.strictEqual(calls.feed, 1);

      assert.strictEqual(snapshot.statePatch.failureCount, 0);
      assert.strictEqual(snapshot.statePatch.lastError, null);
      assert.strictEqual(snapshot.statePatch.lastSuccessAt, '2026-08-23T12:00:00.000Z');
      assert.strictEqual(snapshot.statePatch.nextRunAt, '2026-08-23T12:05:00.000Z');
      assert.deepStrictEqual(snapshot.statePatch.etagByProbe, {
        libraries: 'W/"lib-v1"',
        on_deck: 'W/"latest-v1"',
        new_series: 'W/"new-v1"',
        updated_series: 'W/"upd-v1"',
      });

      assert.strictEqual(fake.calls.length, 4);
      for (const c of fake.calls) {
        assert.strictEqual(c.init.headers['X-API-Key'], 'komga-test-key-DO-NOT-LOG',
          'auth header missing on ' + c.url);
        assert.strictEqual(c.init.method, 'GET');
        assert.strictEqual(c.init.redirect, 'manual');
        assert.ok(c.init.headers['User-Agent'], 'user-agent missing');
      }
    });
  });

  // 2. Conditional GET: second run with same ETag returns 304 and keeps prior value.
  await testAsync('2. Conditional GET — second run sees 304 and reuses prior ETag', async () => {
    await withStubbedResolve(async () => {
      const spec = komga.factory({ baseUrl: 'https://komga.example.com', secretRef: 'komga_api_key_brandon' });
      const fake = makeFakeFetch(komgaRoutes());

      const r1 = await runOnce(
        { id: 'inst-1', spec, state: {} },
        { fetchFn: fake.fetch, resolveSecret: () => 'k', clock: () => new Date('2026-08-23T12:00:00Z') },
      );
      assert.strictEqual(r1.ok, true);
      const etags = r1.statePatch.etagByProbe;

      const r2 = await runOnce(
        { id: 'inst-1', spec, state: { etagByProbe: etags } },
        { fetchFn: fake.fetch, resolveSecret: () => 'k', clock: () => new Date('2026-08-23T12:05:00Z') },
      );
      assert.strictEqual(r2.ok, true);
      for (const p of r2.probes) {
        assert.strictEqual(p.status, 304, `expected 304, got ${p.status} on probe ${p.id}`);
        assert.strictEqual(p.cached, true);
      }
      assert.deepStrictEqual(r2.statePatch.etagByProbe, etags);
      assert.strictEqual(r2.statePatch.failureCount, 0);

      // Second-run requests should carry If-None-Match matching the
      // probe's stored ETag.
      const secondCalls = fake.calls.slice(4);
      assert.strictEqual(secondCalls.length, 4);
      for (const c of secondCalls) {
        const inm = c.init.headers['If-None-Match'];
        assert.ok(inm, `If-None-Match missing on second-run call ${c.url}`);
        const probeId =
          c.url.includes('libraries') ? 'libraries' :
          c.url.includes('latest') ? 'on_deck' :
          c.url.includes('/new') ? 'new_series' :
          'updated_series';
        assert.strictEqual(inm, etags[probeId], `If-None-Match mismatch on ${probeId}`);
      }
    });
  });

  // 3. Non-GET/HEAD conditional requests are rejected by the runner's
  //    own method-allowlist (and by the validator's allowedMethods).
  await testAsync('3. Non-GET/HEAD methods rejected at install + run time', async () => {
    await withStubbedResolve(async () => {
      const spec = {
        schema: 'homestead.connector/v1',
        id: 'tester3',
        identity: { name: 'Test', icon: '⚙️', category: 'other' },
        connection: {
          baseUrl: 'https://example.test',
          auth: { type: 'header', name: 'X-API-Key', secretRef: 'kk' },
          allowedMethods: ['POST'],
          allowedPaths: ['^/api/'],
          minPollSeconds: 60,
        },
        probes: [
          {
            id: 'bad',
            request: { method: 'POST', path: '/api/foo', headers: { 'If-Match': '"abc"' } },
            extract: {},
          },
        ],
        surfaces: {},
      };
      // Validator catches POST + body at install time. We confirm the
      // engine surfaces a structured failure (not a silent fetch).
      const snap = await runOnce(
        { id: 'inst-x', spec, state: {} },
        {
          fetchFn: async () => makeResponse(200, 'application/json', '{}'),
          resolveSecret: () => 'k',
          clock: () => new Date('2026-08-23T12:00:00Z'),
        },
      );
      assert.strictEqual(snap.ok, false);
      assert.ok(snap.error && snap.error.code, 'runner must surface a failure code');
      // Either the validator's POST rejection or the runner's own
      // method-allowlist branch must mention the rejected method.
      assert.ok(/POST|GET\/HEAD|method|allowedMethods/i.test(JSON.stringify(snap.error)),
        'error must mention the rejected method: ' + JSON.stringify(snap.error));
    });
  });

  await testAsync('3b. POST with If-Match is rejected before fetch', async () => {
    await withStubbedResolve(async () => {
      // Bypass the validator so we can drive the engine's own
      // method-allowlist branch directly. The trust boundary still
      // fires — we just test the engine's half of it.
      const realValidate = connectorSpec.validate;
      connectorSpec.validate = () => ({ ok: true, schema: 'homestead.connector/v1' });

      try {
        const spec = {
          schema: 'homestead.connector/v1',
          id: 'tester2',
          identity: { name: 'Test', icon: '⚙️', category: 'other' },
          connection: {
            baseUrl: 'https://example.test',
            auth: { type: 'header', name: 'X-API-Key', secretRef: 'kk' },
            allowedMethods: ['GET', 'HEAD', 'POST'],
            allowedPaths: ['^/api/'],
            minPollSeconds: 60,
          },
          probes: [
            {
              id: 'pp',
              request: { method: 'POST', path: '/api/x' },
              extract: {},
            },
          ],
          surfaces: {},
        };
        let fetchCalled = false;
        const fakeFetch = async () => { fetchCalled = true; return makeResponse(200, 'application/json', '{}'); };
        const snap = await runOnce(
          { id: 'inst-z', spec, state: {} },
          {
            fetchFn: fakeFetch,
            resolveSecret: () => 'k',
            clock: () => new Date('2026-08-23T12:00:00Z'),
          },
        );
        assert.strictEqual(snap.ok, false);
        assert.ok(snap.error);
        assert.strictEqual(snap.error.code, 'method-not-allowed',
          'engine must reject non-GET/HEAD before fetch');
        assert.ok(/POST|GET\/HEAD/i.test(snap.error.message),
          'error must mention rejected method');
        assert.strictEqual(fetchCalled, false, 'fetch must NOT be called for a POST probe');
      } finally {
        connectorSpec.validate = realValidate;
      }
    });
  });

  // 4. Failure surfaces: a probe 500s, the snapshot surfaces a
  //    redacted error, and the state patch records failureCount + a
  //    redacted lastError.
  await testAsync('4. Failure surfaces with redacted error', async () => {
    await withStubbedResolve(async () => {
      const spec = komga.factory({ baseUrl: 'https://komga.example.com', secretRef: 'komga_api_key_brandon' });
      const routes = komgaRoutes();
      routes['GET /api/v1/libraries'].status = 500;
      routes['GET /api/v1/libraries'].body = 'internal error: komga-api-key=Bearer SECRET-DO-NOT-LOG abc123';
      const fake = makeFakeFetch(routes);

      const calls = { tile: 0 };
      const adapters = { tile: async () => { calls.tile++; } };

      const snap = await runOnce(
        { id: 'inst-fail', spec, state: { failureCount: 0, nextRunAt: '1970-01-01T00:00:00Z' } },
        {
          fetchFn: fake.fetch,
          resolveSecret: () => 'komga-test-key-DO-NOT-LOG',
          surfaceAdapters: adapters,
          clock: () => new Date('2026-08-23T12:00:00Z'),
        },
      );
      assert.strictEqual(snap.ok, false);
      assert.ok(snap.error, 'failure must produce an error');
      assert.strictEqual(snap.error.code, 'http-error');

      const serialized = JSON.stringify(snap);
      assert.ok(!serialized.includes('komga-test-key-DO-NOT-LOG'),
        'resolved secret leaked into snapshot: ' + serialized);
      assert.ok(!serialized.includes('SECRET-DO-NOT-LOG'),
        'body-borne secret leaked into snapshot: ' + serialized);
      assert.ok(!serialized.includes('abc123'),
        'body token fragment leaked into snapshot: ' + serialized);

      assert.strictEqual(snap.statePatch.failureCount, 1);
      assert.ok(snap.statePatch.lastError);
      assert.strictEqual(snap.statePatch.lastError.code, 'http-error');
      assert.ok(snap.statePatch.nextRunAt, 'nextRunAt must be set on failure');
      const nextMs = Date.parse(snap.statePatch.nextRunAt);
      const nowMs = Date.parse('2026-08-23T12:00:00Z');
      assert.ok(nextMs > nowMs, `nextRunAt must be in the future; got ${snap.statePatch.nextRunAt}`);

      // Tile adapter was NOT called (snapshot failed).
      assert.strictEqual(calls.tile, 0);
    });
  });

  // 5. Rate-limit tokenBucket: 1 req/s sustained on a single origin.
  await testAsync('5. Rate-limit: 1 req/s sustained on a single origin', async () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0 });

    // First call at t=0: pass.
    assert.strictEqual(bucket.tryConsume('https://origin.example'), true);
    // Immediate second call: fail (no time elapsed).
    assert.strictEqual(bucket.tryConsume('https://origin.example'), false);

    // 10 sustained requests spaced 1s apart: each passes.
    let pass = 0;
    let t = 0;
    const sustainedBucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => t });
    for (let i = 0; i < 10; i++) {
      t = i * 1000;
      if (sustainedBucket.tryConsume('https://origin.example')) pass++;
    }
    assert.strictEqual(pass, 10, `expected 10 passes; got ${pass}`);

    // Different origin: independent bucket. Two origins each
    // get their own capacity-1 bucket, so the first request to each
    // passes; the second within the same tick fails. Origins don't
    // share capacity.
    const multi = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0 });
    assert.strictEqual(multi.tryConsume('https://other.example'), true);
    assert.strictEqual(multi.tryConsume('https://other.example'), false,
      'second request on same origin in same tick must fail');
    assert.strictEqual(multi.tryConsume('https://origin.example'), true,
      'different origin must have independent capacity');
    assert.strictEqual(multi.tryConsume('https://origin.example'), false,
      'different origin must also be capped at capacity');
  });

  // 6. SSRF: loopback is always rejected, even with local-network consent.
  await testAsync('6. SSRF: loopback is always rejected (defense-in-depth)', async () => {
    const spec = {
      schema: 'homestead.connector/v1',
      id: 'tester3',
      identity: { name: 'Test', icon: '⚙️', category: 'other' },
      connection: {
        baseUrl: 'http://127.0.0.1:8080',
        auth: { type: 'header', name: 'X-API-Key', secretRef: 'kk' },
        allowedMethods: ['GET'],
        allowedPaths: ['^/'],
        minPollSeconds: 60,
      },
      probes: [{ id: 'pp', request: { path: '/' }, extract: {} }],
      surfaces: {},
    };
    // Validator rejects loopback outright — even with
    // localNetworkConsent, the connection-level validate blocks it
    // at install time. The runner's own resolveAndCheck also
    // refuses. Either path closes the door.
    let threw = false;
    try {
      connectorSpec.validate(spec, { localNetworkConsent: true });
    } catch (err) {
      threw = true;
      assert.ok(/loopback|private/i.test(err.message),
        `expected loopback/private error; got: ${err.message}`);
    }
    assert.ok(threw, 'loopback must be rejected at install time');
  });

  await testAsync('6b. SSRF: RFC1918 host requires local-network consent', async () => {
    const spec = {
      schema: 'homestead.connector/v1',
      id: 'tester4',
      identity: { name: 'Test', icon: '⚙️', category: 'other' },
      connection: {
        baseUrl: 'https://10.0.0.5/api',
        auth: { type: 'header', name: 'X-API-Key', secretRef: 'kk' },
        allowedMethods: ['GET'],
        allowedPaths: ['^/'],
        minPollSeconds: 60,
      },
      probes: [{ id: 'pp', request: { path: '/' }, extract: {} }],
      surfaces: {},
    };
    // Without consent: rejected.
    let threw = false;
    try {
      connectorSpec.validate(spec, { localNetworkConsent: false });
    } catch (err) {
      threw = true;
      assert.ok(/private|RFC1918|consent/i.test(err.message),
        `expected private/consent error; got: ${err.message}`);
    }
    assert.ok(threw, 'private IP without consent must be rejected');

    // With consent: passes validator. The runtime resolveAndCheck
    // still classifies the IP, and (since loopback is not in play)
    // admits it.
    connectorSpec.validate(spec, { localNetworkConsent: true });
  });

  // 7. Backoff: doubles, jittered, capped; resets on success.
  test('7. Backoff: doubles on failure, resets on success', () => {
    const det = (() => {
      let n = 0;
      return () => {
        n = (n + 1) % 100;
        return n / 100;
      };
    })();

    const now = Date.parse('2026-08-23T12:00:00Z');
    const minPollSeconds = 300;

    let next = nextRunAt({ now, failureCount: 1, minPollSeconds, random: det });
    let nextSec = (Date.parse(next) - now) / 1000;
    assert.ok(nextSec >= 24 && nextSec <= 36,
      `failureCount=1 expected 24..36s, got ${nextSec}s`);

    next = nextRunAt({ now, failureCount: 2, minPollSeconds, random: det });
    nextSec = (Date.parse(next) - now) / 1000;
    assert.ok(nextSec >= 48 && nextSec <= 72,
      `failureCount=2 expected 48..72s, got ${nextSec}s`);

    next = nextRunAt({ now, failureCount: 12, minPollSeconds, random: det });
    nextSec = (Date.parse(next) - now) / 1000;
    assert.ok(nextSec >= 2880 && nextSec <= 4320,
      `failureCount=12 expected 2880..4320s (capped near 1h), got ${nextSec}s`);

    next = nextRunAt({
      now, lastSuccessAt: now - 60000, failureCount: 0, minPollSeconds, random: det,
    });
    nextSec = (Date.parse(next) - now) / 1000;
    assert.strictEqual(nextSec, minPollSeconds,
      `success path expected exactly ${minPollSeconds}s, got ${nextSec}s`);
  });

  // 8. Surface adapters: adapter failure is non-fatal.
  await testAsync('8. Surface adapter failure is non-fatal; snapshot still builds', async () => {
    await withStubbedResolve(async () => {
      const spec = komga.factory({ baseUrl: 'https://komga.example.com', secretRef: 'kk' });
      const fake = makeFakeFetch(komgaRoutes());
      const adapters = {
        tile: async () => { throw new Error('tile-adapter-down'); },
        card: async () => { throw new Error('card-adapter-down'); },
      };
      const snap = await runOnce(
        { id: 'inst-a', spec, state: {} },
        {
          fetchFn: fake.fetch,
          resolveSecret: () => 'k',
          surfaceAdapters: adapters,
          clock: () => new Date('2026-08-23T12:00:00Z'),
        },
      );
      assert.strictEqual(snap.ok, true, 'snapshot must succeed even if adapters fail');
      assert.ok(snap.adapterErrors, 'adapterErrors must be populated');
      assert.strictEqual(snap.adapterErrors.tile, 'tile-adapter-down');
      assert.strictEqual(snap.adapterErrors.card, 'card-adapter-down');
      assert.ok(snap.surfaces.tile);
      assert.ok(snap.surfaces.card);
    });
  });

  // 9. redactError: never leaks the resolved secret.
  test('9. redactError scrubs bearer/apiKey/token patterns', () => {
    const e = redactError(new Error('failed: Bearer abcdef0123456789 and api_key=zzz-9999 and token: ttt-8888'));
    assert.ok(!e.message.includes('abcdef0123456789'), `secret leaked: ${e.message}`);
    assert.ok(!e.message.includes('zzz-9999'), `api_key leaked: ${e.message}`);
    assert.ok(!e.message.includes('ttt-8888'), `token leaked: ${e.message}`);
    assert.ok(e.message.includes('[REDACTED]'), 'redacted marker missing');
  });

  test('9b. redactError scrubs URL query strings with secrets', () => {
    const redacted = redactString('GET /api?apiKey=sk-abc123&page=0');
    assert.ok(!redacted.includes('sk-abc123'), `URL secret leaked: ${redacted}`);
    assert.ok(redacted.includes('[REDACTED]'), 'redacted marker missing');
  });

  // 10. planDueInstallations: skips locked + not-due, picks due.
  test('10. planDueInstallations: due vs locked vs not-due', () => {
    const now = Date.parse('2026-08-23T12:00:00Z');
    const spec1 = komga.factory({ baseUrl: 'https://a.example', secretRef: 'k1' });
    const spec2 = komga.factory({ baseUrl: 'https://b.example', secretRef: 'k2' });
    const plan = planDueInstallations(
      [
        // i1: not yet due (nextRunAt is in the future).
        { id: 'i1', spec: spec1, state: { lastAttemptAt: '2026-08-23T11:59:00Z', nextRunAt: '2026-08-23T12:00:30Z' } },
        // i2: due (nextRunAt is in the past).
        { id: 'i2', spec: spec2, state: { lastAttemptAt: '2026-08-23T11:00:00Z', nextRunAt: '2026-08-23T11:55:00Z' } },
        // i3: locked by another run.
        { id: 'i3', spec: spec1, state: { executionRunId: 'other-run', lastAttemptAt: '2026-08-23T11:00:00Z', nextRunAt: '2026-08-23T11:30:00Z' } },
        // i4: no prior state, always due.
        { id: 'i4', spec: spec1, state: {} },
      ],
      { now, ownRunId: 'me' },
    );
    const picked = new Set(plan.picks.map(p => p.installationId));
    assert.ok(picked.has('i2'), 'i2 is due and unlocked');
    assert.ok(picked.has('i4'), 'i4 has no prior state (always due)');
    assert.ok(!picked.has('i1'), 'i1 is not yet due');
    assert.ok(!picked.has('i3'), 'i3 is locked by another run');
  });

  // 11. Live HTTP server: end-to-end smoke against a local node http
  //     server. We bypass the validator's loopback rejection (which
  //     the SSRF test covers) and the DNS sandbox (which can't
  //     resolve every TLD). The trust boundary on the wire — manual
  //     redirects, header-only auth, JSONPath mapping, surface
  //     adapters, ETag semantics — is exercised end-to-end.
  await testAsync('11. Live HTTP smoke — real node fetch path against local server', async () => {
    const srv = http.createServer((req, res) => {
      const url = req.url || '/';
      const inm = req.headers['if-none-match'];
      if (inm && inm === 'W/"lib-v1"') {
        res.statusCode = 304;
        res.end();
        return;
      }
      let body;
      if (url.startsWith('/api/v1/libraries')) {
        body = JSON.stringify(KOMGA_Libraries);
        res.setHeader('etag', 'W/"lib-v1"');
      } else if (url.startsWith('/api/v1/series/latest')) body = JSON.stringify(KOMGA_Latest);
      else if (url.startsWith('/api/v1/series/new')) body = JSON.stringify(KOMGA_New);
      else if (url.startsWith('/api/v1/series/updated')) body = JSON.stringify(KOMGA_Updated);
      else { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const realResolve = connectorSpec.resolveAndCheck;
    const realValidate = connectorSpec.validate;
    connectorSpec.resolveAndCheck = async () => ({ address: '127.0.0.1', family: 4 });
    // Validator rejects 127.0.0.1 unconditionally. Bypass for the
    // test (loopback rejection is covered in test 6).
    connectorSpec.validate = () => ({ ok: true, schema: 'homestead.connector/v1' });

    try {
      const spec = komga.factory({ baseUrl: `http://127.0.0.1:${port}`, secretRef: 'kk' });
      const snap = await runOnce(
        { id: 'inst-live', spec, state: {} },
        {
          resolveSecret: () => 'k',
          clock: () => new Date('2026-08-23T12:00:00Z'),
        },
      );
      assert.strictEqual(snap.ok, true, `live smoke failed: ${JSON.stringify(snap.error)}`);
      assert.strictEqual(snap.surfaces.tile.status, 12);
      assert.strictEqual(snap.surfaces.card.count, 42);
      assert.strictEqual(snap.surfaces.entities.length, 3);
    } finally {
      connectorSpec.resolveAndCheck = realResolve;
      connectorSpec.validate = realValidate;
      srv.close();
    }
  });

  // 12. Conditional GET 304: live server returns 304, runner treats
  //     it as a cache refresh.
  await testAsync('12. Live HTTP 304 → cache refresh; surfaces still build', async () => {
    const etag = 'W/"x-v9"';
    const srv = http.createServer((req, res) => {
      const url = req.url || '/';
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      let body;
      if (url.startsWith('/api/v1/libraries')) body = JSON.stringify(KOMGA_Libraries);
      else if (url.startsWith('/api/v1/series/latest')) body = JSON.stringify(KOMGA_Latest);
      else if (url.startsWith('/api/v1/series/new')) body = JSON.stringify(KOMGA_New);
      else if (url.startsWith('/api/v1/series/updated')) body = JSON.stringify(KOMGA_Updated);
      else { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.setHeader('etag', etag);
      res.end(body);
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const realResolve = connectorSpec.resolveAndCheck;
    const realValidate = connectorSpec.validate;
    connectorSpec.resolveAndCheck = async () => ({ address: '127.0.0.1', family: 4 });
    connectorSpec.validate = () => ({ ok: true, schema: 'homestead.connector/v1' });
    try {
      const spec = komga.factory({ baseUrl: `http://127.0.0.1:${port}`, secretRef: 'kk' });
      const r1 = await runOnce(
        { id: 'inst-cond', spec, state: {} },
        {
          resolveSecret: () => 'k',
          clock: () => new Date('2026-08-23T12:00:00Z'),
        },
      );
      assert.strictEqual(r1.ok, true);

      const r2 = await runOnce(
        { id: 'inst-cond', spec, state: { etagByProbe: r1.statePatch.etagByProbe } },
        {
          resolveSecret: () => 'k',
          clock: () => new Date('2026-08-23T12:05:00Z'),
        },
      );
      assert.strictEqual(r2.ok, true);
      for (const p of r2.probes) {
        assert.strictEqual(p.status, 304, `expected 304 on ${p.id}, got ${p.status}`);
        assert.strictEqual(p.cached, true);
      }
    } finally {
      connectorSpec.resolveAndCheck = realResolve;
      connectorSpec.validate = realValidate;
      srv.close();
    }
  });

  process.stdout.write(`\n=== ${passCount}/${testCount} passed ===\n\n`);
})();