#!/usr/bin/env node
// PHA-2448 acceptance tests: shipped templates + wizard validation/preview.
'use strict';

const wizard = require('../lib/connector-wizard');
const templates = require('../lib/connector-templates');

let pass = 0; let fail = 0;
function check(ok, label) { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } }
function throws(fn, code, label) { try { fn(); check(false, label); } catch (e) { check(e.code === code || (e.message || '').includes(code), label); } }

console.log('PHA-2448 Connector Forge wizard tests');
for (const t of templates.listTemplates()) {
  const r = wizard.validate(t.id, { baseUrl: t.defaults.baseUrl, secretRef: t.defaults.secretRef, apiKey: 'test-key', installName: `My ${t.name}` });
  check(r.spec.schema === 'homestead.connector/v1', `${t.name} ships a versioned ConnectorSpec`);
  check(r.preview.endpoints.length > 0 && r.preview.surfaces.length > 0, `${t.name} produces a visible preview`);
}
throws(() => wizard.validate('komga', { baseUrl: 'http://127.0.0.1:25600', secretRef: 'komga_key', apiKey: 'x' }), 'loopback', 'loopback URL rejected before persistence');
throws(() => wizard.validate('komga', { baseUrl: 'http://192.168.1.5:25600', secretRef: 'komga_key', apiKey: 'x' }), 'private', 'RFC1918 URL rejected without local consent');
throws(() => wizard.validate('komga', { baseUrl: 'https://komga.example.com', secretRef: 'sk-live-this-is-not-a-reference', apiKey: 'x' }), 'invalid_secret_ref', 'inline secret cannot be used as a secret reference');
throws(() => wizard.validate('komga', { baseUrl: 'https://komga.example.com', secretRef: 'komga_key', apiKey: '' }), 'secret_missing', 'empty API key rejected before persistence');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
