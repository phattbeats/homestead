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

## Policy — fresh-install acceptance (PHA-2556 amendment)

Acceptance criteria must be phrased as a **user-visible outcome from a fresh
install**: an operator who has just booted the appliance — no manual config,
no out-of-band DB writes, no human-judged first-time grants — must reach the
promised state via the documented UI/API surface alone. **If a verification
script needs a manual DB write to pass, that write is the missing feature.**

This rule closes the PHA-2493 / PHA-2556 class of "closed green, broken in
the user's hands" defects: a smoke test that open-codes an
`INSERT INTO user_groups` to grant the test user access to a wall, then
asserts the wall is visible, proves nothing — it reproduces the manual
setup the bug is *about*, and the test passes whether the product works
or not.

Test patterns that violate this rule:

- Direct `INSERT` / `UPDATE` / `DELETE` against the SQLite file to set up
  state that the API itself can set.
- Disabling auth or permission gates by hand to reach the test path.
- Reaching into `users`/`groups`/`wall_memberships` to simulate an
  admin grant when the admin UI / `requireAdmin` API exists.

Allowed test-infrastructure DB writes (NOT covered by this rule):

- **Quiet-hours override** (`notification_prefs.quiet_*_hour`) so a smoke's
  pass/fail is wall-clock-independent — the product has no public API for
  these fields yet, and the override is unrelated to the user-visible
  state under test.
- **Seeding a fresh DB** (booting server.js with an ephemeral DATA_DIR)
  — the seed path is itself a product surface.
- **Schema additions** in the test harness (`CREATE TABLE IF NOT EXISTS
  notification_log` etc.) that mirror server.js's inline DDL for test
  isolation — the running server doesn't depend on them being absent.

The boundary is: **if the DB write exists to set up state the product
should set up via the API, the product is missing a feature, and the
test should fail loudly until that feature lands.**

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