# Glossary

> The canonical names for every Homestead surface and concept. If
> something in the app, the docs, or a PR description doesn't match
> a term here, the term in this file wins. The founder once called
> the Porch "the garden?" — this file exists so nobody has to ask
> twice.

**Rule going forward:** any PR that introduces a user-facing surface
adds the surface name here in the same PR. The check is part of
review — the rule is the review comment.

**See also:** [`AUTHORSHIP.md`](AUTHORSHIP.md) for commit identity,
[`DEFINITION-OF-DONE.md`](DEFINITION-OF-DONE.md) for closing-comment
evidence, [`VOICE.md`](VOICE.md) for the editorial register used in
user-visible copy.

---

## The product

- **Homestead** — the product. A shared-life app for self-hosted
  households. Tasks, calendar, a launcher grid, and a wall (feed) for
  the people you live with. Single Node container, SQLite, no
  external runtime dependencies. Mobile-first PWA — install it to
  a phone home screen and it behaves like a native app.

- **PHATT TECH** — the company that ships Homestead. The product
  belongs to the household; the build belongs to the company.

- **The app, the install, the instance** — informal synonyms for a
  Homestead deployment. "What's running on the Unraid box" is the
  instance. A fresh install means a fresh database; an upgrade means
  the same database with new code on top.

---

## Rooms and layout

These are the surfaces a user actually sees. They are not abstract —
each one is either a tile in the home grid or a tab in the top strip.

- **The Porch** — the social surface. A wall (feed) of posts from
  the people the user shares a wall with. Photos, videos, link
  shares, and plain text. Idempotent emoji reactions and inline
  comments. The Porch is the only module enabled for new users
  (per PHA-2200 Amendment 2) — every fresh install lands here. The
  module key is `wall`; the deep link is `/porch.html`; the in-SPA
  page div is `#page-porch`. The decision to call the surface
  "Porch" instead of "Feed" or "Wall" was editorial — the wall is
  the data model; the Porch is where you sit with it.

- **A wall** — one feed. A wall has members (users who can see and
  post to it) and a kind (`household`, `media_club`, etc.).
  Visibility is **group** when the wall belongs to a group everyone
  in it can see, or **direct** when the wall is shared person-to-
  person outside a group. The Porch surfaces whichever wall(s) the
  signed-in user is a member of.

- **The Kitchen** *(aspirational)* — the user-facing name for the
  shared-lists room. The shipped module is `lists`; the SPA page is
  `#page-r-lists`. The PR that renames the literal "Lists" copy to
  "The Kitchen" hasn't landed yet — when it does, this entry becomes
  canonical and `lists` becomes the registry key only.

- **The Den** *(aspirational)* — the user-facing name for the media
  room. The shipped module is `apps` (the tile launcher); the
  per-service deep links land in `/apps.html`. Media browsing itself
  is a follow-up, not in v0.3.0.

- **The Hall** *(aspirational)* — the user-facing name for the
  calendar room. The shipped module is `calendar`; the SPA page is
  `#page-r-calendar`. Renaming "Calendar" copy to "The Hall" is
  pending.

- **The Workshop** *(aspirational)* — the user-facing name for the
  apps/tiles room when it's a craft surface rather than a launcher.
  Today `apps` is a launcher; if/when a build surface lands, the
  Workshop entry absorbs it.

- **The Front Porch** *(aspirational)* — the user-facing name for the
  media-club wall when it's a separate module from `wall`. The
  current code uses a single `wall` module with multiple wall kinds
  (including `media_club`); promoting it to its own module is a
  PHA-2152 follow-up.

- **The Meadow** — the **home layout** when four or more rooms are
  enabled. The Meadow is the dense tile grid in the centre of the
  screen with the drawer chrome and the `+ Add rooms` pill along
  the right edge. The Meadow is **not** a room — it's one of four
  shapes the SPA takes, returned by `GET /api/me/layout` under the
  `layout: "meadow"` key. The other shapes are `empty`, `feed-only`
  (one room, no chrome), and `feed-tabs` (two-to-three rooms, top
  tab strip).

- **The layout** — the object `GET /api/me/layout` returns. It
  carries the enabled-room list, the active layout shape, the
  `defaultRoute` (deep link the SPA loads on boot, or `null` for a
  SPA-only room), `addRoomVisible` (whether the `+ Add rooms` pill
  is shown), and `agentDrawer` (whether the agent FAB is shown).
  The SPA's bootstrap reads this object exactly once per boot.

- **The drawer** — the slide-up chat panel that hosts the Agent
  module. The drawer is shown as a FAB (floating action button)
  when `agentDrawer: true` in the layout payload; tapping it slides
  the drawer up from the bottom on a phone, or opens it as a side
  panel on a tablet.

- **The install coach** — the first-run sheet that explains how to
  add Homestead to a phone home screen so push notifications work.
  It's a PWA-install funnel sheet, not a tutorial: the body is
  platform-aware ("iOS" vs "Android" vs "Desktop"), the dismiss is
  sticky per browser, and the coach never asks for notification
  permission itself (the user has to tap "Enable push notifications"
  in the avatar menu after install). The funnel events are recorded
  in `install_funnel_events` via `POST /api/funnel/install`.

