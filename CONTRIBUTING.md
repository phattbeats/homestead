# Contributing to Homestead

Thanks for your interest in contributing. Homestead is a shared-life
PWA (tasks, calendar, services launcher) for self-hosted households.
The project is licensed under the [GNU Affero General Public License
v3.0 or later](LICENSE) (`AGPL-3.0-or-later`) for source code and
[Creative Commons Attribution 4.0 International](LICENSE-docs)
(`CC BY 4.0`) for documentation and specifications.

## Sign your work — Developer Certificate of Origin (DCO)

This project uses a **Developer Certificate of Origin (DCO)** instead
of a Contributor License Agreement (CLA). The DCO is the same
one-line sign-off used by the Linux kernel and many other large
projects; it certifies the origin of your contribution without
transferring copyright.

By signing off a commit, you certify, in writing, that you have the
right to submit the contribution under the project's license — either
because you wrote it yourself, or because a third party gave you
explicit permission to submit it under AGPL-3.0-or-later.

### The sign-off line

Every commit you submit must carry a `Signed-off-by:` trailer that
matches the name and email on your git author identity:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use `git commit -s` to add it automatically.

### What you're certifying

By adding the `Signed-off-by:` line, you agree to the [Developer
Certificate of Origin 1.1](https://developercertificate.org/):

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I
>     have the right to submit it under the open source license
>     indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best
>     of my knowledge, has been appropriate under the open source
>     license indicated in the file (and I have permission to submit
>     it under that license, or it is available to me under terms
>     that do not conflict with the indicated license); or
>
> (c) The contribution was provided directly to me by some other
>     person who certified (a), (b) or (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution
>     are public and that a record of the contribution (including all
>     personal information I submit with it, including my sign-off) is
>     maintained indefinitely and may be redistributed consistent with
>     this project or the open source license(s) involved.

### Why we use DCO instead of a CLA

- A CLA requires a separate paper-trail (click-through or PDF) per
  contributor. DCO is per-commit — auditors can verify origin by
  looking at git history.
- DCO **does not transfer copyright**. You keep your copyright.
  Brandon (PHATT Tech LLC) keeps his. A CLA with copyright
  assignment would transfer your copyright to the project, which is
  heavier than this codebase warrants.
- DCO is the lighter, well-trodden solution. It is enough to keep
  relicensing options open for the project while making the origin of
  every contribution traceable.

### Enforcing the sign-off

A CI check (`.github/workflows/dco.yml`) runs on every pull request
and fails if any commit in the PR is missing `Signed-off-by:`. The
check is a thin shell wrapper around the official
[`dco-check`](https://github.com/phattbeats/dco-check) action-style
script; see the workflow file for the exact rule.

If your PR fails the DCO check, amend the commit to add the trailer:

```bash
git commit --amend --signoff --no-edit
git push --force-with-lease
```

## License headers (SPDX)

All source files in this repository carry an SPDX license header at
the top:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC
```

(The exact form varies by file type — see existing files for the
shape.) When you add a new file, copy the SPDX header from a similar
file in the same directory. The CI DCO check enforces the
`Signed-off-by:` rule; SPDX-header presence is a separate manual
review item.

## Pull request workflow

1. Fork the repository and create a feature branch off `main`.
2. Make your change. Keep commits focused; one logical change per
   commit.
3. Sign off every commit (`git commit -s`).
4. Push the branch and open a pull request against `main`.
5. CI must pass: DCO check, the full `npm test` suite (see
   `package.json` `scripts.test`), and the `npm run test:smoke`
   smoke suite where applicable.
6. A maintainer will review. Expect comments; expect pushback on
   design choices. That is the point of review.

## Commit message style

We don't enforce a strict format, but the existing log uses a
`<issue-id>: <short summary>` prefix on the first line, e.g.:

```
PHA-1234: wall posts endpoint
```

A short body paragraph explaining the *why* (not the *what*) is
welcome but not required.

## Reporting security issues

**Do not file security issues publicly.** Email
`obiwouldjablowme@protonmail.com` (Brandon, PHATT Tech LLC). PGP key
on request. We will respond within 72 hours with an acknowledgement
and a coordinated disclosure timeline.

## Code of conduct

Be kind. Be patient with new contributors. Assume good faith until
proven otherwise. We are building a small piece of household
software, not a battleship. Don't make it harder than it is.

## Questions?

Open an issue with the `question` label, or email the address above.