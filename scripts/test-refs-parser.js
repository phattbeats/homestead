#!/usr/bin/env node
// PHA-1877 (PHA-1624 Phase D) — reference parser unit tests.
//
// Style follows the existing test-* scripts: plain node assert harness,
// no test framework. Exercises every branch of lib/refs/parser.js —
// scanForReferences, parseReference, renderRefsInText — plus the HTML
// escape helpers. The resolver tests live in test-refs-resolver.js.

'use strict';

const assert = require('assert');
const parser = require('../lib/refs/parser');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-1877 reference parser tests\n');

// ---- Test 1: scanForReferences basic ----
console.log('Test 1: scanForReferences finds [[Name]] patterns');
{
  const r = parser.scanForReferences('Reading [[Dune]] tonight', 'task');
  assertEq(r.refs.length, 1, 'one ref');
  assertEq(r.refs[0].name, 'Dune', 'name=Dune');
  assertEq(r.refs[0].position, 8, 'position=8');
  assertEq(r.refs[0].length, 8, 'length=8 (incl. brackets)');
}

// ---- Test 2: scanForReferences multiple refs ----
console.log('\nTest 2: scanForReferences emits in document order');
{
  const r = parser.scanForReferences('[[Dune]] and [[Frank Herbert]]', 'event');
  assertEq(r.refs.length, 2, 'two refs');
  assertEq(r.refs[0].name, 'Dune', 'first is Dune');
  assertEq(r.refs[1].name, 'Frank Herbert', 'second is Frank Herbert');
}

// ---- Test 3: scanForReferences empty/whitespace ----
console.log('\nTest 3: scanForReferences ignores empty refs');
{
  const r1 = parser.scanForReferences('[[]]', 'task');
  assertEq(r1.refs.length, 0, 'empty [[]] → no refs');
  const r2 = parser.scanForReferences('[[   ]]', 'task');
  assertEq(r2.refs.length, 0, 'whitespace-only → no refs');
  const r3 = parser.scanForReferences('', 'task');
  assertEq(r3.refs.length, 0, 'empty string → no refs');
  const r4 = parser.scanForReferences(null, 'task');
  assertEq(r4.refs.length, 0, 'null text → no refs');
}

// ---- Test 4: scanForReferences ignores single brackets ----
console.log('\nTest 4: scanForReferences does NOT match single-bracket refs');
{
  const r = parser.scanForReferences('[Dune] (single brackets)', 'task');
  assertEq(r.refs.length, 0, '[Dune] → no refs');
}

// ---- Test 5: scanForReferences whitespace collapsing ----
console.log('\nTest 5: scanForReferences collapses internal whitespace');
{
  const r = parser.scanForReferences('[[  Frank   Herbert  ]]', 'task');
  assertEq(r.refs.length, 1, 'one ref');
  assertEq(r.refs[0].name, 'Frank Herbert', 'whitespace collapsed');
}

// ---- Test 6: scanForReferences unterminated ----
console.log('\nTest 6: scanForReferences tolerates unterminated [[');
{
  const r = parser.scanForReferences('half-opened [[Dune and then never closed', 'task');
  assertEq(r.refs.length, 0, 'unterminated → no refs');
}

// ---- Test 7: scanForReferences mixed valid + invalid ----
console.log('\nTest 7: scanForReferences handles mixed valid + invalid');
{
  const r = parser.scanForReferences('See [[Dune]] and [arrakis] but not [[unfinished', 'task');
  assertEq(r.refs.length, 1, 'one valid ref');
  assertEq(r.refs[0].name, 'Dune', 'the valid one');
}

// ---- Test 8: scanForReferences escape sequence ----
console.log('\nTest 8: scanForReferences handles \\] escape inside ref');
{
  const r = parser.scanForReferences('[[Foo \\] Bar]]', 'task');
  assertEq(r.refs.length, 1, 'one ref');
  assertEq(r.refs[0].name, 'Foo ] Bar', 'escape decoded');
}

// ---- Test 9: parseReference basic ----
console.log('\nTest 9: parseReference');
{
  const p = parser.parseReference('Dune', 'task');
  assertEq(p && p.name, 'Dune', 'name=Dune');
  assertEq(p && p.containerKind, 'task', 'containerKind=task');
  const bad = parser.parseReference('   ', 'task');
  assertEq(bad, null, 'whitespace → null');
  const long = parser.parseReference('a'.repeat(201), 'task');
  assertEq(long, null, '>200 chars → null');
  // Newlines collapse with whitespace (handled by `\s+` collapse above), so
  // they don't make a ref unusable. NUL / SOH / other control chars DO.
  const ctrl = parser.parseReference('Foo\x00Bar', 'task');
  assertEq(ctrl, null, 'NUL byte → null');
}

// ---- Test 10: VALID_CONTAINER_KINDS ----
console.log('\nTest 10: VALID_CONTAINER_KINDS contains expected values');
{
  assert(parser.VALID_CONTAINER_KINDS.has('task'), 'task');
  assert(parser.VALID_CONTAINER_KINDS.has('event'), 'event');
  assert(parser.VALID_CONTAINER_KINDS.has('list_item'), 'list_item');
  assert(parser.VALID_CONTAINER_KINDS.has('activity'), 'activity');
  assert(!parser.VALID_CONTAINER_KINDS.has('bogus'), 'bogus not included');
}