---

## Module system

- **Module** — anything in the registry at `lib/modules.js`. A
  module has a `key` (`wall`, `lists`, `calendar`, `chores`,
  `apps`, `agent`, plus any third-party installs), a `name`
  (display label), a `room` (the SPA page discriminator — the
  `data-p` value the nav button and `#page-*` div share), an
  `open_mode` (`frame` for in-SPA, `drawer` for the agent), a
  `requires` list (e.g. `chores` requires `lists`), a `tier`
  (`core` or `advanced`), and the third-party manifest fields
  (`author`, `version`, `mcp`, `webhooks`, `entity_kinds`,
  `default_enabled`).

- **Module registry** — the static JS object at `lib/modules.js`.
  It's the **single source of truth** for every module the user
  can enable, built-in or third-party. Built-in entries MUST
  dogfood the same shape third-party entries use (no private
  internal-only fields) — the validator at
  `lib/registry-validate.js` proves the symmetry.

- **A room** — colloquial synonym for a module the user can land
  on. A room is what shows up in the Meadow grid; a module is
  what's in the registry. They map 1:1 in v0.3.0 but the
  distinction matters when a future module is **drawer-only** (no
  room in the grid, just the FAB).

- **The `+ Add rooms` pill** — the button that opens
  `/modules.html` (the add-a-room sheet). It's visible when
  `addRoomVisible: true` in the layout payload, which is true
  when at least one registry entry is not yet enabled by the user.

- **Add-a-room sheet** — the SPA page at `/modules.html` that
  lists every registry entry the user doesn't have enabled. Tapping
  a row enables the module (with the right cascade flags — see
  Cascade rules in the README). It's a one-tap install; the
  backend is `POST /api/me/modules/:key/enable`.

- **Default-enabled** — the `default_enabled` boolean on each
  registry entry. For v0.3.0 only `wall` is `default_enabled:
  true`; every other entry starts off. **The rule:** adding a
  module to the registry MUST NOT backfill existing users. New
  modules are off until the user enables them.

- **Cascade rules** — when a module declares `requires: [...]`,
  enabling it without the requirement flag throws
  `requires_unmet`; the caller retries with
  `{ withRequirements: true }` to cascade. Disabling a module
  with active dependents (`lists` → `chores`) throws
  `dependents_active` until `{ withDependents: true }` is
  passed.

---

## Social primitives

- **A post** — one item in a wall. Posts have a `kind` (`text`,
  `photo`, `video`, `link`), an author, a wall, a creation time,
  and optional media. Text posts are capped at 2000 characters.
  Posts are paginated 20 at a time with an explicit "Older"
  button — no infinite scroll.

- **A reaction** — an idempotent emoji toggle on a post. Five
  options: 👍 😂 🔥 👀 ❤️. Tapping the same reaction twice
  removes it; tapping a different one swaps it. The reaction
  state is a `(post_id, user_id, emoji)` row with a unique index
  — the toggle is a single SQL upsert.

- **A comment** — a flat inline reply on a post. Comments don't
  nest. They share the same author + timestamp shape as posts
  but live in `wall_comments`, not `wall_posts`.

- **A direct share** — posting to a wall that has only one other
  member, or to a wall where the poster and the recipient have a
  group of two. The UI surfaces these as "Direct" with a small
  badge so the poster knows it's not going to the whole wall.

- **A wall member** — a `(wall_id, user_id, role)` row. Roles are
  `member` (read + post), `admin` (everything + manage members),
  or `invited` (token-only, no account yet).

---

## Agent and connector surfaces

- **Hearth** *(planned)* — the planned read-API surface for
  Homestead analytics. The write path is `lib/analytics.js`
  (closed-enum `KINDS`); the read API behind PAT is referenced
  in PHA-2210 follow-ups but has not shipped. When the read API
  lands, this entry becomes canonical and `Hearth` becomes the
  user-facing surface name.

- **The socket** — the meta-agent socket (PHA-1617). The
  authenticated API surface that connected agents and CLIs use
  to drive Homestead. Three concrete layers:

  - **Personal access tokens (PATs)** — `homestead_pat_<prefix>…`
    tokens a user mints from the avatar menu → **🔌 Connected
    agents**. The plaintext is shown once at mint time; the
    server stores a bcrypt hash and a 16-char plaintext prefix
    (the prefix is in the lookup index, the rest is hashed).
    Auth header: `Authorization: Bearer homestead_pat_…`.

  - **Agent endpoints** — the routes that read or mutate on the
    user's behalf behind a PAT. The first slice is
    `GET /api/me/snapshot` (PHA-1617.3) — single-call morning
    context: profile + groups, today's tasks and events,
    upcoming week, recent activity. The same builder will back
    the future MCP tool (`homestead_get_user_context`).

  - **MCP** *(planned)* — the Model Context Protocol wrapper
    around the same endpoints. The first MCP tool name is
    `homestead_get_user_context` and it ships as the same
    payload as `/api/me/snapshot`. Not in production yet; the
    registry already declares `mcp: true` on the modules that
    will expose tools.

