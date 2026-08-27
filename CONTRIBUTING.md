# Contributing to Homestead

This document captures the engineering practices every Homestead change goes
through. It exists because the 2026-08-23 design review found four closed
"done" issues with no code in `main`, an acceptance suite that "passed" against
endpoints returning 404, a repo head that bricks the SPA login, and a flagship
feature unreachable by any user. Reports about work are not work. Every green
check now has to come with artifact-grade evidence.

## Definition of Done — the standing policy (PHA-2501)

**An issue moves to `done` only when its closing comment contains
artifact-grade evidence:**

| Work type | Required evidence |
|---|---|
| **UI work** (any HTML/CSS/JS/frontend change) | A **screenshot** of the actual rendered result at **mobile viewport (390px-class)** captured from a **REAL running instance** (scratch container or staging, booted from the branch). Playwright + Chromium is the standard tool; the `scripts/smoke-postlogin-screenshot.js` smoke is the template. |
| **API work** (any new/changed HTTP route or schema) | The **actual curl/HTTP transcript** against a running instance: request + response body. Not "the endpoint was added" — the bytes. |
| **All code work** | The **commit SHA(s) in `main`** (or the merged PR link). No SHA in `main` = not done. Board status must trace to the artifact. |
| **Migrations** | Evidence of a boot over a **REAL copied database** (not just fresh), with the row counts before/after. |
| **Deploys / infra** | The verification curl from **OUTSIDE** (public URL), same as the Sonarr pattern (`browser 302 + API 200`). |

Self-review does not count as verification. The evidence must be reproducible
by someone else from what is posted. **An issue closed without evidence gets
reopened by whoever notices, no discussion needed — the policy is the
authority.**

### Fresh-install acceptance (PHA-2556 amendment)

Acceptance criteria must be phrased as a **user-visible outcome from a fresh
install**. A verification script may not perform setup the product itself
cannot perform: if the script needs an `INSERT INTO user_groups` (or any
similar hand-rolled DB grant) to reach the state under test, that grant is
the missing feature, and the script should fail loudly until the API exposes
the same operation.

The only legitimate test-infrastructure DB writes are: a quiet-hours
override so a smoke's pass/fail doesn't depend on the wall-clock hour; a
fresh-DB seed (the seed path is itself a product surface); and schema
mirrors in the test harness that don't affect what the running server
delivers. See `docs/DEFINITION-OF-DONE.md` for the full rule + boundary
cases.

### Closing-comment template

Every closing comment follows this shape so the audit is mechanical:

```
## WHAT changed
<one short paragraph describing the actual change shipped>

## SHA in main
<commit SHA(s), or merged PR link>

## EVIDENCE
- screenshot: ./verify-out/postlogin-390.png  (UI work)
- transcript: <paste curl request + response bytes>  (API work)
- migration: <before/after row counts on the copied DB>  (migrations)
- public URL: <curl output from outside>  (deploys)
```

The same shape is used for agent-issued comments and human-issued comments.
When the proof is short, paste it inline. When it's a long log, link the file
in the PR description.

## Local verify — the lazy path is the honest path

`scripts/verify.sh` runs the full Definition of Done evidence chain in one
command:

```bash
PLAYWRIGHT_BROWSERS_PATH=0 ./scripts/verify.sh
```

It boots a scratch Homestead instance on an ephemeral port with a fresh DB,
runs the SPA page-error guard (catches duplicate top-level declarations like
the PHA-2494 bug), runs the post-login 390px mobile screenshot smoke, and
prints a `/api/health` curl transcript. Screenshots land in `./verify-out/`.

If you change anything UI-shaped, run `./scripts/verify.sh` before opening the
PR. If the PR review asks "where's the screenshot?", point at
`./verify-out/postlogin-390.png` and the verify.sh transcript.

## CI gate — release gate enforcement

The `.github/workflows/test.yml` workflow runs:

1. `npm ci`
2. `npx playwright install --with-deps chromium`
3. `npm test` (the existing 30-test chain)
4. `node scripts/smoke-spa-pageerrors.js` (PHA-2494 regression guard)
5. `node scripts/smoke-postlogin-screenshot.js` (PHA-2501 evidence smoke)

**Tags don't get cut with the smoke red.** If the smoke fails on a PR, the PR
is not mergeable. The release workflow (`.github/workflows/release.yml`)
fires on `v*` tags — the upstream Docker image publish depends on a clean
test workflow.

## Author identity (PHA-2352)

Every Homestead commit must have author/committer
`phattbeats <obiwouldjablowme@protonmail.com>` and contain no `Co-authored-by`
trailer of any identity. `npm run hooks:install` (run by `npm install` via the
`prepare` step) wires the local hook that enforces this. The
`.github/workflows/authorship-check.yml` workflow enforces it again on every
PR.

If you operate Claude Code, set `includeCoAuthoredBy: false`. If a trailer
appears anyway, amend it off before pushing. See `docs/AUTHORSHIP.md` for the
full policy and pre-push audit command.

## How to work a Homestead issue

1. **Read the issue twice.** Look at `parentId`, `ancestors`, prior
   `comments`. The body usually has the WHY; the comments usually have the
   edge cases that bit the prior agent.
2. **Check existing code.** Read `lib/`, `scripts/`, `server.js`. The horror
   of rebuilding something that's already there is one you will not
   experience twice.
3. **Branch off the latest commit on the relevant branch.** Don't base off
   `main` if your work depends on open PR work — base off the most relevant
   branch tip instead.
4. **Implement clean.** Comments explain *why*, not just *what*.
5. **Run `./scripts/verify.sh`** locally. Attach `./verify-out/postlogin-390.png`
   to the PR description or comment.
6. **Open a PR.** Describe the WHAT / SHA / EVIDENCE shape in the PR body.
7. **Squash-merge after CI is green + reviewer approves.** Delete the
   feature branch on merge.
8. **Move the issue to `done` only after the merge** — with the closing
   comment in the WHAT / SHA / EVIDENCE shape, and the SHA actually in
   `main`.

## Related

- `docs/GLOSSARY.md` — canonical names for every Homestead surface (PHA-2635)
- `docs/AUTHORSHIP.md` — author identity policy (PHA-2352)
- `docs/DEFINITION-OF-DONE.md` — extended rationale and policy history
- `.github/workflows/test.yml` — CI smoke gate
- `.github/workflows/authorship-check.yml` — author-identity gate
- `scripts/verify.sh` — one-shot local verification
- `scripts/smoke-postlogin-screenshot.js` — 390px post-login screenshot smoke