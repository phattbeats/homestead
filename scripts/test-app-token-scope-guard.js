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
const { scopeForApiRoute, API_SCOPE_RULES } = require('../lib/scope-display');

let pass = 0;
let fail = 0;
function assert(condition, label, detail) {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function samplePath(template) {
  return template.replace(/:[A-Za-z0-9_]+/g, 'scope-test');
}

function authenticatedServerRoutes() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const re = /app\.(get|post|put|patch|delete)\(\s*['"](\/api\/[^'"]*)['"]\s*,\s*auth\b/g;
  const routes = [];
  let match;
  while ((match = re.exec(source))) routes.push({ method: match[1].toUpperCase(), path: samplePath(match[2]) });
  return routes;
}

function request(base, method, requestPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...base, method, path: requestPath,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
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
    const routes = authenticatedServerRoutes();
    assert(routes.length > 70, 'route walker found the authenticated server API inventory', String(routes.length));

    // Router routes are capability-registry entries too. Include them so the
    // regression test covers the lists domain even though it is mounted.
    for (const [method, template] of API_SCOPE_RULES) {
      const candidate = { method, path: samplePath(template) };
      if (!routes.some((r) => r.method === candidate.method && r.path === candidate.path)) routes.push(candidate);
    }

    for (const route of routes) {
      try {
        const status = await request(base, route.method, route.path, token);
        const required = scopeForApiRoute(route.method, route.path);
        const allowed = required === 'read:lists';
        assert(
          allowed ? status !== 403 : status === 403,
          `${route.method} ${route.path} ${allowed ? 'allows' : 'denies'} read:lists`,
          `status ${status}; registry requires ${required || 'no app scope (deny by default)'}`
        );
      } catch (err) {
        assert(false, `${route.method} ${route.path} route walk responded`, err.message);
      }
    }
  } catch (err) {
    assert(false, 'route walker completed', err.stack || err.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