- **Connector Forge** — the user-facing name for the third-party
  app install path (PHA-2444 / PHA-2446). A "connector" is a
  data-only spec that declares probes (GET-only, allow-listed
  headers, DNS-rebinding-pinned) and field mappings (restricted
  JSONPath), gets validated by `lib/connector-spec.js`, then
  runs as an installation per user. The result is a
  `ConnectorInstallation` row that exposes connector surfaces
  as **registry-shaped entries** under the module key
  `connector:<spec_id>` — so a connector install shows up in the
  Meadow grid as a first-class room.

- **Connector spec** — the immutable, per-`(spec_id, revision)`
  data row that defines a connector. Schema id
  `homestead.connector/v1`. The validator rejects: unrecognised
  fields (no future-proofing via silent extras), duplicate probe
  ids, non-GET methods, request bodies, arbitrary headers,
  redirect-following, private-range bases without explicit
  local-network consent, DNS rebinding (the engine pins
  resolution at request time), and inline secrets (the
  `auth.secretRef` MUST point at a per-user key in the encrypted
  store). Strict, narrow, auditable by design.

- **BYOK** — **B**ring **Y**our **O**wn **K**ey. The Agent module
  is BYOK: the user pastes their own model-provider API key into
  the agent settings, Homestead stores it encrypted per-user, and
  requests are billed to the user's account, not Homestead's.
  That's why the agent is opt-in — the "paste your key" prompt
  doesn't gate first-run.

---

## Data substrate

- **Entity graph** — the cross-app join layer that reconciles
  external media metadata into one addressable graph. Nodes are
  `kind` + external id (`movie`, `tv_show`, `comic_series`,
  `music_artist`, `book`, `event`); edges are `kind`-scoped
  relations (`has_episode`, `directed_by`, `tagged_with`). The
  schema lives at `lib/sync/_schema.js`; per-source reconcilers
  live at `lib/sync/<source>.js`. The graph is what makes the
  cmd-k palette (`entity → deep link` searches) work.

- **`[[refs]]`** — the in-app syntax for cross-linking to an
  entity-graph node. Typing `[[The Office]]` in a post or
  comment body resolves to a deep link to that node's page. The
  parser is the same restricted JSONPath subset the connector
  specs use; it accepts a name, falls back to a search hit if
  the name doesn't match exactly, and is closed at the
  character-class level (no nested brackets, no pipe-aliased
  aliases). The render path is in `public/index.html` under the
  `PHA-1872` entity-graph marker.

---

## Operational vocabulary

- **A fresh install** — a Homestead deployment booted against an
  empty `/data/life.db` (or no `life.db` at all, with the seed
  path creating it). Fresh-install acceptance is the bar for
  every shipped feature: an operator who has just booted the
  appliance — no manual config, no out-of-band DB writes, no
  human-judged first-time grants — must reach the promised state
  via the documented UI/API surface alone. A test that needs a
  manual `INSERT` to pass is the missing feature.

- **A scratch instance** — the local server the
  `scripts/verify.sh` one-shot boots for DoD verification. Ephemeral
  `DATA_DIR`, fresh DB, real running code, real curl-able HTTP. The
  artifact directory `./verify-out/` is where the script drops
  screenshots and transcripts.

- **The seed** — the first-boot path that creates the `admin`
  user with the `ADMIN_PASSWORD` env var and provisions a single
  `wall` module for that user. Read only on first DB creation;
  changing `ADMIN_PASSWORD` afterwards does nothing.

- **A connector installation** — the per-user row in
  `connector_installations` that says "this user has this
  connector installed." Each installation owns the per-user
  encrypted secret blob in `connector_secrets`. Uninstalling
  removes the row and the secrets.

- **VAPID** — the Web Push keypair generated on first boot, stored
  at `DATA_DIR/vapid.json`, mode 0600. The **public** key is
  exposed at `GET /api/push/vapid-public-key` (no auth). The
  private key never leaves the server.

- **DoD** — the [Definition of Done](DEFINITION-OF-DONE.md). The
  standing policy for what "done" means at Homestead. The closing
  comment on every closed issue follows the WHAT / SHA / EVIDENCE
  template at the bottom of that file.

---

## What this glossary is NOT

- **Not a marketing doc.** The names here are the names a developer
  uses to find the right file. The user-facing copy follows the
  register in [`VOICE.md`](VOICE.md).
- **Not aspirational.** Each entry above is either live on
  `main`, in a merged PR, or explicitly marked *(aspirational)*
  / *(planned)*. Unmarked entries are the canonical names — the
  PR rule at the top of this file is the mechanism that keeps it
  that way.
- **Not exhaustive.** The module registry is the source of truth
  for rooms; this file gives each one a sentence. When a room
  ships, this file gets the same PR.

---

*Last verified against `main` @ `da84273` (PHA-2587 + PHA-2588 —
v0.4.3). If a term disagrees with the code, the code wins and
this file gets a follow-up PR.*
