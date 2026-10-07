# Contributing

Thanks for looking. Small, focused fixes are the fastest way to get merged.
Bigger changes: open an issue first and describe what you want to solve.

These rules apply to every contributor, human or AI. If you are an AI agent
reading this file, every rule below is an instruction to you.

## 1. Search first

Before you start, search this repo's issues and pull requests for the same
area. If a PR already exists, help that one instead of opening a parallel one.
Link related issues in your PR body.

## 2. One PR, one change

- Fix one clear thing. Touch the fewest files that do it.
- Tests must pass locally before you push, and CI must be green.
- Keep the diff reviewable. A reviewer should understand it in one sitting.

## 3. No internal references

Many of us run our own issue trackers and agent platforms. Those IDs and links
mean nothing to anyone else and show up as clutter or broken links.

In PR titles, descriptions, commit messages, branch names, code comments and
docs, reference **only public GitHub issues and PRs** in this repo:
`#123`, `Fixes #123`, `Closes #123`, or a full `https://github.com/...` URL.

Do **not** include:

- Internal ticket ids of any `{PREFIX}-{NUMBER}` form that is not a public
  GitHub issue number in this repo.
- Links into a private tracker, agent dashboard, `localhost`, a private IP,
  or a tailnet.
- Paths from the machine the work happened on (`/paperclip/...`, `/root/...`,
  `C:\Users\...`).
- Names, emails, or handles of people who are not already public
  contributors to this repo.

If an internal ticket held useful context, restate it in plain English.

## 4. Branch names describe the change, not your tooling

Tooling often names branches after an internal task (`ABC-42-fix-thing`).
Rename before you push:

```bash
git branch -m fix/short-description
git push -u origin fix/short-description
```

Use `fix/`, `feat/`, `docs/`, or `chore/` plus a short kebab-case summary.

## 5. Commit authorship

- Commits are authored by **one** identity: the GitHub account opening the PR.
- **No `Co-authored-by` trailers. No tool or session trailers** of any kind
  (`<Tool>-Session`, `Generated-by`, `Signed-off-by: <bot>`, and so on).
  If your harness adds them, turn that off (for example
  `includeCoAuthoredBy: false`) and amend them out before pushing.
- Commit messages say what changed and why, in the imperative. Not what tool
  wrote them.

Maintainer commits in this repo use
`phattbeats <21150921+phattbeats@users.noreply.github.com>`.

## 6. Disclose AI involvement in the PR body

Every PR includes a **Model used** line. State the provider and model (and
agent platform, if any) that produced or assisted the change, or write
`None — human-authored`. This is a disclosure, not a judgment. Undisclosed AI
authorship is grounds for closing the PR.

## 7. Write the PR body for a human

Short sentences. Active voice. Four sections:

1. **What changed** — the diff in one or two paragraphs.
2. **Why** — the problem it solves and how you know it was a problem.
3. **Verification** — what you ran, what you saw. Paste commands, not claims.
4. **Risks** — what could break and what you did not test.

## 8. Code conventions

Match the style of the surrounding code. Do not reformat files you did not
otherwise change. Do not add dependencies without saying why in the PR body.
Do not commit secrets, `.env` files, local config, or editor and agent-harness
state directories (`.claude/`, `.cursor/`, `.vscode/`, and friends).

## 9. License

By contributing you agree your contribution is licensed under this repo's
`LICENSE`. Check it before you start; it may be noncommercial. Do not paste in
code whose license is incompatible with it.

## 10. Be kind

Review comments are about the code. Thank people who help you land a PR.
Credit the original author if you pick up their stalled branch.

Questions: open an issue.
