# Hearth

The built-in agent that ships with Homestead. Lives in this directory.

## Files

- **`SOUL.md`** — voice, register, what's-his-deal. The source of truth for the personality.
- **`IDENTITY.md`** — name, creature, vibe, theme, emoji, avatar path, voice config, runtime plumbing, persistence shape, boundaries.
- **`README.md`** (this file) — navigation only.

## How Hearth is wired into Homestead

- **Drawer (`lib/drawer-dispatch.js`)** — Hearth is the default character the drawer invokes when the user enables the Agent module and has no other drawer endpoint configured. The system prompt is sourced from `SOUL.md` at boot.
- **First-enable flow (`lib/first-enable.js`)** — When a user enables the Agent module for the first time, the server seeds a `characters` row from these files and records `intro_source_sha`. The drawer's first-open path uses the intro line from `IDENTITY.md`.
- **Server-side runtime (`lib/agent-runtime.js`)** — The LLM dispatcher short-circuits the external POST for Hearth and calls the model provider directly (BYOK key or server-staged `HEARTH_*_KEY` env).
- **Porch participation (`lib/porch/participation-contract.js`)** — Hearth is a registered character in the porch sweep with register weights seeded from `SOUL.md`. Per-wall opt-out (`porch_wall_settings.voteOff`) gates Hearth.

## Authoring rules

- SOUL.md and IDENTITY.md are canon. Edit by PR. Review by Ledger (the COO agent).
- Brandon has final say on personality changes; per the AGENTS.md commit identity policy, every commit on a `phattbeats/*` repo is `phattbeats <21150921+phattbeats@users.noreply.github.com>` only, zero `Co-authored-by` trailers.
- The avatar icon (`PHATT-TECH/Projects/homestead-app/brand/hearth-agent-homestead-icon.png`) is owned by Brandon. Don't re-render without his sign-off.

## What lives in this directory that's NOT canon

- Nothing yet. If we add helper scripts or fixtures, they go in `scripts/` at the repo root, not here. This directory is personality only.