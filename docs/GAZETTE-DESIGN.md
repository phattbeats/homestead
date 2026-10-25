# The Homestead Gazette — design note

Status: **IMPLEMENTED** (2026-08-30). The four Porch-agents
dependencies (PRs #78/#84/#85/#86) all landed
on `main`, which unblocked this. The note below is kept as the design
record; where the build diverged from it, the "As built" section at the
end says so and why.

Shipped surface:

| Piece | Where |
|---|---|
| Registry entry (`open_mode: 'sheet'`) | `lib/modules.js` |
| `user_modules` CHECK rebuild | `lib/user-model.js` (`migrate`) |
| Context, prompt, cache, edition schema | `lib/gazette.js` |
| Provider call | `lib/agent-runtime.js` (`composeGazette`) |
| Route | `server.js` — `GET /api/me/gazette/today` |
| Launcher + sheet | `public/index.html` (`sheets[]` → `renderGazetteSheet`) |
| Acceptance tests | `scripts/test-gazette.js` |

## What exists today vs. what the canon assumes

The July design canon (teaser mock: `brand/…/shot-gazette.png`) and the
original description assume two things that **do not exist in this
repo**:

- **"Hearth"** is not a built surface. It appears only as a planned,
  unbuilt analytics read-API name (`docs/GLOSSARY.md:204-209`). There
  is no "ribbon" component for it to expand from.
- **"Gazette gating in the agent module"** — grepped the
  whole tree, zero hits for "gazette" anywhere before this note. The
  agent module (`lib/modules.js:130-148`) has no Gazette-specific
  field or gate. This issue is the first line of Gazette code, full
  stop — treat it as new, not as finishing a wire-up.

So this design note re-derives the Gazette against the module system
that actually exists, rather than against the
canon's architecture assumptions.

## The instruction that changed scope: module, not agent-drawer perk

The original issue text said "module-gated by `agent`" — i.e. the
Gazette would be a feature unlocked when a user has the `agent`
module enabled, not a module itself. The 2026-08-29 comment on this
issue overrides that:

> "users can add / remove it as a module just like everything else"

That means Gazette gets its **own registry key** (`gazette`), its own
row in `user_modules`, and its own enable/disable toggle in the
add-a-room sheet — the same contract every other module uses
(`lib/modules.js:32-181`). It should still `requires:
['agent']` in the registry (no BYOK harness, no edition — the
dependency is real), which reuses the existing cross-module gate
mechanism already proven by `chores.requires: ['lists']`
(`lib/modules.js:98`). Disabling `agent` while `gazette` is enabled
must trip the existing `dependents_active` 409
(`lib/user-model.js` enable/disable cascade, ~502-560) — no new
cascade logic needed, just a new edge in the existing graph.

## Registry entry (draft)

```js
gazette: {
  key: 'gazette',
  name: 'Gazette',
  description: 'A morning edition your agent writes from what actually happened.',
  icon: '📰',
  room: null,            // not a nav tab — opened from the drawer/home, see "Mount point" below
  requires: ['agent'],   // no harness, no edition
  tier: 'advanced',
  version: '1.0.0',
  author: 'homestead-core',
  url: null,
  route: null,
  open_mode: 'sheet',    // NEW open_mode — see below
  scopes: ['read:gazette', 'agent:invoke'],
  mcp: false,
  webhooks: [],
  entity_kinds: ['gazette_edition'],
  default_enabled: false,
},
```

Two things above are new to the registry, not reuses:

1. **`open_mode: 'sheet'`** doesn't exist yet. Current `open_mode`
   values are `frame` (in-SPA nav page), `drawer` (the agent chat
   harness), `tab` (external, third-party). None of the
   three fit "full-screen, non-nav, opened on demand, cached
   per-day." `openSheet(html)` (`public/index.html:1476`) already
   renders arbitrary full-screen modal content — Gazette can be the
   first *registry-driven* consumer of that mechanism instead of a
   hardcoded settings/add-room panel. This is additive: `applyLayout`
   (`public/index.html:767-833`) needs one more branch for
   `open_mode === 'sheet'` (render a launcher affordance, e.g. an
   icon on the drawer FAB or home grid, that calls `openSheet()`
   against the edition route) — it does not change `frame`/`drawer`
   handling.
2. **The `user_modules` CHECK constraint is hardcoded**
   (`lib/user-model.js:221`, `CHECK (module_key IN ('wall','lists',
   'calendar','chores','apps','agent'))`) — SQLite CHECK constraints
   aren't ALTERable in place, so adding `gazette` is a table-rebuild
   migration (new table with the extended CHECK, copy rows, swap),
   the same shape as any prior module-key addition to this table.
   That migration is implementation-issue-sized work, not something
   to sneak into this design note.

## Mount point

No existing full-screen sheet module to copy. Given `agentDrawer`
already gates a FAB (`lib/modules.js:313`, `public/index.html:828-833`),
the simplest launcher is a second small affordance next to that FAB —
e.g. a masthead icon — visible only when `gazette` is in the user's
enabled set, opening `openSheet()` with the edition markup. This
keeps the change additive to `applyLayout` instead of inventing a new
nav concept.

## Generation contract

- **Trigger**: first open of the day per user (not pushed, not
  cron-generated). Server checks a per-user "last generated" date;
  cache miss → assemble context → call the user's BYOK harness (the
  same harness backing the `agent` drawer) with an
  edition-authoring prompt → store the rendered edition → serve it.
  Cache hit → serve the stored edition. This mirrors the `agent`
  module's existing BYOK dependency instead of adding a second LLM
  integration path.
