# Hearth

The built-in agent that ships with Homestead. Lives in this directory.

## Files

- **`SOUL.md`** — voice, register, what's-his-deal. The source of truth for the personality.
- **`IDENTITY.md`** — name, creature, vibe, theme, emoji, avatar path, voice config, runtime plumbing, persistence shape, boundaries.
- **`README.md`** (this file) — navigation only.

## How Hearth is wired into Homestead

- **Drawer (PHA-1617.6 / `lib/drawer-dispatch.js`)** — Hearth is the default character the drawer invokes when the user enables the Agent module and has no other drawer endpoint configured. The system prompt is sourced from `SOUL.md` at boot.
- **First-enable flow (PHA-2827.B / `lib/first-enable.js` — shipped by the B child)** — When a user enables the Agent module for the first time, the server seeds a `characters` row from these files and records `intro_source_sha`. The drawer's first-open path uses the intro line from `IDENTITY.md`.
- **Server-side runtime (PHA-2827.C / `lib/agent-runtime.js` — shipped by the C child)** — The LLM dispatcher short-circuits the external POST for Hearth and calls the model provider directly (BYOK key or server-staged `HEARTH_*_KEY` env).
- **Porch participation (PHA-2827.D / `lib/porch/participation-contract.js` — shipped by the D child, owner Van Dam)** — Hearth is a registered character in the porch sweep with register weights seeded from `SOUL.md`. Per-wall opt-out (`porch_wall_settings.voteOff`) gates Hearth.

## Spec / parent

- **PHA-2827** — parent issue: "🔥 Hearth: The Homestead Built-In Agent + Personality".
- **PHA-2828** — this file's issue: "Hearth SOUL.md + IDENTITY.md + GLOSSARY rename".

## Authoring rules

- SOUL.md and IDENTITY.md are canon. Edit by PR. Review by Ledger (the COO agent).
- Brandon has final say on personality changes; per the AGENTS.md commit identity policy, every commit on a `phattbeats/*` repo is `phattbeats <obiwouldjablowme@protonmail.com>` only, zero `Co-authored-by` trailers.
- The avatar icon (`PHATT-TECH/Projects/homestead-app/brand/hearth-agent-homestead-icon.png`) is owned by Brandon. Don't re-render without his sign-off.

## What lives in this directory that's NOT canon

- Nothing yet. If we add helper scripts or fixtures, they go in `scripts/` at the repo root, not here. This directory is personality only.