// ---- Test 11: renderRefsInText resolved ----
console.log('\nTest 11: renderRefsInText renders resolved refs as <a> chips');
{
  const out = parser.renderRefsInText(
    'Reading [[Dune]] tonight',
    (name) => name === 'Dune' ? { entityId: 'ent_dune', slug: 'dune-book', name: 'Dune', resolved: true } : null,
    { containerKind: 'task' }
  );
  assert(out.includes('<a class="ref-chip"'), 'chip class present');
  assert(out.includes('href="/entity/dune-book"'), 'link to entity');
  assert(out.includes('>Dune</a>'), 'Dune text inside <a>');
}

// ---- Test 12: renderRefsInText unresolved ----
console.log('\nTest 12: renderRefsInText renders unresolved refs as stub chips');
{
  const out = parser.renderRefsInText(
    'Maybe [[Made Up]]',
    (name) => name === 'Made Up' ? { entityId: 'ent_stub', slug: 'made-up', name: 'Made Up', resolved: false } : null,
    { containerKind: 'task' }
  );
  assert(out.includes('class="ref-chip unresolved"'), 'unresolved class present');
  assert(out.includes('data-ref-unresolved="1"'), 'unresolved marker');
  assert(out.includes('/review-queue?ref='), 'review-queue link');
}

// ---- Test 13: renderRefsInText HTML escaping ----
console.log('\nTest 13: renderRefsInText escapes HTML in source text');
{
  const out = parser.renderRefsInText(
    '<script>alert("xss")</script> [[Dune]]',
    (name) => name === 'Dune' ? { entityId: 'ent_dune', slug: 'dune', name: 'Dune', resolved: true } : null,
    { containerKind: 'task' }
  );
  assert(!out.includes('<script>'), 'script tag escaped');
  assert(out.includes('&lt;script&gt;'), 'escaped form present');
}

// ---- Test 14: renderRefsInText no resolver match → leave raw ----
console.log('\nTest 14: renderRefsInText leaves raw [[name]] when resolver returns null');
{
  const out = parser.renderRefsInText(
    'Reading [[Dune]]',
    () => null,
    { containerKind: 'task' }
  );
  assert(out.includes('[[Dune]]'), 'raw text preserved when no resolve opinion');
}

// ---- Test 15: renderRefsInText attribute escaping ----
console.log('\nTest 15: renderRefsInText escapes attributes (quotes)');
{
  const out = parser.renderRefsInText(
    'See [[Foo "Bar"]]',
    (name) => name === 'Foo "Bar"' ? { entityId: 'ent_x', slug: 'foo-bar', name: 'Foo "Bar"', resolved: true } : null,
    { containerKind: 'task' }
  );
  assert(out.includes('data-ref-name="Foo &quot;Bar&quot;"'), 'quote escaped in attribute');
  assert(!out.includes('"Bar""'), 'no double-quote injection');
}

// ---- Test 16: parseReference preserves raw ----
console.log('\nTest 16: parseReference with preserveRaw keeps raw text');
{
  const p = parser.parseReference('  Foo Bar  ', 'task', { preserveRaw: true });
  assertEq(p && p.raw, '  Foo Bar  ', 'raw preserved');
  const p2 = parser.parseReference('  Foo Bar  ', 'task');
  assertEq(p2 && p2.raw, 'Foo Bar', 'raw trimmed when not preserveRaw');
}

// ---- Test 17: case preservation ----
console.log('\nTest 17: parser preserves case (resolver does case-insensitive match)');
{
  const r = parser.scanForReferences('[[DUNE]] vs [[dune]]', 'task');
  assertEq(r.refs.length, 2, 'two refs (case preserved as separate)');
  assertEq(r.refs[0].name, 'DUNE', 'first raw');
  assertEq(r.refs[1].name, 'dune', 'second raw');
}

// ---- Test 18: scanForReferences very long text ----
console.log('\nTest 18: scanForReferences scales to long text');
{
  const big = Array.from({ length: 1000 }, (_, i) => (i % 7 === 0) ? `[[Ref ${i}]]` : `regular ${i}`).join(' ');
  const r = parser.scanForReferences(big, 'task');
  const expectedCount = big.match(/\[\[/g).length;
  assertEq(r.refs.length, expectedCount, 'all [[ patterns picked up');
}

// ---- Test 19: scanForReferences anchor suffix ignored ----
console.log('\nTest 19: scanForReferences ignores anchor suffix in name');
{
  // Per parser design: anchor/heading refs are out of scope. The full
  // ref including any #anchor is still emitted; resolver/UI can ignore.
  const r = parser.scanForReferences('[[Dune#plot]]', 'task');
  assertEq(r.refs.length, 1, 'ref emitted');
  assertEq(r.refs[0].name, 'Dune#plot', 'name includes anchor');
}

// ---- Test 20: Unicode + diacritics ----
console.log('\nTest 20: scanForReferences handles Unicode');
{
  const r = parser.scanForReferences('[[Café]] and [[naïve]]', 'task');
  assertEq(r.refs.length, 2, 'two refs');
  assertEq(r.refs[0].name, 'Café', 'é preserved');
  assertEq(r.refs[1].name, 'naïve', 'ï preserved');
}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);