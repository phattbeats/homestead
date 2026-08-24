# Definition of Done — Homestead standing policy

> **Brandon's rule (2026-08-23, verbatim):** *"Nothing's done without a
> screenshot or other type of REAL verification."*

This document is the canonical reference for the policy. The closing-comment
checklist lives in [`CONTRIBUTING.md`](../CONTRIBUTING.md); this file is the
WHY behind it and the maintenance history.

## Why this exists (the 2026-08-23 design review)

The design review on 2026-08-23 found four closed `done` issues with no code
in `main`, an acceptance suite that "passed" against endpoints returning 404,
a repo head that bricks the SPA login, and a flagship feature unreachable by
any user. Every one of those closed green. Reports about work are not work.

The failure mode: a green CI badge, a "passed" test, and a comment thread
that says "I shipped it" — but nothing an operator can reach. The fix is
mechanical evidence: a screenshot of the rendered result, a curl transcript
of the live endpoint, a commit SHA in `main`. Evidence an outside reviewer can
reproduce.

## Policy — required evidence per work type

| Work type | Required evidence |
|---|---|
| **UI work** | A **screenshot** at **mobile viewport (390px-class)** captured from a **REAL running instance** (scratch container or staging, booted from the branch). Playwright + Chromium is the standard tool. |
| **API work** | The **actual curl/HTTP transcript** against a running instance: request + response body. |
| **All code work** | The **commit SHA(s) in `main`** (or the merged PR link). |
| **Migrations** | Evidence of a boot over a **REAL copied database**, with the row counts before/after. |
| **Deploys / infra** | The verification curl from **OUTSIDE** (public URL), same as the Sonarr pattern. |

Self-review does not count as verification. The evidence must be reproducible
by someone else from what is posted.

## Enforcement layers

The policy is enforced at three layers so that closing an issue without evidence
is structurally hard, not just discouraged:

1. **CI smoke test** (`.github/workflows/test.yml`): headless Chromium loads
   `/`, logs in as a seeded user, fails the build on ANY `pageerror` or
   console error, and saves a screenshot artifact of the post-login home at
   390px. This alone would have caught PHA-2494.
2. **Release gate**: `npm test` includes the smoke test; tags don't get cut
   with it red. The release workflow (`.github/workflows/release.yml`) fires
   on `v*` tags and depends on the test workflow being green.
3. **One-shot local verify** (`scripts/verify.sh`): boots a scratch instance
   (fresh DB), runs the smoke test, drops screenshots into `./verify-out/`.
   So "attach real verification" costs an agent one command, not an afternoon.
   The lazy path IS the honest path.

## Closing-comment template

The mechanical audit relies on every closing comment following the same shape:

```
## WHAT changed
<one paragraph>

## SHA in main
<commit SHA(s), or merged PR link>

## EVIDENCE
- screenshot: ./verify-out/postlogin-390.png
- transcript: <curl req + resp bytes>
- migration: <before/after row counts>
- public URL: <curl output>
```

When the proof is short, paste it inline. When it's a long log, link the
file in the PR description.

## Re-brief mechanism

Every agent assigned a Homestead issue should be re-briefed on this policy in
the same shape as the PHA-2352 commit-identity re-brief: a comment on the
agent's most recent issue thread that links here and applies the
closing-comment template. An issue closed without evidence gets reopened by
whoever notices — the policy is the authority, no discussion needed.

## Maintenance

This policy is itself subject to the policy: this issue (PHA-2501) closes
only when the smoke test exists in CI (SHA), `verify.sh` runs green
(transcript), and the re-brief comments are posted on each agent's thread
(links). Report back in the issue with all three.

### History

- **2026-08-23** — Brandon issued the standing rule after the design review
  findings. PHA-2501 created as the enforcement vehicle.
- **2026-08-23 (this commit)** — Initial implementation: CI smoke workflow
  (`.github/workflows/test.yml`), `scripts/verify.sh`, `scripts/smoke-postlogin-screenshot.js`,
  `CONTRIBUTING.md`, this document. Caught and fixed the
  `sendFile({root:__dirname})` bug in `server.js` (lines 2407-2418) — the SPA
  catch-all was returning 404 for `/`, `/lib/scope-display.js`, `/favicon.ico`
  on Node 22 + send 1.2.x. The smoke test caught it on first run.