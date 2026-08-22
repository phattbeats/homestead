#!/usr/bin/env node
// PHA-2201.2 (PHA-2230) acceptance tests for lib/scope-display.js.
//
// Pure logic, no DB, no server — drives the module directly. Covers
// the acceptance checklist from the issue:
//   * every scope in the PHA-2201 §3 vocabulary has a mapped phrase
//   * an unmapped scope throws rather than rendering raw
//
// Run: node scripts/test-scope-display.js

'use strict';

const scopeDisplay = require('../lib/scope-display');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertThrows(fn, label) {
  try {
    fn();
    ng(label, 'expected a throw, got none');
  } catch (_) {
    ok(label);
  }
}

console.log('PHA-2201.2 scope-display tests\n');

// ---- Test 1: every fixed §3 scope has a phrase, none render raw ----
{
  console.log('Test 1: fixed vocabulary is fully mapped');
  const FIXED_SCOPES = [
    'read:me', 'write:me',
    'read:walls', 'read:walls:media_club',
    'write:walls:post', 'write:walls:react', 'write:walls:moderate',
    'read:lists', 'write:lists',
    'read:tasks', 'write:tasks',
    'read:events', 'write:events',
    'read:event_series', 'write:event_series',
    'agent:invoke', 'agent:events:read', 'agent:events:subscribe',
  ];
  for (const scope of FIXED_SCOPES) {
    let phrase;
    assert(
      (() => { try { phrase = scopeDisplay.describeScope(scope); return true; } catch (e) { return false; } })(),
      `describeScope("${scope}") does not throw`
    );
    assert(typeof phrase === 'string' && phrase.length > 0, `"${scope}" maps to a non-empty phrase`);
    assert(phrase !== scope, `"${scope}" phrase is plain language, not the raw scope string`);
  }
  assert(
    FIXED_SCOPES.every((s) => scopeDisplay.SCOPE_VOCABULARY.includes(s)),
    'SCOPE_VOCABULARY exposes every fixed scope (exhaustiveness check target)'
  );
}

// ---- Test 2: dynamic read:walls:{wall_id} pattern ----
{
  console.log('\nTest 2: read:walls:{wall_id} dynamic pattern');
  const phrase = scopeDisplay.describeScope('read:walls:family');
  assert(phrase.includes('family'), 'wall_id scope phrase names the wall', phrase);
  assert(
    scopeDisplay.describeScope('read:walls:media_club') === 'Read posts on the media-club wall',
    'media_club stays on its own fixed phrase, not the generic wall_id one'
  );
}

// ---- Test 3: entity_kinds read/write pattern, scoped to declared kinds ----
{
  console.log('\nTest 3: entity_kinds read/write pattern');
  const ctx = { entityKinds: ['movie', 'vote'] };
  assert(
    scopeDisplay.describeScope('read:movies', ctx) === 'Read movies',
    'read:{plural(kind)} maps for a declared entity kind'
  );
  assert(
    scopeDisplay.describeScope('write:votes', ctx) === 'Create and edit votes',
    'write:{plural(kind)} maps for a declared entity kind'
  );
  assertThrows(
    () => scopeDisplay.describeScope('read:members', ctx),
    'an entity-shaped scope for an UNDECLARED kind throws (apps cannot escape entity_kinds[])'
  );
}

// ---- Test 4: unmapped / rejected scopes fail loudly ----
{
  console.log('\nTest 4: unmapped and rejected scopes throw');
  assertThrows(() => scopeDisplay.describeScope('read:frobnicate'), 'a made-up scope throws');
  assertThrows(() => scopeDisplay.describeScope('admin:*'), '"admin:*" (rejected in §3) throws');
  assertThrows(() => scopeDisplay.describeScope('read:audit_log'), '"read:audit_log" (rejected in §3) throws');
  assertThrows(() => scopeDisplay.describeScope('write:users'), '"write:users" (rejected in §3) throws');
  assertThrows(() => scopeDisplay.describeScope('read:secrets'), '"read:secrets" (rejected in §3) throws');
}

// ---- Test 5: describeScopes() batches phrases, collects all errors ----
{
  console.log('\nTest 5: describeScopes() batch mapping');
  const phrases = scopeDisplay.describeScopes(['read:me', 'write:walls:post']);
  assert(JSON.stringify(phrases) === JSON.stringify([
    'See your profile and which modules you have turned on',
    'Post to walls you belong to',
  ]), 'describeScopes maps an ordered list of valid scopes');

  let message = '';
  try {
    scopeDisplay.describeScopes(['read:me', 'read:bogus_one', 'read:bogus_two']);
  } catch (e) {
    message = e.message;
  }
  assert(message.includes('bogus_one') && message.includes('bogus_two'), 'describeScopes reports every bad scope in one error, not just the first');
}

// ---- Test 6: dual export shape (Node require path used by this test) ----
{
  console.log('\nTest 6: module export shape');
  assert(typeof scopeDisplay.describeScope === 'function', 'describeScope is exported');
  assert(typeof scopeDisplay.describeScopes === 'function', 'describeScopes is exported');
  assert(Array.isArray(scopeDisplay.SCOPE_VOCABULARY), 'SCOPE_VOCABULARY is exported as an array');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
