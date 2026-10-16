#!/usr/bin/env node
// Session-secret fail-closed check (lib/secret-box.js loadSessionSecret).
//
// Covers every refusal path and the one acceptance path. Each refusal must
// say how to generate a secret AND where to set it: a container that
// crash-loops on boot with only "placeholder" in the log leaves the
// operator guessing which knob to turn.

'use strict';

const assert = require('assert');
const secretBox = require('../lib/secret-box');

let pass = 0;
function check(name, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
}

function refusal(value) {
  const saved = process.env.SESSION_SECRET;
  if (value === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = value;
  try {
    secretBox.loadSessionSecret();
    return null;
  } catch (e) {
    return e.message;
  } finally {
    if (saved === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved;
  }
}

function assertActionable(msg, label) {
  assert.ok(msg, `${label}: expected a refusal`);
  assert.ok(msg.includes('openssl rand -hex 32'), `${label}: says how to generate one`);
  assert.ok(msg.includes('Unraid container template'), `${label}: says where to set it (Unraid)`);
  assert.ok(msg.includes('docker-compose.yml'), `${label}: says where to set it (compose)`);
  assert.ok(msg.includes('restart'), `${label}: says to restart`);
}

console.log('=== session secret: fail-closed refusals are actionable ===');

check('unset → "not set" + how + where', () => {
  const msg = refusal(undefined);
  assert.ok(/not set/.test(msg), 'names the problem');
  assertActionable(msg, 'unset');
});

check('empty string → "not set" + how + where', () => {
  const msg = refusal('');
  assert.ok(/not set/.test(msg), 'names the problem');
  assertActionable(msg, 'empty');
});

check('README placeholder → "known placeholder" + how + where', () => {
  const msg = refusal('life-app-secret-change-me');
  assert.ok(/known placeholder/.test(msg), 'names the problem');
  assertActionable(msg, 'placeholder');
});

check('every listed placeholder is refused', () => {
  for (const p of secretBox.SESSION_SECRET_PLACEHOLDERS) {
    assert.ok(refusal(p), `refuses "${p}"`);
  }
});

check('too short → length named + how + where', () => {
  const msg = refusal('x'.repeat(secretBox.SESSION_SECRET_MIN - 1));
  assert.ok(/too short/.test(msg), 'names the problem');
  assert.ok(msg.includes(String(secretBox.SESSION_SECRET_MIN)), 'names the minimum');
  assertActionable(msg, 'short');
});

check('a real 64-hex secret is accepted and returned unchanged', () => {
  const good = 'a1'.repeat(32);
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = good;
  try {
    assert.strictEqual(secretBox.loadSessionSecret(), good);
    assert.strictEqual(secretBox.sessionSecretReady(), true);
  } finally {
    if (saved === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved;
  }
});

console.log(`${pass} passed, 0 failed`);