- **Context payload**: `GET /api/me/snapshot` (`lib/snapshot.js`)
  already assembles most of the needed shape —
  `today_tasks`, `today_events`, `overdue_tasks`, `upcoming.*`,
  `lists`, `activity_recent`. What it does **not** yet have: overnight
  wall activity and entity arrivals in Gazette-usable form (that's
  the media-context / participation-contract plumbing landing via
  PRs #78/#85, still open) and tile health (not
  found in this repo at all — flag as a possible scope gap to raise
  separately, not solved here).
- **Editorial voice**: `docs/VOICE.md` Rule 2 is explicit — "One
  voice, no shifts across modules. Homesteader, agent drawer,
  calendar, all of it shares the register. If a third-party module's
  copy reads like a different product, the install is wrong." A
  "morning newspaper" framing must stay inside the warm/dry/slightly-
  amused register (mastheads and section labels are structural/flat
  per the "Surfaces that are NOT editorial" list — dates, labels —
  but lede copy and briefs are prose and must follow Rule 1/3/5). The
  edition-authoring prompt handed to the BYOK harness should carry
  VOICE.md's rules directly, not a separate "editor persona" — this
  issue's "personality lives here, per the register rules" phrasing
  already agrees with that; there is no second voice file to write.
- **Thin-edition rule**: quiet days print small. Concretely: the
  edition-authoring prompt must tell the harness to omit a section
  outright (not pad it) when its context slice is empty, and the
  layout must not reserve fixed space for empty sections — otherwise
  a quiet day still budget-strains empty
  columns.

## Sequencing / dependencies

| Dependency | State (as of 2026-08-29) | Blocks |
|---|---|---|
| Sweep scheduler | PR #84, CI green, 0 reviews | cadence patterns Gazette's daily-cache job can mirror |
| Participation contract | PR #85, mergeable, CI green | Porch brief section needs its register/lexicon rules |
| DoD smoke | PR #86, mergeable, CI green | proves the Porch agent pipeline this brief section reads from |
| Media-context | PR #78, mergeable state unknown | Arts & Media brief section's media-comprehension input |

