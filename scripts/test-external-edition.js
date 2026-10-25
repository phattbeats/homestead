#!/usr/bin/env node
// acceptance tests — the external wire (daily newspaper) merge.
//
// Covers the states the wire has to survive, and the one defect that is
// easiest to ship and hardest to notice:
//
//   1. Off by default: no configured directory means no wire sections and an
//      unchanged edition.
//   2. A bad artifact is a STATE, never a crash: missing, unparsable,
//      wrong-version and wrong-date files each resolve to a named status.
//   3. Personal sections reach the digest owner and nobody else.
//   4. A section past its age budget is withheld and NAMED, never printed as
//      today's news.
//   5. A degraded source is one disclosure, not a hole in the paper.
//   6. Unknown keys and item types are dropped rather than rendered raw.
//   7. `thin` is computed over the MERGED section list — a household with
//      nothing in it and a healthy wire is not thin, and one with a dead wire
//      is. This is the defect a rushed PR ships: the flag computed over the
//      pre-merge list hides a full page of headlines behind "nothing
//      happened".
//
// Follows the assert() conventions from scripts/test-gazette-issue.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-external-edition-'));
const artifactDir = path.join(tmpDir, 'gazette-v2');
fs.mkdirSync(artifactDir, { recursive: true });

const { readExternalEdition, EXTERNAL_SECTION_KEYS } = require('../lib/external-edition');
const { composeTypedPayload } = require('../lib/gazette');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label); else ng(label, `got ${a}, want ${b}`);
}

const DAY = '2026-10-24';
const NOW = new Date('2026-10-24T09:00:00Z');

function artifact(overrides = {}) {
  return {
    schema_version: 2,
    type: 'external.edition',
    edition_date: DAY,
    timezone: 'America/New_York',
    generated_at: '2026-10-24T07:00:00Z',
    status: 'partial',
    audience_scope: 'mixed',
    masthead: { title: 'The Ledger' },
    sources: [
      { id: 'bbc', label: 'BBC News', status: 'ok', checked_at: '2026-10-24T07:00:00Z' },
      { id: 'reddit', label: 'Reddit', status: 'error', error: 'Digest missing.', checked_at: '2026-10-24T07:00:00Z' },
    ],
    sections: [
      {
        id: 'news', homestead_key: 'world_news', title: 'The World Today', audience: 'household',
        max_age_hours: 48, source_ids: ['bbc'],
        items: [
          { id: 'a1', kind: 'article', title: 'Headline one', summary: 'Excerpt one.', summary_origin: 'publisher_excerpt', url: 'https://example.org/one', source: 'BBC News', source_id: 'bbc', published_at: '2026-10-24T05:00:00Z' },
        ],
      },
      {
        id: 'twitter', homestead_key: 'social_timeline', title: 'From Your Timeline', audience: 'personal',
        max_age_hours: 24, source_ids: ['twitter'],
        items: [
          { id: 't1', kind: 'tweet', title: '@someone: hello', summary: 'hello', summary_origin: 'post_text', url: 'https://x.com/someone/status/1', source: 'X / Twitter', source_id: 'twitter', published_at: '2026-10-24T06:00:00Z', author: 'Someone' },
        ],
      },
    ],
    provenance: { summary_policy: 'Publisher excerpts and existing digest selections; no invented reporting.', producer: 'daily-newspaper' },
    policy: {
      untrusted_content: true,
      citation_required: ['url', 'source'],
      personal_sections: ['social_timeline'],
      shared_wall_publication: 'forbidden',
      max_item_chars: { title: 300, summary: 500 },
    },
    ...overrides,
  };
}

