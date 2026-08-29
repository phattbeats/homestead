// PHA-2648 — CI wrapper around scripts/seed-porch-smoke.mjs.
//
// The seed script is also runnable standalone (`npm run smoke:porch`) with
// its own pass/fail counters and a printed evidence bundle — useful for a
// human checking DoD evidence by hand. This file just re-asserts the same
// run's result shape through node:test so `npm test` (and CI on any PR
// touching lib/media.js, lib/porch/*, or the agent wall routes — see
// .github/workflows/test.yml) fails loudly if the pipeline regresses.
//
// Runs a real (ephemeral-port) homestead instance + real ffmpeg keyframe
// extraction, so this is slower than the unit-level participation-contract
// tests — expect single-digit seconds, not milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke } from '../../scripts/seed-porch-smoke.mjs';

test('PHA-2648 Porch DoD smoke: throwaway post + agent reaction with specific-reference verification', async () => {
  const result = await runSmoke();

  assert.equal(result.fail, 0, `seed-porch-smoke reported failures: ${result.failures.join(', ')}`);

  const { evidence } = result;
  assert.equal(evidence.imageContext.response.kind, 'image');
  assert.equal(evidence.videoContext.response.kind, 'video');
  assert.ok(evidence.videoContext.response.frames.length >= 1, 'real ffmpeg keyframe extraction produced at least one frame');

  assert.equal(evidence.accepted.decision.action, 'post', 'specific-reference candidate clears the participation contract');
  assert.equal(evidence.rejected.reason, 'not_specific', 'generic control candidate is refused by the specificity gate');

  assert.equal(evidence.resultingComment.author.username, 'emily');
  assert.equal(evidence.resultingComment.author.isAgent, true, 'API surfaces the isAgent signal the badge/vote-off UI renders from');
});