None merged yet. Implementation work (registry entry, `user_modules`
migration, `open_mode: 'sheet'` handling, generation endpoint, prompt)
should not start until at least the two feeding the brief sections
(#78, #85) land — building against their pre-merge shape risks a
second migration.

## Open questions for whoever picks up implementation

1. Exact route/endpoint naming for "generate or serve today's
   edition" (e.g. `GET /api/me/gazette/today`).
2. Where "tile health" comes from — not modeled anywhere in this repo
   today.
3. Whether the masthead/launcher belongs on the agent-drawer FAB
   cluster or the home grid — a call for whoever builds the sheet,
   informed by user testing, not this note.

---

# As built (2026-08-30)

## The three open questions, answered

1. **Route** — `GET /api/me/gazette/today`, exactly as sketched. One
   endpoint is the whole API surface. `?refresh=1` re-mints the same
   day's edition; it exists because a harness that was briefly broken
   would otherwise leave the reader with a dead sheet until midnight.
2. **Tile health** — the note was wrong that this isn't modelled. It
   is, under a different name: `lib/health-checker.js` keeps
   `service_health_state` per service and `listAll()` reads it.
   `gazette.tileHealth()` uses it, filtered to `down`/`degraded` only —
   an all-green house has nothing to report, which is the thin-edition
   rule doing its job rather than a gap.
3. **Launcher** — docked next to the drawer FAB in the header, not the
   home grid. Reason: it's the only cluster that already holds
   non-nav, always-reachable affordances, so the Gazette didn't need a
   new nav concept invented for it. The `#sheetLaunchers` container is
   generic — a second `open_mode: 'sheet'` module appears there with no
   further layout work.

## Divergences from the note

* **`sheets[]`, not a boolean.** The note suggested following
  `agentDrawer`'s per-key boolean. `computeLayout` emits a `sheets`
  ARRAY of `{key, icon, label}` instead, derived from `open_mode`. A
  boolean would have hardcoded "gazette" into the layout contract and
  into `applyLayout`; the array means the SPA loop never names a module
  key, which keeps the registry-no-hardcoded-keys audit passing on the
  production code (only the acceptance test is allow-listed).
* **The CHECK constraint is now derived, not typed.** The note framed
  the rebuild as a one-off migration for `gazette`. It's written as a
  general repair instead: the CHECK list is generated from
  `modules.MODULE_KEYS`, and `migrate()` compares the stored CHECK
  against the registry on every boot and rebuilds when they disagree.
  The hardcoded six-key literal WAS the drift the constraint existed to
  prevent; the next module to land needs no migration work at all.
* **The edition is JSON, not HTML.** The harness returns a structured
  object that `public/index.html` renders through `esc()`. Letting a
  model's prose reach `innerHTML` would make the edition an injection
  vector into the user's own session.
* **Homestead writes exactly one sentence.** `THIN_NOTE`, used when
  every context slice is empty. Paying the harness to say "nothing
  happened" is the one case where agent-authoring buys nothing, and the
  route skips the provider call entirely on a quiet day — verified by
  the acceptance test, which asserts the fake provider is never
  contacted.
* **No Hearth character prompt.** `composeGazette` does NOT prepend
  `SOUL.md` the way `dispatchHearth` / `draftPorchCandidate` do. Per
  VOICE.md Rule 2 the edition is the house voice, not a character
  speaking — `lib/gazette.js` hands the harness the VOICE.md rules
  directly.

## Failure states

The edition cache is deliberately three-valued (`published` / `thin` /
`unavailable`) rather than present-or-absent. A failed generation is
CACHED for the day so a missing model key doesn't re-dial the provider
on every sheet open, but it is served with `retryable: true` so the
sheet can explain itself and offer the re-run instead of rendering
blank.

## Still open

* **Overnight window vs. edition date.** `overnightSince()` runs from
  the previous edition (clamped to 7 days), not from literal midnight,
  so activity between two editions is never silently skipped. This is
  a deliberate reading of "overnight" that the note didn't specify.
* **BYOK per user.** The route calls `composeGazette` without a
  `byokKey`, so it resolves the server-staged key exactly like the
  drawer's current default (`server.js` passes `byokKey: ''` there too).
  When per-user BYOK key storage lands, both call
  sites want the same one-line change.
* **Token accounting.** `dispatchHearth` records analytics per
  dispatch; `composeGazette` does not. "Token spend is the soul" argues
  the Gazette should be counted too — worth a follow-up once there's a
  surface that shows the number.

# As built (2026-10-25) — the external wire

The daily newspaper now has a consumer. This section records what was
actually built, against the design contract agreed in PHA-3147.

## What it is

`lib/external-edition.js` reads one dated artifact per day — the Ledger's
`external-edition-v2` — and turns it into the external sections that get
merged into a typed issue. The artifact is written by the newspaper's own
cron; Homestead never fetches it over the network. It is a read-only volume
mount.

The wire is **off by default**. With no `GAZETTE_EXTERNAL_EDITION_DIR` set,
the reader returns `disabled`, the merge adds nothing, and the edition is
byte-for-byte what it was before this change.

## The three things that are easy to get wrong

**External sections do not belong in `TYPED_ITEMS`.** That map is
`section key -> (household context) => items`, so a section key added there
derives its items from the household and produces an **empty** section. The
wire carries its own items, so they are appended to the section list directly
and never touch that map.

**The merge goes above the thin computation.** `thin` is derived from "what
is in this edition", so it has to be computed over a list that already
contains the wire sections. A household with nothing in it and a healthy wire
is not thin; a household with nothing in it and a dead wire is. Merging after
the computation would make the renderer return early on `thin` and hide a
full page of headlines behind a "nothing happened" note.

**Personal sections are filtered in context assembly, never in the
renderer.** The social sections are the digest owner's picks. `GAZETTE_EXTERNAL_OWNER_ID`
names the account that owns them; unset means nobody receives them, which is
the safe default.

## States the wire has, which the household does not

`published` / `partial` / `stale` / `unavailable` mean something specific
here and are deliberately not the household's vocabulary. A degraded source
becomes **one** footer line naming it, never per-item prose and never a hole
in the paper. A section past its age budget is withheld **and named** —
yesterday's headlines under today's date is the worst outcome available, and
the silent one. A missing, unreadable or malformed artifact resolves to a
named state; a bad artifact never takes the household edition down with it.

## Untrusted content

Every title and summary in the artifact is data. It is never passed to the
harness as instruction and never enters `buildPrompt` — the wire is rendered
as cards, not as prose for the model to work on.

## Turning it on

```sh
# .env next to docker-compose.yml
GAZETTE_EXTERNAL_EDITION_DIR=/gazette/external
GAZETTE_EXTERNAL_OWNER_ID=<the digest owner's user id>
```

Then recreate the container. The mount in `docker-compose.yml` is read-only
and inert until the directory variable is set.

## Still open

* **The sheet renderer.** `public/index.html`'s `paintGazette` is prose-only
  and shows lede/briefs/note; typed cards need the same branches there if
  the sheet path is ever used. The sheet cache (`gazette_editions`) has no
  rows, so this was deliberately left out of scope.
* **The owner id.** `GAZETTE_EXTERNAL_OWNER_ID` is a user id the server has
  to know. Until it is set, the personal sections are withheld from everyone,
  which is correct but means the owner's own picks are missing.

## The live seam: read the wire inside `composeTypedPayload`

There are two live paths that compose a typed issue: the daily writer in
`jobs/gazette-daily.js` (the path that fills `gazette_issues`) and the sheet
route in `server.js`. Both assemble a context, compose optional prose, and
then call `composeTypedPayload(ctx, { prose })`. They do **not** call
`composeIssue`.

The first version of the wire read the artifact only in `composeIssue`. That
function had no callers, so a direct probe of it showed external sections while
the live cron and route silently composed every issue without them. It was a
dead merge: the feature looked correct in the helper and did nothing in
production.

The reader now lives inside `composeTypedPayload` itself. When `external` is
omitted, it reads the dated artifact for `ctx.date` and filters personal
sections by `ctx.user.username`; callers can still pass `external: null` to
suppress it deliberately. This makes the live seam the only place that can
forget the wire -- and it cannot. The test bootstrap pins the wire off so the
unit suite remains hermetic when a production container has it enabled; the
wire test explicitly turns it on and proves a payload composed with **no**
external argument gets both household and owner-only sections.