function writeArtifact(doc, name = `${DAY}.json`) {
  fs.writeFileSync(path.join(artifactDir, name), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

function env(extra = {}) {
  return { GAZETTE_EXTERNAL_EDITION_DIR: artifactDir, ...extra };
}

console.log('\nexternal edition — the wire reader');

fs.writeFileSync(path.join(artifactDir, `${DAY}.json`), JSON.stringify(artifact(), null, 2));

// --- 1. off by default ------------------------------------------------------
{
  const block = readExternalEdition({ date: DAY, now: NOW, env: {} });
  assertEq(block.status, 'disabled', 'no configured directory -> disabled');
  assertEq(block.sections.length, 0, 'disabled -> no sections');
}

// --- 2. a bad artifact is a state, not a crash -------------------------------
{
  const missing = readExternalEdition({ date: '2026-10-25', now: NOW, env: env() });
  assertEq(missing.status, 'unavailable', 'missing artifact for today -> unavailable');
  assertEq(missing.reason, 'no_artifact_for_date', 'missing artifact names the reason');

  writeArtifact('{not json', 'bad.json');
  const bad = readExternalEdition({ date: 'bad', now: NOW, env: env() });
  assertEq(bad.status, 'unavailable', 'unparsable artifact -> unavailable');
  assertEq(bad.reason, 'artifact_unparsable', 'unparsable artifact names the reason');

  writeArtifact(artifact({ schema_version: 1 }), 'v1.json');
  const v1 = readExternalEdition({ date: 'v1', now: NOW, env: env() });
  assertEq(v1.reason, 'unsupported_schema_version', 'wrong schema version -> unavailable');

  writeArtifact(artifact({ edition_date: '2026-10-01' }), 'wrongdate.json');
  const wd = readExternalEdition({ date: 'wrongdate', now: NOW, env: env() });
  assertEq(wd.reason, 'artifact_date_mismatch', 'date mismatch -> unavailable');
}

// --- 3. the happy path -------------------------------------------------------
{
  const block = readExternalEdition({ date: DAY, now: NOW, userId: 'someone-else', env: env() });
  assertEq(block.status, 'partial', 'a degraded source -> partial');
  assertEq(block.edition_date, DAY, 'block carries the edition date');
  assertEq(block.sections.map(s => s.key), ['world_news'], 'non-owner gets household sections only');
  assertEq(block.degraded_sources.map(d => d.id), ['reddit'], 'the degraded source is named');
  assertEq(block.audience_scope, 'household', 'a household-only reader sees household scope');
}

// --- 4. personal sections: owner only ----------------------------------------
{
  const block = readExternalEdition({
    date: DAY, now: NOW, userId: 'brandon',
    env: env({ GAZETTE_EXTERNAL_OWNER_ID: 'brandon' }),
  });
  assertEq(block.sections.map(s => s.key), ['world_news', 'social_timeline'], 'the owner also gets the personal section');
  assertEq(block.audience_scope, 'mixed', 'the owner sees a mixed scope');

  const noOwner = readExternalEdition({ date: DAY, now: NOW, userId: 'brandon', env: env() });
  assertEq(noOwner.sections.map(s => s.key), ['world_news'], 'with no owner configured, nobody gets personal sections');
}

// --- 5. the age budget -------------------------------------------------------
{
  const later = new Date('2026-10-31T09:00:00Z'); // a week later
  const block = readExternalEdition({
    date: DAY, now: later, userId: 'brandon',
    env: env({ GAZETTE_EXTERNAL_OWNER_ID: 'brandon' }),
  });
  assertEq(block.status, 'stale', 'a week-old artifact -> stale');
  assertEq(block.sections.length, 0, 'a stale artifact yields no sections');
  assert(block.stale_sections.length > 0, 'the stale sections are named', JSON.stringify(block.stale_sections));
  assert(block.stale_sections.includes('world_news'), 'the stale section is named by key');
}

// --- 6. unknown keys and item types are dropped, not rendered raw -----------
{
  const doc = artifact({ edition_date: 'unknown' });
  doc.sections[0].items.push({ id: 'x1', kind: 'article', title: 'No citation', summary: 'x', url: 'javascript:alert(1)', source: 'x', source_id: 'bbc' });
  doc.sections[0].items.push({ id: 'x2', kind: 'wall_post', title: 'Wrong type', summary: 'x', url: 'https://example.org/x', source: 'x', source_id: 'bbc' });
  doc.sections.push({ id: 'ghost', homestead_key: 'not_a_key', title: 'Unknown key', audience: 'household', max_age_hours: 48, source_ids: [], items: [{ id: 'g1', kind: 'article', title: 't', summary: 's', url: 'https://example.org/g', source: 's', source_id: 'bbc' }] });
  writeArtifact(doc, 'unknown.json');
  const block = readExternalEdition({ date: 'unknown', now: NOW, userId: 'x', env: env() });
  assertEq(block.sections.map(s => s.key), ["world_news"], "an unknown section key is dropped");
  assert(block.sections[0] && block.sections[0].items.length === 1, 'uncited and unknown-typed items are dropped');
}

// --- 7. the merge, and the thin flag -----------------------------------------
{
  const block = readExternalEdition({ date: DAY, now: NOW, userId: 'brandon', env: env({ GAZETTE_EXTERNAL_OWNER_ID: 'brandon' }) });
  const emptyCtx = { date: DAY, tz: 'UTC', today_tasks: [], overdue_tasks: [], upcoming_chores: [], arrivals: [], porch_overnight: { posts: [], comments: [] }, today_events: [] };

  const wireOnly = composeTypedPayload(emptyCtx, { external: block });
  assertEq(wireOnly.thin, false, 'a household with nothing and a healthy wire is NOT thin');
  assertEq(wireOnly.sections.map(s => s.key), ['world_news', 'social_timeline'], 'the wire sections are merged in');
  assert(wireOnly.editors_note === null, 'a non-thin edition carries no thin note', String(wireOnly.editors_note));

  const noWire = composeTypedPayload(emptyCtx, { external: null });
  assertEq(noWire.thin, true, 'a household with nothing and no wire IS thin');
  assert(noWire.editors_note && noWire.editors_note.length > 0, 'the thin note is present');

  const disabled = composeTypedPayload(emptyCtx, { external: readExternalEdition({ date: DAY, now: NOW, env: {} }) });
  assertEq(disabled.thin, true, 'a disabled wire leaves the household edition exactly as it was');
  assertEq(disabled.sections.length, 0, 'a disabled wire adds no sections');

  // The household's own sections still work alongside the wire.
  const ctxWithMaterial = { ...emptyCtx, today_tasks: [{ id: 't', title: 'Pay the bill', status: 'due_today' }] };
  const both = composeTypedPayload(ctxWithMaterial, { external: block });
  assertEq(both.thin, false, 'household material plus wire is not thin');
  assert(both.sections[0].key === 'rotation_desk', 'household sections come first');
  assert(both.sections.some(s => s.key === 'world_news'), 'the wire follows the household sections');

  // The disclosure channel: one field, not per-item prose.
  assert(both.external && both.external.degraded_sources.length === 1, 'the wire state rides on one field');
  assertEq(both.external.status, 'partial', 'the wire status is carried');
}

// --- 8. ordering ------------------------------------------------------------
{
  assertEq(EXTERNAL_SECTION_KEYS, ['world_news', 'technology', 'daily_podcast', 'social_timeline', 'social_forum'], 'the external registry order is fixed');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
