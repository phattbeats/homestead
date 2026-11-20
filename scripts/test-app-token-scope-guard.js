#!/usr/bin/env node
// A scoped app token is an allowlist, not a reduced-strength user session.
// This test derives every directly registered, authenticated /api route from
// server.js and proves a read:lists token gets past only its read capability.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const agentTokens = require('../lib/agent-tokens');
const { scopesForApiRoute, API_SCOPE_RULES, SCOPE_VOCABULARY } = require('../lib/scope-display');

let pass = 0;
let fail = 0;
function assert(condition, label, detail) {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function samplePath(template) {
  return template.replace(/:[A-Za-z0-9_]+/g, 'scope-test');
}

// Walk the live Express router — direct app routes AND every mounted router
// (lists, forum, shoutbox, agent-hub, agent-connections, ...) — and keep the
// /api routes whose handler chain runs authenticate(). Express 5 does not keep
// a mount path string on router layers, so each layer's matcher is probed
// against the prefixes server.js passes to app.use().
function authenticatedServerRoutes(app) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const prefixes = new Set(['']);
  for (const m of source.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"]/g)) prefixes.add(m[1].replace(/\/$/, ''));
  const byLength = [...prefixes].sort((a, b) => b.length - a.length);
  const routes = [];
  function collect(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        const runsAuth = layer.route.stack.some((l) => l.name === 'authenticate');
        const full = prefix + layer.route.path;
        if (!runsAuth || !full.startsWith('/api/')) continue;
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          routes.push({ method: method.toUpperCase(), path: samplePath(full) });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const match = layer.matchers && layer.matchers[0];
        const mount = byLength.find((p) => { if (p === '') return true; const hit = match && match(p); return !!hit && hit.path === p; }) || '';
        collect(layer.handle.stack, prefix + mount);
      }
    }
  }
  collect((app.router || app._router).stack, '');
  const seen = new Set();
  return routes.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function request(base, method, requestPath, token) {
  return requestFull(base, method, requestPath, token).then((r) => r.status);
}

function requestFull(base, method, requestPath, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...base, method, path: requestPath,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extraHeaders },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, setCookie: res.headers['set-cookie'] || null }));
    });
    req.on('error', reject);
    if (['POST', 'PUT', 'PATCH'].includes(method)) req.end('{}');
    else req.end();
  });
}

(async () => {
  console.log('app-token scope guard tests\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-app-scope-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const brandon = app.db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const token = agentTokens.issue(app.db, brandon.id, {
    label: 'read-lists route walker', scopes: JSON.stringify(['read:lists']),
  }).token_plaintext;
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = { hostname: '127.0.0.1', port: server.address().port };
    const routes = authenticatedServerRoutes(app);
    assert(routes.length > 150, 'route walker found the authenticated server API inventory', String(routes.length));

    // Every registry rule names a real authenticated route (no stale or
    // misspelled entry silently granting nothing) and a consentable scope.
    for (const [method, template, scope] of API_SCOPE_RULES) {
      const candidate = { method, path: samplePath(template) };
      assert(routes.some((r) => r.method === candidate.method && r.path === candidate.path),
        `registry rule ${method} ${template} matches a live authenticated route`);
      for (const s of [].concat(scope)) {
        const concrete = s.replace(/\{\w+\}/g, 'media_club');
        assert(SCOPE_VOCABULARY.includes(concrete), `registry scope ${s} is in the consent vocabulary`);
      }
    }

    for (const route of routes) {
      try {
        const status = await request(base, route.method, route.path, token);
        const accepted = scopesForApiRoute(route.method, route.path);
        const required = accepted && accepted.join(' | ');
        const allowed = !!accepted && accepted.includes('read:lists');
        assert(
          allowed ? status !== 403 : status === 403,
          `${route.method} ${route.path} ${allowed ? 'allows' : 'denies'} read:lists`,
          `status ${status}; registry requires ${required || 'no app scope (deny by default)'}`
        );
      } catch (err) {
        assert(false, `${route.method} ${route.path} route walk responded`, err.message);
      }
    }

    // Scope shapes beyond the single-scope route walk.
    const issueToken = (scopes) => agentTokens.issue(app.db, brandon.id, {
      label: `scope probe ${scopes}`, scopes,
    }).token_plaintext;
    const mediaClub = issueToken(JSON.stringify(['read:walls:media_club']));
    assert(await request(base, 'GET', '/api/walls/media-club/posts', mediaClub) !== 403,
      'read:walls:media_club reaches the media-club wall');
    assert(await request(base, 'GET', '/api/walls/household/posts', mediaClub) === 403,
      'read:walls:media_club does not reach another wall');
    assert(await request(base, 'GET', '/api/walls', mediaClub) === 403,
      'read:walls:media_club does not list every wall');
    const wallsReader = issueToken(JSON.stringify(['read:walls']));
    assert(await request(base, 'GET', '/api/forum/index', wallsReader) !== 403,
      'read:walls reaches the forum index (forum is a view over the walls)');
    assert(await request(base, 'GET', '/api/walls/household/posts', wallsReader) !== 403,
      'read:walls reaches any wall');
    assert(await request(base, 'HEAD', '/api/lists', token) !== 403, 'HEAD follows the GET rule');
    assert(await request(base, 'GET', '/api/lists/', token) !== 403, 'trailing slash follows the rule');
    assert(await request(base, 'GET', '/API/LISTS', token) !== 403, 'path case follows Express routing');
    const denied = await requestFull(base, 'GET', '/api/agent-tokens', token);
    assert(denied.status === 403 && JSON.parse(denied.body).error === 'insufficient_scope',
      'unregistered route answers insufficient_scope');
    const garbled = issueToken('not-json');
    assert(await request(base, 'GET', '/api/lists', garbled) === 403,
      'a token whose scopes are not a JSON array gets nothing, not full access');
    // A token request must not mint a session: replaying that cookie
    // without the Bearer would skip this guard and outlive revocation.
    const minted = await requestFull(base, 'GET', '/api/lists', token);
    assert(minted.status === 200 && !minted.setCookie, 'an app-token request sets no session cookie',
      String(minted.setCookie));
    const userPat = issueToken('user');
    const userMinted = await requestFull(base, 'GET', '/api/agent-tokens', userPat);
    assert(!userMinted.setCookie, 'a user PAT request sets no session cookie', String(userMinted.setCookie));
    assert(await request(base, 'GET', '/api/agent-tokens', userPat) === 200,
      "legacy 'user' PAT keeps full access");
  } catch (err) {
    assert(false, 'route walker completed', err.stack || err.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
