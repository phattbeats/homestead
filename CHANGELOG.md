## v0.5.1 (2026-08-29) — Same-day closed-beta invite vertical path (PHA-2711)

The vertical path that the TODAY closed-beta tester needs: a fresh
browser can complete the entire invite-handshake without an
Authentik session or a pre-provisioned account.

**Shipped:**
- `GET /api/public/invites/:code` — public peek (no auth) returning
  wall + inviter + admin note + remaining capacity.
- `POST /api/public/invites/:code/signup` — create a fresh local
  account, atomically seed defaults + add wall membership + consume
  the invite. Single transaction; failure rolls back.
- `POST /api/public/invites/:code/signin` — claim an invite on an
  existing local account (ambiguous-401 to avoid username probing).
- `POST /api/public/invites/reset` — break-glass owner-account reset,
  consumes a sha256-hashed single-use 1-hour recovery token.
- `scripts/reset-owner-password.js` — host-side CLI to mint a reset
  token for a user (default username=brandon, --ttl 1h).
- `public/invite.html` rebuilt: Homestead intro + inviter + wall
  card, two clear choices (Create standalone / Sign in existing).
- `public/welcome.html` copy updated to mention the Porch + the
  obvious next action.
- `scripts/test-2711-invite-signup.js` — 9 direct lib tests + 12 HTTP
  route tests covering valid/invalid/expired/revoked/exhausted/
  username-collision/concurrent-redemption/sign-out-sign-in/
  reset-token round-trips.

**Implementation boundary** (per PHA-2711): the path uses the
existing `users`/`pass_hash` local-account model. It does NOT wait
for PHA-2704 — but it does write to `local_credentials` because
`identity.createUser` populates both tables in one tx, with
`users.pass_hash` shadow-synced. Future PHA-2705/2706 hardening is
additive and lossless against this data.

**Identity migration:** users.id values are permanent. The new
signup path creates a fresh users row + fresh local_credentials row
atomically — no collision against any seeded CLAIM profile because
the chosen username is validated for uniqueness before the tx.

## v0.5.0 (2026-08-29) — Identity foundation: stable users.id + local_credentials + identity_links (PHA-2704)

**The P0 invite flow depends on this.** PHA-2703 (Invite-created
standalone accounts + optional Authentik linking) unblocks three
sibling issues — PHA-2705 (invite enrollment), PHA-2706 (link
Authentik later), PHA-2708 (owner recovery) — but every one of those
needs the canonical identity model to land first. This release ships
that foundation.

The pre-PHA-2704 model crammed identity onto the `users` row:
`pass_hash`, `auth_provider`, and `provider_subject` all lived as
single-slot columns. That made the first Authentik username that
matched a seeded profile the permanent CLAIM for that row, and a
user could only have ONE external identity linked at a time. Both
constraints blocked the P0 release gate.

### What's new

- **`lib/identity.js` (new, 280 lines).** `migrate(db)` creates the
  `local_credentials` and `identity_links` tables and runs the
  additive, idempotent backfill from `users.pass_hash` /
  `users.auth_provider` / `users.provider_subject` exactly once per
  installation. The `_identity_migration_state` flag table guards
  the backfill so re-runs are no-ops.
- **`local_credentials(user_id, password_hash, recovery_token_hash,
  recovery_token_expires_at, ...)`** — one row per user (PRIMARY KEY
  is `user_id`). Replaces the deprecated `users.pass_hash` column
  for read/write; the column stays as a backward-compat shadow that
  `/api/password` syncs after every write.
- **`identity_links(user_id, provider, issuer, provider_subject,
  linked_at, last_used_at)`** — UNIQUE on `(provider, issuer,
  provider_subject)` for collision detection, FK to `users(id)`
  with `ON DELETE CASCADE`. Multiple providers per user (the new
  "link Authentik later" path requires this).
- **`identity.findUserByIdentityLink(provider, issuer, subject)`**
  — the canonical lookup. `users.username` is no longer the
  long-term link mechanism; it stays UNIQUE COLLATE NOCASE for
  backward-compat with the legacy `/api/users/:username` surface,
  but new code routes through `identity_links`.
- **`provisionOrClaim(db, username, provider, subject, groups)`**
  — re-orders to (1) identity_links match, (2) username fallback
  (transitional), (3) CREATE new user + link in one transaction.
  The username fallback upgrades the profile to an identity_links
  row on the next CLAIM so subsequent lookups skip the fallback.
- **`identity.linkIdentity` / `unlinkIdentity`** — explicit, scoped
  operations. `linkIdentity` throws `code: 'identity_collision'`
  on UNIQUE-constraint conflicts (mapped to HTTP 409). `unlinkIdentity`
  refuses to drop the last link when the user has no local
  credential (would orphan the account — mapped to HTTP 409
  `no_login_path`).
- **`identity.createUser({ username, display, plaintext, ... })`** —
  atomic CREATE for the PHA-2705 invite flow. Inserts the user row
  and (optionally) the `local_credentials` row in one transaction.
- **API surface (server.js):**
  - `GET /api/me/identities` — list the signed-in user's linked identities.
  - `POST /api/me/identities` — link a new identity (admin-only today;
    PHA-2706 will replace with the OIDC-flow version).
  - `DELETE /api/me/identities` — unlink an identity (self for own
    account; admin can target another user via `user_id` for
    collision-recovery tooling).
- **`/api/login` + `/api/password` + `/api/users/:username/password`**
  rewritten to read/write through `local_credentials`. The legacy
  `users.pass_hash` column stays in sync as a deprecated shadow so
  any pre-PHA-2704 reader still sees the value.

### Migration safety

- **Idempotent.** Every step is guarded by `IF NOT EXISTS`,
  `PRAGMA table_info` checks, or the `_identity_migration_state`
  flag table. Re-running `migrate()` on a fresh or live DB is safe
  — backfill skips itself on the second run; `users.id` values are
  never changed; memberships/history is untouched.
- **Rollback-safe.** The legacy `users.pass_hash`,
  `users.auth_provider`, and `users.provider_subject` columns are
  NOT dropped. A rollback that bypasses `lib/identity.js` still
  finds the original data on `users`. A future PHA can drop the
  legacy columns once every install is confirmed migrated.
- **Collision-safe.** `identity_links` enforces UNIQUE on
  `(provider, issuer, provider_subject)`. `linkIdentity` raises
  `code: 'identity_collision'` so the API can surface a 409 and
  the admin recovery tooling (PHA-2703 release gate) can resolve
  it.

### Tests

- **`scripts/test-2704-identity-foundation.js`** — 60 assertions
  covering schema, backfill, idempotency, identity_links-preferred
  lookup, collision rejection, multi-provider, password round-trip,
  and user_id preservation.
- **`scripts/test-2704-identity-api.js`** — 27 assertions covering
  the full HTTP surface for `/api/me/identities` (GET/POST/DELETE,
  admin-only, collision 409, orphan 409, `/api/login` regression).
- **`scripts/smoke-2704-identity-foundation.js`** — end-to-end
  smoke against a fresh-boot server, capturing the post-migration
  DB shape and the API responses into `verify-out/`.

### Sibling issues unblocked

- **PHA-2705** (Invite enrollment: explain Homestead, create
  standalone user, redeem atomically) — uses `identity.createUser`
  for the new-account path.
- **PHA-2706** (Link Authentik later: explicit secure identity
  linking and collision handling) — uses `POST /api/me/identities`
  + the OIDC flow; the `identity_collision` 409 path is already
  wired.
- **PHA-2708** (Owner recovery: local break-glass access and
  Authentik outage resilience) — uses the `local_credentials`
  row that the migration populates.

## v0.4.4 (2026-08-28) — Shared lists primitive lands + repo consolidation (PHA-2586 + PHA-2640)

**Lists is no longer a dead-end.** Every seeded user had Lists
enabled, but `GET /api/lists` returned 404 — the chip-row rendered
to placeholder copy and tapping an item was impossible. This
release lands the full shared-lists primitive:

- **`lib/lists.js` (new, 353 lines).** `lists` + `list_items`
  schema, scope-gated `read:lists` / `write:lists`, ORDER BY
  `position, created_at` on every public listing, position-tracked
  reorder, archive (soft-delete), seed-time "Groceries" list on
  fresh install, snapshot defensive `safeListsStats` for
  back-compat with older DBs.
- **`server.js`** — `/api/lists` CRUD + `/api/lists/:id/items`
  CRUD + `/api/lists/stats` + `/api/lists/reorder`. Cookie
  sessions + header-trust sessions read; app-scoped bearer tokens
  require the matching scope.
- **`public/index.html`** — Lists page renders chip-row + per-list
  item editor with add/check/delete; `+ New list` prompts for a
  name and posts; optimistic toggle with rollback on server
  failure.
- **`scripts/test-lists.js` (new, 70 assertions).** Schema +
  seed + CRUD + position-reorder + archive + cascade + snapshot
  defensive; no out-of-band SQLite writes.
- **`scripts/test-registry-no-hardcoded-keys.js`** — allow-list
  entries for `lib/lists.js` (table namespace) + `lib/snapshot.js`
  (sqlite_master lookup) so the audit doesn't flag the new
  primitive.
- **`scripts/test-snapshot.js`** — `out.lists` is now an envelope
  (`{list_count, open_item_count, active_lists}`), not `{}`.
- **`scripts/smoke-2586-lists-ui.js` (new)** — fresh-install
  journey: a household user opens Lists on mobile (390×844), adds
  an item, screenshot lands in `verify-out/`. Wired into
  `verify.sh` step 6/7 and `.github/workflows/test.yml` as the
  PHA-2586 acceptance smoke.
- **`README.md`** — Shared lists now documented as a first-class
  feature.
- **`package.json`** — `test` chain gains `scripts/test-lists.js`
  adjacent to `test-walls.js` (PHA-2209 Amendment-3 ordering).
  Version bump `0.4.3 → 0.4.4`.

**Repo consolidation (PHA-2640).** Closed the last open PR
(#76 lists primitive) and pruned 49 stale branches from `origin`
whose owning issues were already `done`. Local clones no longer
see pre-v0.3 release archaeology; the kept set is the active v0.3
modular stack and recent in-flight work.

# Changelog

## v0.4.3 (2026-08-25) — Layout-route contract repair (PHA-2587 + PHA-2588)

`GET /api/me/layout` used to emit `/lists.html`, `/calendar.html`,
`/chores.html`, `/apps.html`, `/onboarding.html` as `route` values —
pages that have never existed since the SPA swallow took over. After
PHA-2557's static-handler tightening (`fallthrough:false`), each of
those URLs now 404s on a fresh install. Clients that honor
`layout.route` (deep links, third-party agents, the help index) hit a
dead end. The SPA itself navigates via `room`/`data-p` so in-app tabs
were never broken, but the contract leak was real.

This release fixes both halves:

- **`lib/modules.js`** — every built-in entry now carries an explicit
  `route` field. Only `wall` (`route:'/porch.html'`) is advertised;
  the other five SPA-only modules emit `route:null`. `getRoomRoute`
  reads `route` instead of `url` so advertised deep links name a
  real standalone document, never a synthetic `url`.
- **`server.js`** — `/api/health` no longer reports `ok:false` on a
  fresh install when `CALENDAR_CRED_KEY` isn't generated. The health
  checker treats `calendarCredKeyReady === false` as a non-fatal
  "unconfigured" state; the underlying credential is generated on
  first calendar authorize, so missing it on a brand-new box is
  expected and not a service-down signal.
- **`scripts/test-2587-layout-route-contract.js` (new).** 17
  assertions: boots a fresh server, ensures all 6 modules enabled,
  GETs `/api/me/layout`, asserts `defaultRoute` and every
  `tabs[].route` / `pages[].route` is either `/porch.html` or
  `null`, probes each advertised route for 200, then disables
  every module and asserts the empty layout's `defaultRoute` is
  `null` (not `/onboarding.html`). Wired into the `npm test` chain
  adjacent to `test-modular-layout` and `test-2588-health-default`.

### Acceptance coverage (PHA-2587 / PHA-2588 issue bodies)

- **No layout.route 404s on a fresh install.** SPA tabs still work.
- **`/api/health` returns `ok:true`** without a calendar key on
  day-zero installs; the `service.calendarCredKeyReady` boolean
  remains visible for ops dashboards.

EOF
## v0.4.2 (2026-08-23) — Connector Forge surface adapters (PHA-2447)

Wires the four fixed output adapters the engine (PHA-2445) calls into
the persistent stores. Reuses existing engines where they exist
(entity graph via `lib/sync/_schema.js`, wall/feed via `lib/walls.js`)
and adds the missing ones (per-installation tile health, room-card
cache, feed dedupe ledger). Adds a closed-grammar brace-placeholder
resolver (`lib/connector-placeholder.js`) so spec surfaces can render
simple `{name}` strings against named extracted fields without opening
the floodgates to a general template language.

- **`lib/connector-surfaces.js` (new).** `createAdapters(db)` returns
  `{tile, card, entities, feed}` — the four async functions the
  engine's `writeSurfaces()` calls. Each adapter is idempotent
  (re-runs with identical payloads are no-ops), validates its input
  shape, and writes only redacted error messages to operator-facing
  surfaces. Migration: three new tables — `connector_tile_health_state`
  (per-installation health row mirroring `service_health_state`),
  `connector_card_cache` (per-installation field map + summary text),
  `connector_feed_events` (PK `(installation_id, event_fingerprint)`
  dedupe ledger). Migration is chained from `connector-install.migrate`
  so a single boot point installs everything.
- **`lib/connector-placeholder.js` (new).** Closed-grammar resolver:
  `{name}` only, identifier shape `[A-Za-z_][A-Za-z0-9_]{0,63}`,
  no `$` inside the brace body, no `{{...}}` / nested braces, no method
  calls, no expressions. Anything else throws `PlaceholderGrammarError`.
  The card adapter uses it for `summary_text`; the feed adapter uses
  it for wall-post bodies.
- **`scripts/test-connector-surfaces.js` (new).** 52 assertions
  covering all five acceptance bullets plus the placeholder grammar
  contract. Wired into the `npm test` chain (52/52 pass).

### Acceptance coverage (PHA-2447 issue body)

- **Tile updates within 1 poll cycle on state change.** `tile_json` +
  `last_ok_at` refresh on every cycle; classification covers
  healthy/degraded/down + string statuses (`healthy`/`degraded`/`error`).
- **Card renders with extracted summary fields.** `card.cache_json`
  preserves the full field map; `summary_text` is precomputed via the
  closed-grammar resolver against the default
  `"{count} {label} · {recent_added} added this week"` template.
- **Entity graph upsert creates comic_series nodes + available_at
  edges + deep links.** Reuses `entities` + `entity_edges` tables from
  PHA-1624. Each installation also gets a `connector_installation`
  entity so edges have a stable `from_id`.
- **Feed event emitted exactly once per
  `(installation_id, event_fingerprint)`.** Dedupe ledger gates every
  `wall_posts` INSERT. The dispatcher (`lib/notifications.js`) reads
  `wall_notification_prefs` per recipient, so we don't bypass it.
- **Adapters reject unknown surface types in the spec validator.**
  Locked in by PHA-2444 (`ALLOWED_SURFACES_FIELDS = ['tile','card','entities','feed']`);
  covered in test 5.

EOF
## v0.4.1 (2026-08-21) — Events webhook outbound dispatcher (PHA-1900 / PHA-1617.7)

Design doc §6.1/6.5. Depends on PHA-1617.4 (`agent_endpoints`, already
shipped) and reuses the exact HTTP/retry/circuit-breaker mechanics
from the drawer dispatcher (PHA-1617.6/PHA-1899) via
`drawerDispatch.httpPostOnce` so both dispatchers share one HTTP/SSE/
JSON parser and can't drift.

- **`lib/events-dispatch.js` (new).** Fans a household event out to
  every enabled `kind='events'` `agent_endpoints` row for the target
  user(s), gated by that endpoint's `event_filter` — opt-in only, a
  missing/falsy key means the endpoint does NOT receive that category
  (matches the `{task_created: true, chore_rotated: true}` example in
  `lib/agent-endpoints.js`'s §6.1 comment). Same signed-header shape
  as the drawer (`X-Homestead-User/-Request-Id/-Timestamp/-Signature`,
  `sha256=HMAC_SHA256(secret, ts + "." + body)`), plus
  `X-Homestead-Event-Category`. Same retry schedule (1s/4s/16s/60s,
  4 retries) and circuit breaker (5 consecutive failures →
  `enabled=0`), tracked in a **separate** in-memory streak map
  (`app.locals.eventsStreakMap`) so a dead events harness and a dead
  drawer harness on the same box trip independently.
- **Fire-and-forget, unlike the drawer.** The drawer is a synchronous
  chat reply the browser is waiting on; events dispatch is a
  background fan-out nothing is waiting on. Route handlers call
  `dispatchEvent`/`dispatchEventForAssignee` without awaiting — a dead
  events harness never turns into a slow or failed task/chore/event/
  push response.
- **Wired at four lifecycle points:** `POST /api/tasks` →
  `task_created`; `POST /api/tasks/:id/toggle` → `chore_rotated` (to
  the **new** assignee, for a recurring+rotating task) or
  `task_completed`/`task_uncompleted` (plain toggle); `POST
  /api/events` → `event_created`; every attempted `notify()` delivery
  (the existing web-push chokepoint used by chore digests, mentions,
  wall posts, etc.) → `push`, carrying the underlying push category,
  title/body/url/tag and delivered/error counts.
- **Assignee/owner fan-out.** `'all'` resolves to every household user
  (each gets their own dispatch, scoped to their own endpoints); a
  specific username resolves to just that user.
- Tests: `scripts/test-events-dispatcher.js` (39 assertions) — module
  surface, HMAC signing, category opt-in gating, all four trigger
  points end-to-end through the live routes (polling past the
  fire-and-forget boundary), retry/backoff, and circuit-breaker
  auto-disable independent of the drawer's streak map.

## v0.4.0 (2026-08-21) — Notification granularity + @mentions (PHA-2218)

Sequenced after v0.3.0's module work (PHA-2202/PHA-2203) so wall
membership and module gating were stable underneath it. Design doc
(schema + resolution + bundling rules) posted and approved on the
PHA-2218 issue before implementation started.

- **Per-wall notification level.** New `wall_notification_prefs
  (wall_id, user_id, level, via)` table — `level` is `all` |
  `mentions` | `none`, composite PK, UPSERT via
  `PUT /api/walls/:slug/notifications`. Replaces the implicit
  `wall_memberships.notifications` boolean (left in place,
  deprecated) as the actual gate. Default for a genuinely new join is
  `mentions`; a one-time backfill preserves today's behavior for
  every member who already existed when this migration ran (direct
  walls: `notifications=1/0` → `all`/`none`; group walls: everyone
  backfilled to `all`, since they never had an opt-out before).
- **`@mentions`.** New `mentions(post_id XOR comment_id,
  mentioned_user_id, mentioned_by)` table, inserted atomically with
  the post/comment it belongs to. Parsing is wall-scoped only — you
  cannot `@mention` someone who isn't a member; non-member and
  self-mentions are silently dropped, no error toast. A mention
  notification fires regardless of `all`/`mentions` level; only
  `none` or the recipient's own quiet hours suppress it. Composer
  autocomplete and `@handle` → member-link rendering ship in
  `public/porch.js`.
- **Per-thread mute.** New `thread_mutes(user_id, post_id)` table.
  `POST`/`DELETE /api/walls/:slug/posts/:postId/mute`. Mute always
  wins — it overrides even a `mentions`-level match, on the theory
  that the user explicitly asked to stop hearing about this one
  thread.
- **Resolver (`lib/notifications.js`, new).** `resolve()` composes
  level → thread mute → quiet hours (PHA-1619), in that order —
  level decides *if*, quiet hours decide *when*. A quiet-hours skip
  still leaves an audit row (`delivered=0, skipped_reason
  ='quiet_hours'`) so nothing is silently lost, it just doesn't push.
  `lib/walls.js`'s old `emitActivity` (flat per-recipient INSERT, no
  gating at all) is replaced by resolver-driven `emitForPost` /
  `emitForComment`.
- **Bundling.** N wall posts within a 15-minute window
  (`BUNDLE_WINDOW_MS`) collapse into one `notification_log` row
  ("3 new posts on Memes") instead of one push per post. Mentions and
  posts on `direct`-visibility walls never bundle — the act of
  addressing someone is its own trigger, distinct from ambient
  activity.
- **Badge-clearing (PHA-1617 promise).** `notification_log.seen_at`
  (additive column). Three clear paths: opening the push target
  (service worker's `notificationclick` now posts to
  `/api/me/notifications/seen`), the activity feed's bulk clear
  (`{clearAll:true}`), and a natural 30-day-old data footprint. New
  `GET /api/me/notifications` (`?unseen=1` for the badge view,
  distinct from the unfiltered `/api/me/snapshot` dashboard feed).
- **Routes.** `GET /api/walls/:slug/members` (autocomplete source),
  `GET`/`PUT /api/walls/:slug/notifications`, `POST`/`DELETE
  /api/walls/:slug/posts/:postId/mute`, `GET /api/me/notifications`,
  `POST /api/me/notifications/seen`.
- **Frontend.** `public/porch.js`: `@` composer autocomplete over
  wall members, `@handle` rendered as a member link in posts and
  comments, a per-wall notification-level selector on the wall
  header itself (not buried in global settings), a per-post
  mute/unmute toggle next to the comments control.
- **Tests.** `scripts/test-notifications-resolver.js` (24
  assertions — level gating, mute override, quiet-hours composition,
  the default-window fallback), `scripts/test-mentions-parser.js`
  (21 — wall-scoping, self/non-member drop, dedup, the mentions CHECK
  constraint, an end-to-end pass through `walls.createPost`/
  `createComment`), `scripts/test-thread-mutes.js` (11 — persistence,
  idempotence, CASCADE on post delete, no self-suppression),
  `scripts/smoke-notifications.js` (25 — full HTTP surface against a
  booted server). `scripts/test-walls.js` grows two assertions
  confirming the new default doesn't silently demote an already-`all`
  member and does correctly gate a fresh joiner without a mention.


## v0.3.0 (2026-08-21) — Modular Homestead: user_modules + module registry + invite-to-wall (PHA-2202, PHA-2203, PHA-2204, PHA-2207, PHA-2209)

### Module registry (PHA-2203 / PHA-2200.2)

- **Static module registry.** New `lib/modules.js` exports
  `REGISTRY` (six built-in entries: `wall`, `lists`, `calendar`,
  `chores`, `apps`, `agent`) plus `DEFAULT_ENABLED = ['wall']`.
  Every entry carries the full 16-field PHA-2201 manifest contract
  (`key, name, description, icon, room, requires, tier, version,
  author, url, open_mode, scopes, mcp, webhooks, entity_kinds,
  default_enabled`). Third-party apps merge into the same shape via
  the PHA-2201 install flow — built-ins dogfood the same contract.
  Pure data, no DB access, no plugin loader. Frozen at module load
  so a bug can't silently extend the whitelist.
- **`lib/registry-validate.js`** — runtime sanity check. Validates
  every entry against the manifest contract (field names + types),
  every `requires[]` ref points to a registered key, `DEFAULT_ENABLED`
  references are valid, and the registry's keys are a subset of the
  `user_modules` CHECK constraint. Throws on the first drift; warns
  on legacy CHECK-only keys (informational, not fatal).
- **`getEnabledModules(db, userId)`** in `lib/user-model.js` joins
  `user_modules` against the registry and returns the enabled set in
  `REGISTRY_ORDER`, with `enabled_at` appended. Unknown /
  legacy module_key rows are silently skipped so the API surface
  only sees registered modules.
- **Helpers.** `getModule(key)`, `getRoomRoute(key)`,
  `getDefaultEnabled()`, `isModuleKey(key)`, `listModules()`,
  `getDefaultEnabledModules()` all live in `lib/modules.js` or
  `lib/user-model.js`. `USER_MODULE_KEYS` / `isUserModuleKey` in
  `user-model.js` now delegate to the registry so the CHECK
  constraint, the whitelist, and the helpers cannot drift.
- **Tests.** `scripts/test-modules.js` covers 81 assertions: six
  built-ins present, `DEFAULT_ENABLED === ['wall']`, manifest
  shape validator catches drift in 6 directions, `requires[]`
  references, registry order, `getEnabledModules` ordering +
  skip-unknown, helper purity (mutation isolation), live
  `validateAndThrow` against the live DB.

### Per-user module enablement (PHA-2202)

- **Per-user module enablement.** New `user_modules(user_id, module_key,
  enabled_at)` table with `(user_id, module_key)` PK and FK cascade on
  user delete. CHECK constraint enforces the canonical module whitelist
  (`wall`, `lists`, `calendar`, `chores`, `apps`, `agent`). `enabled_at
  NULL` = disabled, timestamp = enabled. Toggle is `UPDATE
  user_modules SET enabled_at = ...`; rows are never deleted, so
  disabling the `chores` module does NOT wipe the `tasks` rows that
  chores wrote. Idempotent backfill runs on every boot and uses
  `INSERT OR IGNORE` so user-toggled state is preserved across
  re-migrations.
- **API helpers.** `lib/user-model.js` exports `USER_MODULE_KEYS`,
  `isUserModuleKey(key)`, `getUserModules(db, userId)` (returns full
  keyed map), and `setUserModule(db, userId, key, enabled)` (upsert
  via `INSERT ... ON CONFLICT DO UPDATE`). The HTTP surface
  (`/api/me/modules`, `/api/me/layout`) lands in PHA-2200.3.
- **Tests.** `scripts/test-user-modules.js` covers 44 assertions:
  schema creation, index, backfill row count = users * 6, idempotent
  re-migration, disable+re-enable preserves data tables (tasks /
  events), unknown module_key rejection in JS + by CHECK constraint,
  new user picked up on next boot, deterministic
  `getUserModules` shape, `ON DELETE CASCADE` purge.
- **Schema note.** The PHA-2202 spec uses the `VALUES (...) AS
  alias(col)` syntax from the issue body; the runtime uses the
  equivalent portable `SELECT ... UNION ALL` subquery because the
  better-sqlite3 prebuilt ships a SQLite build that does not accept
  `VALUES (...) AS alias` via `db.exec`. Semantically identical,
  supported on every SQLite since 3.7.

### Settings → Apps UI (PHA-2201.4 / PHA-2232)

- **Apps list, per-app detail, revoke, install — the user-facing
  surface for the whole install/consent/revoke contract.** Avatar menu
  → **📦 Apps** opens the new Settings → Apps sheet.
- **Unified apps list.** `lib/app-install.js`'s `listApps()`/`getApp()`
  now merge BOTH halves of the PHA-2201 dogfood contract through the
  same read path: enabled built-in modules (`user_modules`, tagged
  `builtin: true`) and active third-party installs (`agent_tokens.app_id`,
  tagged `builtin: false`). `getApp()` also returns `entity_kinds` so
  the client can describe generic entity-CRUD scopes (`read:{kind}`)
  without a second lookup.
- **Per-app detail** renders "what this app can do" via the shared
  `lib/scope-display.js` mapping (PHA-2230) and, for third-party apps,
  a paginated **Activity** view over real `app_api_log` rows
  (PHA-2231, `GET /api/apps/:key/activity`, "Load more" accumulates
  pages). Built-ins show neither Activity nor Revoke — they have no
  app-scoped token to log or kill; the UI states this rather than
  hitting an endpoint that would 404.
- **Revoke is one action.** The detail sheet's Revoke button calls
  `POST /api/apps/:key/revoke` directly — no separate disable step —
  and returns to the (now tile-free) Apps list on success.
- **Install flow** (paste manifest URL → resolve → consent → install)
  reuses the PHA-2230 consent screen's `window.HomesteadConsent.
  renderConsentScreen` verbatim, embedded in a Settings sheet instead
  of standalone `consent.html` — same copy, same scope mapping, no
  reimplementation. `public/consent.js`'s demo `boot()` gained a guard
  (`if (!document.getElementById('demoBanner')) return;`) so it's safe
  to load as a shared script on a page (`index.html`) that also has an
  `id="app"` root. The freshly-minted app token is shown once via the
  existing copy-once reveal modal (PHA-1617.3 pattern).
- **`lib/scope-display.js` gained `read:services`** (the `apps`
  built-in's scope per design note §6) — an existing vocabulary gap
  that only surfaced once built-ins started rendering through this
  same mapping.
- **Tests.** `scripts/smoke-apps-settings-ui.js` (new, wired into
  `npm run test:smoke`): source assertions that the SPA wires up every
  acceptance-listed sheet/call, plus a live HTTP round trip — built-in
  present in `GET /api/apps` pre-install, resolve → consent → install,
  both builtin + third-party rows post-install, scopes describable,
  a real app-token call produces a real `app_api_log` row the activity
  view renders, revoke removes the tile, and the same token gets 401
  on its very next call, all within one run.


### Invite-to-wall flow (PHA-2207 / PHA-2200.6)

- **`lib/invites.js`** — new module. `invites` table
  (`id`, `wall_slug`, `created_by`, `created_at`, `expires_at`,
  `redeemed_by`, `redeemed_at`, `note`); the `id` IS the redemption
  code (32 hex chars from `crypto.randomUUID()` sans dashes).
  Helpers: `create`, `peek`, `redeem`, `list`. `peek` enforces
  expiry/redeemed checks (410 on either); `redeem` is the canonical
  CREATE-or-CLAIM-and-enroll path that writes wall_memberships +
  stamps the invite atomically inside a transaction.
- **`lib/wall-members.js`** — new module. `addMember(db, slug, userId, role)` is
  INSERT-OR-IGNORE on the existing `wall_memberships` table (the
  schema name is `wall_memberships`, not `wall_members` as the issue
  body says; spec drift documented inline). `ensureMember` reconciles
  the user's `user_groups` set to include the wall's `group_name`
  for group-visibility walls so `walls.assertMember` +
  `walls.listForUser` see the new user after invite redemption.
  `getMembers` returns the full profile rows for the welcome-sheet
  avatar stack.
- **`POST /api/invites`** (admin only) — body
  `{wall_slug, expires_in_days?, note?}`. `wall_slug` is REQUIRED:
  a missing `wall_slug` returns 400 with a hint referencing PHA-1575
  (the wall-less legacy path). `expires_in_days` defaults to 7,
  max 90. Response carries `url: https://life.phatt.vip/invite/{code}`.
- **`GET /api/invites`** (admin only) — outstanding invites by
  default; `?include_redeemed=1` to include redeemed.
- **`POST /api/invites/:code/redeem`** — authed user redeems. Atomic
  transaction: `ensureMember` (wall_memberships + group reconciliation)
  + invite stamp. Returns `{wall_slug, wall_name, first_run, redirect,
  members}` so the SPA can render the welcome sheet without a
  second round-trip. 410 on expired or already-redeemed; 404 on
  unknown code.
- **`POST /api/me/first-run-complete`** — stamps
  `first_run_completed_at = datetime('now')`. Idempotent. Called by
  `public/welcome.html` on dismiss.
- **`GET /api/walls/:slug/members`** — used by the welcome sheet to
  render the member avatar stack. Same membership gate as the rest
  of `/api/walls/*` (`assertMember`).
- **`public/welcome.html`** — the welcome sheet. Single screen: wall
  name + member avatars + "Open the feed →" CTA that POSTs
  `/api/me/first-run-complete` then navigates to
  `/porch.html?wall=<slug>`. Existing users (first_run: false) skip
  straight to the feed.
- **`public/invite.html`** — the redemption page served at
  `/invite/:code`. Bounces unauthenticated users to `/api/login`,
  POSTs `/api/invites/:code/redeem`, and renders the wall card +
  "Join this wall" CTA on success.
- **Header-trust group union** — `provisionOrClaim` is now invoked
  with `X-authentik-groups ∪ {group_names from group-visibility
  wall_memberships}`. Without this, the very next authenticated
  request would call `reconcileGroups` and wipe the media-club
  group that the invite just granted. Documented inline.
- **Tests.** `scripts/test-invite-to-wall.js` covers 50 assertions:
  admin-only create, wall_slug required (legacy PHA-1575 → 400),
  valid create returns 201 + URL, redemption grants membership +
  first_run state, already-redeemed → 410, unknown code → 404,
  `first-run-complete` is idempotent, existing-user redemption
  preserves first_run: false, members endpoint gated by
  assertMember, invalid wall_slug / bad expires_in_days, no-auth
  redeem → 401.

### Acceptance suite + release (PHA-2209 / PHA-2200.8)

Six new acceptance scripts gate the v0.3.0 release. They cover the
three amendments from comments `1afbe170` + `04093be5` and the
acceptance criteria rolled up from PHA-2200 design-note §7.

- **`scripts/test-modular-layout.js`** — synthetic-user HTTP suite.
  Boots server.js on `:3192` and exercises the three layout shapes
  (`empty` / `feed-only` / `feed-tabs` / `meadow`) plus the welcome
  sheet (`first_run` lifecycle, PHA-2200.6), the agent-drawer flag
  (PHA-2200.7), the `+ Add rooms` pill (`addRoomVisible`), and the
  tab/page shape contract that the SPA bootstrap relies on. 63
  assertions.
- **`scripts/test-disable-reenable.js`** — empty-state acceptance
  (AC8): enable a non-default module (Calendar), see the tab,
  disable, tab disappears with the `user_modules` row preserved
  (data intact), re-enable, tab returns. Also covers the four
  layout modes by enabled-set size and the `addRoomVisible` /
  `agentDrawer` flag transitions. 41 assertions.
- **`scripts/test-requires-cascade.js`** — enable/disable cascade
  (AC5). `enableModule(chores, { withRequirements: true })` also
  writes `lists`; `disableModule(lists, { withDependents: true })`
  also clears `chores`. Without the cascade flag, the call throws
  `requires_unmet` / `dependents_active` with the unmet/dependent
  list. Idempotency + unknown-key rejection covered. 25 assertions.
- **`scripts/test-default-off-future.js`** — Amendment 2 (default
  OFF for future first-party modules). Simulates adding a 7th
  module (`recipes`) to the registry without backfilling existing
  users. Asserts new users still see `{wall}` only, existing users'
  enabled sets are unaffected, the DB row is preserved with data
  intact (invisible until the registry knows about the key), and
  no per-module INSERT-backfill appears in `lib/user-model.js`
  migration text (the v3 cross-join is the only place that
  writes user_modules en masse). 16 assertions.
- **`scripts/test-shared-registry-third-party.js`** — Amendment 1
  (registry is the shared intake path). Built-in entries and a
  representative third-party-shaped entry (`popcorn_vote` per
  PHA-2201 manifest contract) both pass `validateEntryShape`.
  Deliberately malformed third-party entries fail. Verifies the
  16-field manifest contract and that the validator treats both
  shapes symmetrically. 37 assertions.
- **`scripts/test-registry-no-hardcoded-keys.js`** — Amendment 3
  (no hardcoded module-key literals in render code). Greps the
  repo for `'wall'` / `'lists'` / `'calendar'` / `'chores'` /
  `'apps'` / `'agent'` literals outside the registry + migrations
  + test files. Strips comments before scanning and excludes
  object-property-key positions. Allow-list covers the four
  known-benign namespace collisions (`welcome.html` URL param,
  `caldav-source.js` CalDAV XML element, `index.html` drawer
  stream-author, snapshot envelope categories). 11 assertions.

### Version bump

- `package.json` — bumped to `0.3.0` (from `0.3.0-invite-2207`).
  The pre-release `-invite-2207` suffix was a work-in-progress
  tag; v0.3.0 is the stable release.

### Test chain wiring

- `package.json` `scripts.test` — the six new tests are inserted
  after the v0.3.0 component tests (`test-user-modules`,
  `test-modules`, `test-modules-api`, `test-invite-to-wall`) and
  before the pre-v0.3.0 component tests. Running
  `npm test` now exercises the full v0.3.0 acceptance surface.


### Third-party app install flow (PHA-2201.1 / PHA-2229)

- **Six endpoints**, the server-side state machine from the PHA-2201
  design note §2/§7: `POST /api/apps/resolve`, `POST
  /api/apps/consent`, `POST /api/apps/install`, `GET /api/apps`, `GET
  /api/apps/:key`, `POST /api/apps/:key/revoke`, `POST
  /api/apps/:key/reinstall`. New `lib/app-install.js` (pure DB/business
  logic, no express) backs all six; `server.js` handlers are auth +
  status-code mapping only.
- **`resolve` never writes to the DB** (verified by the acceptance
  suite) — it fetches a manifest URL (in-memory cache, keyed by URL,
  ETag revalidation, 5-minute TTL), validates its shape via
  `lib/registry-validate.js`'s `validateEntryShape` and its `scopes[]`
  against `lib/scope-display.js`'s §3 vocabulary — reusing both, not
  forking — and rejects built-in-key collisions (`409
  manifest_key_conflict`, e.g. a manifest claiming `key: "wall"`).
  Unknown scopes fail with the valid vocabulary listed in the error.
- **URL security.** Third-party `url` (the manifest fetch target and
  the manifest's own iframe/tab target) must be `https://` with a
  non-loopback host; `dev: true` on the request body — never a
  manifest property — relaxes this for pointing Homestead at a
  locally-running app under development.
- **Consent tokens.** 60s TTL, single-use, bound to `(user,
  manifest_url)`, backed by a new `app_consent_tokens` table
  (sha256-hashed, not bcrypt — a 60-second exchange token doesn't need
  bcrypt's offline-brute-force cost). The manifest is snapshotted onto
  the token at consent time so install commits exactly what was shown
  on the consent screen even if the remote manifest changes in the
  intervening window.
- **Install is one transaction**: consumes the consent token,
  inserts/reactivates the shared `installed_apps` row (keyed
  household-wide, not per-user — a second household member installing
  the same app reuses the existing row instead of re-inserting),
  mints an app-scoped PAT (`agent_tokens.app_id`, scopes from the
  consented manifest) via `agentTokens.issue()`'s new `appId` param,
  and enables the `apps` launcher module for the installing user
  (`user_modules` is CHECK-constrained to the six built-in keys —
  third-party apps launch from the existing `apps` tiled launcher,
  PHA-1863, rather than minting their own `user_modules` row). Any
  failure rolls back everything, including the consent-token
  consumption.
- **Revoke** soft-deletes this user's app-scoped token(s) (immediate
  401 on their next call), disables `apps` for them if it was their
  last third-party app, and archives the shared `installed_apps` row
  once no household member holds an active token for it — "remove the
  tile" without disturbing another member's install of the same app.
  **Reinstall** mints a fresh token with the same scopes for a user
  with prior install history, without repeating consent.
- **Tests.** `scripts/test-app-install.js` covers 64 assertions across
  direct calls (resolve DB-purity, shape/scope/URL rejections,
  built-in collision, full consent+install lifecycle, shared-app
  multi-user semantics, revoke/reinstall, manifest caching) and one
  end-to-end HTTP round trip against a live `server.js` (resolve ->
  consent -> install -> tile appears in `GET /api/apps` -> token
  authenticates a real call -> revoke -> 401 on the very next call).

### Scope enforcement + Popcorn Vote dogfood (PHA-2052)

- **Scope enforcement was missing.** Bearer app tokens minted by the
  PHA-2201 install flow carried scopes, but no route ever checked
  them — `authenticate()` synthesized the same full-access
  `session.user` for an app token as for the underlying household
  member. New `requireScope(scope)` / `requireWallReadScope`
  middleware in `server.js`, applied to `GET`/`POST
  /api/walls/:slug/posts`, actually enforces `read:walls[:slug]` and
  `write:walls:post` against the token's granted scopes; unscoped
  session/header-trust auth and legacy `scopes:'user'` PATs are
  unaffected.
- **Popcorn Vote** is the first third-party app proven end-to-end
  through the PHA-2201 contract: a deliberately small manifest
  (`read:walls:media_club`, `write:walls:post`), posting link-kind
  announcements to `media-club` that ride the existing
  `wall_posts` → `notification_log` pipeline. `scripts/test-pa-2201-install.js`
  (29 assertions) proves both the positive case (can read media-club)
  and the negative case (cannot read a wall the underlying human
  belongs to but the token was never granted) working as designed.

### Wall feed component extraction (PHA-2206 / PHA-2200.5)

The full wall feed surface (composer, post list, reactions,
comments, "Older" pagination) was a single-page IIFE in
`public/porch.js` shipped by PHA-2151. With the v0.3.0 dual-surface
design (PHA-2200 §6 — Porch is a standalone page when the wall
module is the user's only enabled room, AND an in-place tab inside
the meadow/feed-tabs SPA when other modules are also enabled) the
same JS needs to render in two placements without a rewrite.

- **`public/components/feed.js`** (new) — the extracted component,
  a 27.8 KB IIFE exposing `window.HomesteadFeed.mount(target, opts)`
  + `window.HomesteadFeed.unmount(target)`. Per-instance state
  (ME, WALLS, WALL, POSTS, CURSOR, …) lives in the closure so two
  simultaneous mounts don't collide. Permission gates
  (`canPost` / `canReact` / `canComment`) are honored by hiding the
  affected UI rather than blocking the mount. Idempotent re-mount:
  mounting into an already-mounted target disposes the prior
  instance first. `dispose()` aborts in-flight fetches via
  AbortController and removes every registered event listener.
  Test-only helpers are exported under `module.exports` so the
  vm-sandbox tests can exercise them without a DOM.
- **`public/porch.html`** (refactored) — now a thin shell. Drops
  the inline `porch.js` script tag and the inline composer/feed
  markup; instead loads `/components/feed.js` and calls
  `HomesteadFeed.mount(document.getElementById('porch-mount'), …)`
  on `DOMContentLoaded`. Chrome (header, back link, wall picker)
  moved into the component so both placements render identically.
- **`public/index.html`** (extended) — adds a `<div class="page"
  id="page-porch"></div>` page container and a new
  `<button data-p="porch" id="navWall" style="display:none">Porch</button>`
  nav tile. On `boot()`, the SPA fetches `/api/me/modules` and
  `/api/modules`, finds the enabled module whose `room === 'porch'`
  discriminator matches the wall entry, and mounts
  `HomesteadFeed.mount(page-porch)` in-place. Single-surface rule:
  if the feed module is the user's ONLY enabled module, the SPA
  redirects to `/porch.html` instead of mounting (per PHA-2200 §6).
  The literal 'wall' / 'porch' module key is NOT hardcoded — the
  mount discriminator is the registry's `room` field, keeping
  PHA-2209's no-hardcoded-keys audit (Amendment 3) green.
- **`public/porch.js`** (removed) — logic moved into
  `public/components/feed.js`. The script tag in `porch.html` now
  points at the component.
- **`public/sw.js`** (extended) — adds a minimal precache list
  (`/components/feed.js`, `/porch.css`) with cache-first fetch +
  best-effort `cache.addAll` install. The push handler and
  notificationclick logic are unchanged. Returning PWA users on
  intermittent connectivity now see the Porch without an empty
  white flash.
- **`scripts/test-feed-component.js`** (new) — 71-assertion
  acceptance suite. Three sections: static-asset shape (component
  exists, exports the contract, both placements reference it, no
  duplicate API calls), pure-helper unit tests via `vm.runInContext`
  on the inlined helpers (esc, cssEsc, fmtTime, postMediaHtml,
  reactionsHtml, postHtml — XSS escape matrix + author/count/pending
  branches), and live end-to-end (boot server.js, fetch the
  component file, exercise the wall/comment/reaction API both
  placements consume). Inserted into `npm test` chain after the
  registry-no-hardcoded-keys audit and before the pre-v0.3.0
  component tests (per PHA-2209 lesson #4).
- **`scripts/smoke-porch-ui.js`** (updated) — replaces the
  `porch.js` references with `components/feed.js`; asserts both
  placements load the same component URL and reference the same
  endpoints. Now also verifies `GET /components/feed.js` returns
  200 (shared static asset) and that the served `/index.html`
  carries the `#page-porch` mount target.

## v0.2.0 (2026-08-19) — Porch Wall (PHA-2147)

- **Media storage primitive.** Content-addressed uploads at `/data/media/...`,
  server-side sharp downscale + 320px thumbnail generation, configurable
  retention per upload, sweep job on the existing 30-min scheduler.
- **Walls, posts, reactions, comments.** Group-scoped (media-club,
  household) and direct-share walls. Membership gate at the auth layer;
  strictly chronological feed; constitutional: no ranking, no discovery,
  no strangers. Emoji reactions toggle idempotently; flat comment threads.
- **Porch UI.** `public/porch.html` + `porch.{css,js}` + top-bar entry.
  Drag-drop / paste-from-clipboard composer, 5-emoji reaction row,
  paginated Older button (no infinite scroll), mobile-first.

## v0.1.22 (2026-08-21) — PHA-2219

- **PWA install coach (option A only).** First-login flow that
  closes the install-friction gap on the PWA path. Decided against
  native wrapper (option B) and full native clients (option C) per
  Brandon's 2026-08-19 call: no Apple Developer account, no Play
  Console, no mobile release pipeline. Reopens only if the
  analytics funnel shows real friends stalling at the install step.
- **Install detection (`isInstalled()`).** Recognises iOS Safari
  `navigator.standalone`, Android Chrome `display-mode: standalone`,
  and the desktop `fullscreen` / `minimal-ui` variants via
  `window.matchMedia`. Returns false in a normal browser tab so
  the coach never fires on an installed-and-happy user (rule #5).
- **Platform-classified instructions.** The coach sheet shows a
  card with an inline SVG visual plus a numbered <ol> tailored to
  the platform: iOS Safari (Share → Add to Home Screen),
  Android Chrome (menu → Install app), or a generic paragraph that
  points at the avatar-menu chip for desktop/unknown (rule #1).
- **One-line WHY copy.** Headline explains that notifications only
  work once the app is installed — the literal truth on iOS and
  the only argument that lands (rule #2).
- **Deferred, not dismissed-forever.** A dismiss flips a
  `localStorage` flag; the coach then lives behind a small,
  quiet "Set up notifications" chip in the avatar menu (rule #3).
  The chip only renders when not installed AND
  `Notification.permission !== 'granted'` — no nagging.
- **No permission prompt from the coach.** The coach sheet does
  not call `Notification.requestPermission()`. Permission is
  requested only by the existing avatar-menu push button after
  install AND after the user has had time to settle (rule #4).
- **Auto-prompt timing.** `maybeShowInstallCoach()` is called from
  `boot()` AFTER `refresh()`, the walls check, and the
  push re-subscribe block — so a returning user with push already
  enabled is never prompted, and a first-time friend sees the
  feed for a moment before the coach opens. Auto-prompt fires
  exactly once per browser; after that, only the chip re-opens it.
- **Install-completed detection.** `visibilitychange` listener
  flips the dismissed flag and emits `install_completed` when
  the browser returns to `display-mode: standalone` after a
  backgrounding — no need to wait for the next page load to know
  the install landed.
- **Funnel telemetry table + endpoint.** New
  `install_funnel_events(user_id, step, platform, meta, created_at)`
  table, two indexes (per-user, per-step). New auth-gated
  `POST /api/funnel/install` accepts a closed enum of steps
  (`prompt_shown`, `instructions_opened`, `dismissed`,
  `install_chip_tapped`, `install_completed`, `permission_requested`,
  `permission_granted`, `permission_denied`, `first_push_delivered`)
  and rejects unknown values with 400. PHA-2210 (analytics funnel
  umbrella) reads these rows to compute
  invite → accepted → installed → push-enabled (rule #6).
- **No analytics pipeline yet.** This issue ships the funnel
  ingestion only; the dashboard / aggregation step belongs to
  PHA-2210. Until PHA-2210 ships, the rows are still queryable
  directly via SQL for ad-hoc sanity checks.
- **Tests:** `scripts/test-install-coach.js` (new, 40 assertions
  across 17 test groups) — extracts the inlined helpers from
  `public/index.html` into a `vm` sandbox with mocked
  `navigator`/`window`/`Notification`/`localStorage`, then drives
  every code path. End-to-end covers: iOS standalone, Android
  Chrome standalone, fullscreen / minimal-ui display modes, plain
  browser tab, iPhone / iPad / iPadOS-on-Mac / Android /
  desktop Chrome / desktop Firefox platform classification, the
  dismissed + first-prompted + installed + permission-granted
  gating rules, the platform-specific instruction HTML shapes,
  and the full closed-enum validation + 400 on unknown + 401 on
  anonymous for the new endpoint, plus a SQLite-level assertion
  that 9 funnel rows land and the JSON `meta` round-trips.

## v0.1.21 (2026-08-19) — PHA-1899 (PHA-1617.6)

- **Drawer backend — HMAC-signed outbound forwarder.** `POST /api/drawer`
  no longer returns a stub: it looks up the caller's enabled drawer
  `agent_endpoints` row, signs the payload with the row's HMAC secret,
  POSTs to the configured URL with `X-Homestead-User`,
  `X-Homestead-Request-Id`, `X-Homestead-Timestamp`,
  `X-Homestead-Signature: sha256=<HMAC_SHA256(secret, ts + "." + body)>`,
  `X-Homestead-Conversation-Id`, and a `Homestead/<version>` User-Agent,
  then consumes the response. Supports the two wire shapes the
  frontend already understands: `text/event-stream` with `event: chunk` /
  `event: done` (Design Trap #4: never make a human watch an LLM think),
  and `Accept: application/json` single-shot. Anything else returns
  200 with `{ignored:true}` so a misbehaving harness doesn't fail the
  drawer.
- **Morning-brief snapshot envelope.** The signed body includes a
  `snapshot` block built by `lib/snapshot.build()` so the user's
  harness gets today_tasks / today_events / overdue_tasks /
  active_lists / recent_activity without an extra round-trip.
- **Retry + circuit breaker.** Exponential backoff (1s, 4s, 16s, 60s;
  up to 4 retries, 30s first-chunk timeout, 60s total deadline). On
  every dispatch, `agent_endpoints.last_used_at`,
  `last_status_code`, `last_error` are updated. An in-memory
  consecutive-failure streak per endpoint id trips after 5 failures
  in a single dispatch and auto-disables the endpoint
  (`enabled = 0`); subsequent calls return 404 from the dispatcher
  (the user re-enables in Settings).
- **`lib/drawer-dispatch.js`** — the new dispatcher module; pure
  dispatch (no Express), takes `db` + caller `me` + opts. Exposes
  `dispatchDrawer`, `buildBody`, `sign`, `parseSseBlock`,
  `findEndpoint`, `getUserGroups`, `httpPostOnce` for unit tests.
- **`scripts/test-drawer-backend.js`** — 70-check acceptance suite
  covering the dispatcher module shape, HMAC contract, SSE reply,
  JSON reply, retry/backoff, circuit breaker, cross-user refusal,
  kind/disabled refusal, endpoint-offline path, and the snapshot
  envelope. Replaces the old `test-drawer.js` (which targeted the
  stub and would hang against the real dispatcher).

## v0.1.20 (2026-08-15) — PHA-2001

- **CRASH-LOOP HOTFIX: include `lib/` in the runtime image.** The
  runtime stage of the Dockerfile was missing `COPY lib ./lib`, so
  the built container had an empty `/app/lib/` directory and Node
  crashed on boot with `Error: Cannot find module './lib/user-model'`
  at `server.js:33`. PHA-1618 (v0.0.5) introduced the `lib/`
  directory but the runtime-stage COPY list was never updated to
  pull it in. This release adds the missing `COPY lib ./lib` line;
  no other code or config changes are required. `life.phatt.vip`
  was offline until this landed; once Brandon's Docker pulls
  `:latest` it will be back. (PHA-2001.)

## v0.1.19 (2026-08-12) — PHA-1896 (PHA-1617.3)

- **Connected-agents sheet (token manager).** Avatar menu → **🔌
  Connected agents** opens the user-facing token manager for the
  PAT (personal access token) backend shipped in PHA-1617.1. Lists
  every active token for the signed-in user as a row: label,
  16-char non-secret prefix chip (`homestead_pat_Xxxxxxxx…`),
  scopes chip (active / admin / revoked / expired), created /
  expires / last-used metadata, and a per-row **Revoke** action
  that hits `DELETE /api/agent-tokens/:id`. Empty-state copy nudges
  the user toward the **+ New token** button.
- **Token-issue flow with copy-once plaintext reveal.** The issue
  sheet accepts a label (required, 64-char cap, pre-filled with a
  best-effort UA-derived guess like "Mac" / "iPhone") and an
  optional expiry date. On `POST /api/agent-tokens` the new
  modal opens with the plaintext rendered in a dark monospace
  card, a **Copy** button (`navigator.clipboard.writeText` with a
  manual-select fallback for browsers that block programmatic
  clipboard writes), and a green ✓ Copied flash for ~2.2s. The
  **"I've stored it — close"** acknowledgement button stays
  disabled until the user either copies OR ticks the manual
  acknowledgement checkbox. Closes only on acknowledgement; once
  dismissed, the plaintext is gone for good (the server only
  stored the bcrypt hash, per design doc §4.1 / §4.2).
- **No new server-side endpoints.** Pure SPA work — consumes the
  three `/api/agent-tokens` routes (`GET` / `POST` /
  `DELETE /:id`) shipped in PHA-1617.1. Admin-provisioned tokens
  via `POST /api/users/:username/agent-tokens` are out of scope
  for v0 of this UI; the admin cross-household view belongs to
  PHA-1617.4 (agent_endpoints) which will land its own settings
  surface.
- **Tests:** `scripts/smoke-token-manager-ui.js` (new) — exercises
  the full SPA-facing lifecycle against a live `server.js`: list
  empty, issue token, confirm plaintext format (`homestead_pat_`
  + 43-char base64url), confirm the stored row carries the right
  prefix + bcrypt hash + no plaintext anywhere on disk, revoke
  the token, confirm subsequent list filters it out and a
  Bearer auth attempt with the now-revoked plaintext returns
  401. Wired into `npm run test:smoke`.

## v0.1.18 (2026-08-12) — PHA-1902 (PHA-1617.9)

- **`homestead_get_user_context` snapshot endpoint** — single-call
  morning-brief context shape from the BYO-harness Meta-Agent Socket
  design doc §7. The harness (or the drawer, or the future MCP tool)
  makes one GET and gets everything it needs to render or reason about
  the user's day. Same builder backs all three callers so the envelope
  can't drift.
- **New endpoint**: `GET /api/me/snapshot` (auth required — session
  cookie, PAT, or header-trust). Returns:
  ```json
  {
    "user":      { "id", "username", "display", "groups", "isAdmin", "tz" },
    "now":       "<ISO 8601>",
    "today":     "YYYY-MM-DD",
    "today_tasks":    [native tasks due today, assignee IN (user, 'all')],
    "today_events":   [native + provider-cached events for today],
    "overdue_tasks":  [native tasks overdue, not done],
    "upcoming": {
      "events_next_7_days":     [merged events through today+7],
      "chores_due_next_7_days": [tasks due tomorrow through today+7]
    },
    "lists":            {},
    "activity_recent":  [last 25 notification_log rows for the user]
  }
  ```
- **Tz override via header**: `X-Homestead-Tz: <IANA name>` — the SPA
  can pin the snapshot's `today` boundary to the user's wall clock
  even when the server is in a different timezone. Defaults to the
  host's resolved timezone.
- **`lib/snapshot.js`** — the snapshot builder. Exposes `build(db,
  username, {tz, now})` plus the helpers `isoDateLocal`, `resolveTz`,
  `mergedEventsFor`, `recentActivity`. No LLM in the loop; server-side
  assembly only. No data truncation at the data layer; size caps are
  HTTP/transport concerns.
- **Activity-recent v0 source = `notification_log`**. PHA-1622
  (activity feed) will replace it with a richer audit trail once that
  ships; the envelope shape is forward-compatible so the swap is a
  one-file change in `lib/snapshot.js`.
- **`lists` is `{}` for v0** — there is no `lists` table yet. The
  design doc's `groceries` example will land under a separate
  follow-up; the snapshot endpoint returns an empty object so the
  §7 contract is "empty object" not "missing key".
- **Tests**: 41 unit assertions in `scripts/test-snapshot.js` + 31
  smoke checks in `scripts/smoke-snapshot.js`, both wired into
  `npm test` and `npm run test:smoke`. The smoke exercises the
  end-to-end flow against a live `server.js`: auth, scoping,
  today/upcoming windows, done-vs-open filtering, and the
  `X-Homestead-Tz` override.
- **Test-only credential-scanning**: the snapshot payload never
  contains `cred_blob`, `app_password`, `access_token`,
  `refresh_token`, or `client_secret` substrings. Defended both in
  the unit test (response body scan) and the smoke (response body
  scan).

## v0.1.17 (2026-08-12) — PHA-1898 (PHA-1617.5)

- **Meta-agent chat drawer UI shell (design doc §6.3).**
  Slide-in drawer (right side on desktop, full-screen on mobile) with a
  message composer. The composer POSTs `{message, endpoint_id,
  conversation_id}` to `/api/drawer` and the SSE/JSON consumer renders
  the reply as it streams. FAB trigger above the bottom nav; harness
  selector loads the caller's enabled `drawer` endpoints from
  `/api/agent-endpoints`. Empty-state CTA when no endpoints are
  configured.
- **SSE consumer (`consumeSseStream` + `parseSseBlock`).** Reads the
  response body via `ReadableStream` and parses `event:` / `data:`
  blocks separated by double newlines. Pipes `event: chunk` text into
  the streaming agent bubble, terminates on `event: done`. Handles
  comment lines (`:keepalive`) and multi-line `data:` correctly.
- **JSON consumer fallback.** If the harness returns `application/json`
  (single-shot stateless endpoint), renders `{text, ...}` into the
  agent bubble. The composer picks the right path per response
  Content-Type.
- **Stub `/api/drawer` POST endpoint.** Accepts the composer's payload,
  validates the caller owns an enabled `drawer` endpoint (returns 404
  on cross-user / events-kind / disabled endpoints without leaking
  existence), records dispatch bookkeeping (`last_used_at`,
  `last_status_code`, `last_error`), and returns either a synthetic
  `text/event-stream` reply (default) or an `application/json` reply
  (when `Accept: application/json` is set). The HMAC-signed outbound
  forwarder to the user's harness URL arrives in PHA-1617.6; the wire
  shape is stable so the frontend won't change.
- **Tests.** `scripts/test-drawer.js` (64 checks) wired into
  `npm test`: SSE reply shape + bookkeeping, JSON reply path, 401/400/404
  error paths, cross-user endpoint refusal, events-kind/disabled refusal,
  HTML smoke (drawer markup + JS wiring present), and the SSE block-parser
  contract.

## v0.1.16 (2026-08-12) — PHA-1897 (PHA-1617.4)

- **`agent_endpoints` table + library (design doc §6.1).** New
  per-user, per-harness endpoint config schema with HMAC secret
  generation on insert. Fields: `user_id` (FK users), `harness_label`,
  `kind` (`drawer` | `events`), `url`, `secret` (HMAC-SHA256 shared
  secret, server-generated `homestead_aes_<43-char-base64url>`,
  plaintext returned exactly once), `enabled` (default 1), `event_filter`
  (JSON, default `{}`), `created_at`, `last_used_at`,
  `last_status_code`, `last_error`. Index on `(user_id, kind, enabled)`
  for dispatch-side lookups. A user may own multiple harnesses of the
  same kind (each gets its own URL + secret).
- **HMAC signing helper (`signPayload(secret, ts, rawBody)`).**
  Implements design doc §6.4: `sha256=<hex>` where `<hex> =
  HMAC_SHA256(secret, timestamp + "." + raw_body)`. The dispatch
  helpers (`listEnabledForDispatch` + `recordDispatch`) are the entry
  points the PHA-1617.6 drawer POST and PHA-1617.7 events webhook
  outbound dispatchers will share.
- **CRUD API at `/api/agent-endpoints`** (plus
  `/api/users/:username/agent-endpoints` admin cross-household view):
  - `GET` — own endpoints (or `?user=` for admin), metadata only,
    secret never broadcast.
  - `POST` — create, returns the row *plus* the one-time
    `secret_plaintext`.
  - `PATCH` — partial update. `rotate_secret=true` returns a fresh
    `secret_plaintext`; otherwise the secret is not exposed.
  - `DELETE` — remove.
  - Admin PATCH path (cross-household) strips `rotate_secret` so admins
    can flip the `enabled` flag but cannot read or rotate the secret —
    preserves the "user owns their endpoint" trust model from §2 of the
    design doc.
- **Trust boundary matches design doc §2.** The plaintext secret is
  exposed only when the caller is the row owner; admin cross-household
  reads never see the secret. Server validates `kind` against the
  `drawer|events` enum, normalises `event_filter` to a JSON object, and
  rejects malformed URLs. Each user harness keeps its own secret so a
  compromised or rotated secret on one harness does not invalidate the
  others.
- **Tests.** `scripts/test-agent-endpoints.js` (79 checks) wired into
  `npm test`: create/list/get/update/remove including rotate-secret,
  validation, owner-scoping, dispatch bookkeeping, HMAC contract
  verification against an independent computation, and full HTTP
  integration through the live `server.js` (login → POST → PATCH
  enabled=false → PATCH rotate_secret → DELETE → 400 on bad inputs →
  401 on unauthenticated POST). Full suite: **666 / 666 pass, 0 fail.

## v0.1.13 (2026-08-11) — PHA-1868 (PHA-1620e)

- **Per-user source config UI.** Adds the add/edit/delete/refresh
  sheet for `calendar_sources` rows so users (not just admins with
  curl) can connect Nextcloud / iCloud / Microsoft 365 / Google
  calendars and see them flow into the household calendar grid. The
  sheet is reachable from the avatar menu and is the canonical
  source-config counterpart to `lib/calendar-sources.js`. Every
  authenticated user can manage their own per-user sources; admins
  additionally see shared sources and can edit/delete them.
- **Two new API surfaces that back the UI.**
  - `GET  /api/calendar-sources/kinds` — provider metadata for the
    add/edit form: provider labels, credential field schemas with
    `secret` / `required` flags, placeholder text, and a `disabled`
    flag for providers reserved in the allow-list but not yet
    shipped (google until PHA-1865 merges). The endpoint describes
    field shapes only — no credential VALUES cross the wire.
  - `PATCH /api/calendar-sources/:id` — edit `display_name`,
    `color`, and `enabled` without forcing a credential re-prompt.
    Provider / account_id / calendar_id / base_url / credentials
    stay immutable from PATCH (delete + re-add if you need to
    change them). Bogus color strings are normalised to the default
    hex; an empty body is a no-op returning the current row.
- **Provider-aware form** with per-provider credential fields:
  - **Nextcloud / Apple iCloud** — `app_password` (the existing
    CalDAV path; UI pre-fills the standard `base_url` placeholder).
  - **Microsoft 365** — `access_token` (required),
    `refresh_token` / `expires_at` / `client_id` / `tenant_id` /
    `scope` (optional, mirrors the GraphSource contract).
  - **Google** — listed but disabled in the UI until the
    `GoogleSource` adapter (PHA-1865) merges.
- **Disabled-source gating in the merged feed** (cross-checks PHA-1867):
  flipping `enabled=false` via PATCH causes the source's cached
  events to disappear from `/api/events/merged` immediately,
  giving the user a per-provider pause switch without deleting the
  source.
- **Tests:**
  - `scripts/smoke-calendar-sources-ui.js` (new, 64 checks) — boots
    server.js in-process against a fake CalDAV sandbox, exercises
    `/kinds`, POST (caldav + ms365), GET (leak check on
    `cred_blob` / `app_password` / `access_token` /
    `refresh_token`), PATCH (display_name / color / enabled
    round-trip + bogus color normalised + 404 + no-op), refresh,
    merged-feed round-trip, disabled-source exclusion, DELETE,
    DELETE-404. Hooked into `npm run test:smoke`.
- **No new runtime deps.** The PHA-1868 deliverable is the UI + the
  two new endpoints. The CalDAV + GraphSource adapters registered at
  server boot in v0.1.10 / v0.1.2 are the providers the UI surfaces.

## v0.1.12 (2026-08-10) — PHA-1876 (PHA-1624 Phase C)

- **Entity dedup + review queue.** `lib/dedup/matcher.js` exposes
  `matchEntity(candidate)` implementing the 3-tier algorithm from
  design doc §6:
  - **Tier 1** — deterministic ID match. Walks every known-ID slot
    (`isbn`, `tmdb_id`, `audible_id`, `plex_guid`, `kavita_id`) on
    the candidate against every existing `work` entity. Never merges
    — emits `adaptation_of` edges between siblings.
  - **Tier 2** — TMDB cross-reference. Plex + another service with
    the same TMDB id + collection + year → `adaptation_of` edge.
    Falls through to Tier 3 when either side lacks the collection.
  - **Tier 3** — fuzzy title + author. Score =
    `0.6 * title_similarity + 0.3 * author_similarity +
     0.1 * year_proximity` (trigram Jaccard + token-set ratio).
    Thresholds: `≥ 0.9` auto-aliases, `0.7..0.9` queues a review,
    `< 0.7` no-op.
  - **`mergeEntities(db, { reviewId, intoEntityId, decidedBy })`**
    is the **only** path that merges two entities — re-points
    outgoing + incoming edges, promotes aliases, deletes B, and
    marks the review row `status='merged'`. Idempotent on FK
    conflicts (re-points first, deletes second; the review row
    becomes a self-reference on the surviving target).
  - **`siblingDetector(db)`** cron helper: groups every `work`
    entity by `(name_lower, author)` and queues a review for any
    pair without an existing `adaptation_of` edge between them.
- **Endpoints.** Two new admin-only routes resolve review items:
  - `POST /api/review-queue/:id/merge` body `{into: entity_id}`
    → merges B into A, B becomes alias.
  - `POST /api/review-queue/:id/reject` body `{reason}`
    → marks the item `status='rejected'` (it never re-surfaces for
    that pair — `siblingDetector` filters on `status='pending'`).
  - `POST /api/admin/sync/sibling-detector` (admin) → manual
    trigger; the same function runs every 6h from the boot
    scheduler alongside Plex/Kavita entity-sync ticks.
- **UI.** The entity page header shows a "⚠️ Needs review (N)"
  badge when the entity has pending review items, and a
  "Review queue" section below the deep-link actions lists every
  pending pair with two buttons ("Merge into this" / "Don't
  merge"). Decisions call the merge/reject endpoints and re-open
  the page to reflect the new state.
- **Tests.** New `scripts/test-dedup-matcher.js` — 100 assertions
  covering all three tiers, every known-ID slot, the score formula,
  the dryRun path, sibling detector idempotency, merge round-trip
  (FK resolution + slot stamping), and reject terminality. Wired
  into `npm test`.

## v0.1.11 (2026-08-10) — PHA-1867

- **Month-grid merge layer (PHA-1867d).** The home + calendar pages now consume
  `GET /api/events/merged` and render cached provider events alongside native
  Homestead events in the same grid. PHA-1867 closes parent work-order step 3
  ("Merge into month grid + day drill-in"). Per-provider pips carry a 1px
  surface-coloured ring so they don't blur into the per-user coloured native
  pips on the same cell; provider event rows in the day-drill show a coloured
  source chip + left-bar tint, hover-label on the grid pip gives the
  provider display name, and a `stale` warning surfaces when the
  provider cache is older than the 5-min freshness window. Phase 2
  write-back (PHA-1866) adds edit/delete on top.
- **Overlap semantics.** `/api/events/merged` now uses
  `start_at <= to AND (end_at IS NULL OR end_at >= from)` so an event
  that starts before the requested window but ends inside it still
  appears. Multi-day events visible on the 1st of the month, all-day
  conferences that cross the calendar boundary, etc. — all surface
  in every day cell they touch.
- **Disabled sources.** Events from sources with `enabled = 0` are
  excluded from the merged feed — the operator toggle is the single
  switch for "stop showing this provider's events".
- **Defence-in-depth leak check.** The merged endpoint refuses to
  respond (HTTP 500 with a generic error) if the serialized response
  payload contains any of `cred_blob`, `app_password`, `access_token`,
  `refresh_token`, or `client_secret`. The publicView() contract is
  the only path to a row; this check catches upstream bypasses.
- **Tests.** `scripts/test-merge-layer.js` (31 unit tests covering
  overlap math, disabled-source exclusion, leak contract, JSON shape)
  and `scripts/smoke-merge-layer.js` (25 end-to-end smoke checks
  against a live server.js + fake CalDAV). Wired into `npm test` and
  `npm run test:smoke`.

## v0.1.10 (2026-08-10) — PHA-1866

- **Phase 2 calendar write-back (CalDAV).** Homestead now round-trips
  events through the configured CalDAV providers (Nextcloud, Apple
  iCloud) end-to-end instead of just reading them. The provider-
  agnostic `CalendarSource` interface gains three new methods:
  `createEvent({ calendarHref, vevent, externalId? })`,
  `updateEvent({ calendarHref, externalId, vevent, etag? })`, and
  `deleteEvent({ calendarHref, externalId, etag? })`. The CalDAV
  adapter implements them as RFC 4791 PUT/DELETE with the right
  conditional headers — `If-None-Match: *` on create to prevent
  overwrite, `If-Match: <etag>` on update/delete to guard against
  lost-update. Microsoft 365 (PHA-1864) and Google (PHA-1865) will
  register the same interface methods when their adapters land.
- **New HTTP surface.** `POST /api/calendar-sources/:id/events`,
  `PUT  /api/calendar-sources/:id/events/:externalId`, and
  `DELETE /api/calendar-sources/:id/events/:externalId` (all auth-
  gated, owner or admin). A successful write returns the canonical
  `{ externalId, href, etag }` and kicks a fire-and-forget sync so
  the next `GET /api/events/merged` reflects the provider state.
  Provider errors surface as 502 with the upstream status code
  preserved on the row's `last_error` / `last_error_at`.
- **VCALENDAR serializer.** `lib/caldav-source.js` gains a
  `buildVCalendar(vevent)` that is the inverse of the existing
  `parseVEvents` parser — round-trip verified by tests 7 + 12.
  Escapes RFC 5545 special characters (`\`, `,`, `;`, `\n`) and
  emits `VALUE=DATE` for `allDay` events. UID is auto-generated
  (RFC 4122 v4) when the caller doesn't provide one.
- **Single-VEVENT scope.** Recurrence editing remains out of scope
  (PHA-1620 step 4: "No recurrence editing in v1 — single VEVENT
  only"). The serializer/DTOs are forward-compatible with a future
  RRULE expansion; today's body shape is the flat `vevent` per
  event.
- **No new npm dependencies.** The CalDAV adapter still ships with
  a hand-rolled XML walker and iCal parser — the write side uses
  the same primitives.
- **Test coverage.** 6 new tests in `scripts/test-calendar-
  sources.js` (94 pass total, 0 fail) covering the serializer
  round-trip, the URL resolver, the stub-HTTP write flow, the
  lost-update 412 error path, the required-field validation, and
  the `app_password` leak check on provider-error messages. The
  end-to-end smoke (`scripts/smoke-calendar-sources.js`) now also
  exercises the write-back flow against a fake CalDAV provider —
  43 pass / 0 fail, including the full create→update→delete round
  trip and the cross-the-flow `app_password` leak check.

## v0.1.9 (2026-08-10) — PHA-1620 + PHA-1864

- **Universal calendar read-through (PHA-1620).** Homestead now reads
  events from configured external calendars instead of forcing
  double-entry. The provider-agnostic `CalendarSource` interface is
  shipped with its first concrete adapter (`CalDAVSource` — covers both
  Nextcloud and Apple iCloud via a single implementation parameterized
  on `base_url`). Surface area:
  - `GET /api/calendar-sources` (auth): list sources visible to the
    caller (their own + admin-managed household-shared sources). Never
    returns `cred_blob`.
  - `POST /api/calendar-sources` (auth): create a source. Encrypted at
    rest (AES-256-GCM, key from `CALENDAR_CRED_KEY`); admin only for
    `shared: true` sources.
  - `DELETE /api/calendar-sources/:id` (auth): owner or admin.
  - `POST /api/calendar-sources/:id/refresh` (auth): kicks a sync.
    Errors are captured on `last_error` / `last_error_at` so a per-
    provider stale badge can render in the month grid.
  - `GET /api/events/merged?from=YYYY-MM-DD&to=YYYY-MM-DD` (auth):
    unified list of native + cached provider events, each tagged with
    `origin` (`native` or `provider:<provider>`), `color` (per-source),
    `stale` (true when `last_synced_at` is older than the 5-min
    freshness window).
- **Schema additions.** New tables `calendar_sources` and
  `calendar_event_cache`. The migration is idempotent and additive
  against v0.0.x / v0.1.0 deployments; no destructive changes.
- **At-rest credential encryption.** `lib/secret-box.js` provides
  AES-256-GCM encrypt/decrypt keyed on `CALENDAR_CRED_KEY` (32 bytes
  hex, fail-closed — missing or wrong-length key throws on every
  call). The `/api/health` probe reports `calendarCredKeyReady` so
  operators see it in monitoring; until the key is set,
  `/api/health.ok` is `false` and `POST /api/calendar-sources` returns
  503.
- **No provider credentials ever reach the browser.** Enforced at the
  DTO layer (`publicView` in `lib/calendar-sources.js` is the single
  source of truth for what ships to the client; the leak check is a
  load-bearing acceptance test in `scripts/test-calendar-sources.js`).
- **Hand-rolled CalDAV / iCal parser.** No new npm dependencies — the
  WebDAV/CalDAV XML walker and the iCalendar (RFC 529) parser live in
  `lib/caldav-source.js`. The HTTP layer is injectable so tests stub
  the network. Single-VEVENT scope per the work order (recurrence
  editing deferred).
- **Microsoft 365 (`GraphSource`) adapter (PHA-1864 / PHA-1620a).**
  The same `CalendarSource` interface that backed `CalDAVSource` now
  also backs `GraphSource` for Microsoft 365. No merge-layer,
  API-surface, or DTO changes — the second adapter registers behind
  `registerAdapter('graph', …)` and is reachable through the existing
  `POST /api/calendar-sources` endpoint with `provider: "ms365"`.
  Google's `GoogleSource` (PHA-1865) remains the next child issue; the
  provider name is reserved in the API allow-list but POST returns 501
  today.
- **OAuth2 credentials for MS365.** `cred_blob` for `ms365` sources
  carries `{ access_token, refresh_token, expires_at, client_id,
  tenant_id?, scope? }`. The adapter sends `Authorization: Bearer
  <access_token>` on every request, refreshes proactively when
  `expires_at` is within the next 60 seconds, refreshes reactively when
  the provider returns 401, and uses
  `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
  `grant_type=refresh_token`.
- **Per-provider credential validation.** CalDAV still requires
  `app_password`; MS365 requires `access_token` (and accepts
  `refresh_token` + `expires_at` + `client_id` + `tenant_id` + `scope`
  for the refresh path). The encrypted `cred_blob` shape is
  provider-specific — adapters parse their own fields.
- **Tests.** 90 unit tests in `scripts/test-calendar-sources.js` and
  46 unit tests in `scripts/test-graph-source.js` cover factory
  validation, calendar/event mapping, Bearer auth, refresh-on-401,
  pre-emptive refresh, and the end-to-end `syncSource` path through
  `lib/calendar-sources.js`. Smoke scripts `scripts/smoke-calendar-
  sources.js` and `scripts/smoke-graph-source.js` boot the real
  `server.js` against fake providers and walk the full `/api/login`
  → `POST /api/calendar-sources` → `/api/calendar-sources/:id/refresh`
  → `/api/events/merged` flow with the same credential-leak contract
  checks as the CalDAV smoke.
- **Frontend merge layer** is out of scope for this slice — see
  PHA-1867. The server-side merge endpoint is ready to consume.

## v0.1.8 (2026-08-10) — PHA-1617.1/.2

- **Per-user agent PATs for the BYO-harness meta-agent socket.**
  `lib/agent-tokens.js` adds an `agent_tokens` table — one row per
  issued token, plaintext never stored (bcrypt hash + non-secret
  16-char lookup prefix), soft-deletion via `revoked_at`. New
  endpoints:
  - `GET /api/agent-tokens` — list own tokens.
  - `POST /api/agent-tokens` — issue a new token; plaintext shown
    once.
  - `DELETE /api/agent-tokens/:id` — revoke own token.
  - `POST /api/users/:username/agent-tokens` (admin) — issue under
    another user.
  - `DELETE /api/users/:username/agent-tokens/:id` (admin) — revoke.
  `authenticate()` now accepts `Authorization: Bearer homestead_pat_…`
  ahead of the header-trust and session-cookie layers; a valid PAT
  synthesizes a request-scoped `req.session.user` for the token's
  owner (not persisted to the session store — verified fresh on every
  request). Acceptance: **35 tests** in `scripts/test-agent-tokens.js`
  covering issue/list/revoke, prefix-collision retry, expired /
  revoked / tampered rejection, and a live end-to-end Bearer-auth
  HTTP test against `server.js`. Full `npm test` suite: 60 + 75 + 75 +
  35 = **245/245 green**.


## v0.1.7 (2026-08-10) — PHA-1874 (PHA-1624 Phase B-2)

- **Kavita sync worker.** New `lib/sync/kavita.js`
  (`syncKavita({db, baseUrl, apiKey})`) walks a Kavita library
  (Manga + Books only; Image + Video are out of scope for v1) and
  reconciles series + authors + tags into Homestead's entity graph
  (PHA-1624 design doc §5.1). Reuses the shared
  `lib/sync/_schema.js` so it boots even before Phase A's standalone
  migration lands. Acceptance: **75 tests** in
  `scripts/test-sync-kavita.js` covering manga + book walks,
  authored_by edge emission (writers / authors / legacy flat fields),
  tagged_with for genres + tags, person dedup by lowercased name,
  concept dedup by slug, library-type filtering (image + video
  excluded), per-library pagination across `PageNum`/`PageSize`,
  idempotent re-runs, stale-marking of edges whose upstream record
  disappeared, cross-library sibling detection via
  `(title_lower, year)`, FTS5 index population, and graceful
  per-library error handling.
- **Author → person merge.** Per design doc §14 question #2
  (defaulted YES by Brandon's approval), `person` entities merge
  deterministically on lowercased full-name match within `kind=person`.
  v1 collision risk accepted (Tyler is unique; two people named
  "Brandon Smith" would collide — Phase C will add fuzzy matching).
- **Authored_by edges.** `work → person` edges from Kavita writers
  (design doc §5.1). Writers read from `metadata.writers`
  (canonical), `metadata.authors` (alternate install), and a legacy
  flat `writers` field, deduped case-insensitively within a single
  series entry.
- **Cross-library siblings.** `available_as` edges emitted in a
  post-pass for work pairs across libraries with matching
  `(title_lower, year)` (different editions / languages). Order-
  independent: same edge set regardless of which library the worker
  hit first.
- **Admin endpoints + cron schedule.** `POST /api/admin/sync/kavita`
  (admin-only async trigger), `GET /api/admin/sync/kavita/status`
  (admin-only last-run summary). Boot scheduler ticks every 6h,
  independent from the Plex worker (same cadence, separate guard).
  Skipped silently when `KAVITA_API_KEY` is unset so installs without
  Kavita keep working.
- **PR scope.** One branch (`pha-1624-entity-graph-phase-b2-kavita`)
  off `phattbeats/homestead@pha-1624-entity-graph-phase-b1-plex`,
  one PR, title `PHA-1624 Phase B-2: Kavita sync worker`, body
  references design doc §5.1. Merged on top of Phase A (PHA-1872) and
  Phase B-1 (PHA-1873); on merge, dropped the worker's defensive
  `_schema.js` boot call in favor of Phase A's canonical
  `entityGraph.migrate(db)` (same underlying schema); combined
  `npm test` to run `test-entity-graph.js`, `test-sync-plex.js`, and
  `test-sync-kavita.js` together.

## 0.1.6 — 2026-08-10

- **PHA-1624 Phase B-1 (PHA-1873): Plex sync worker merged on top of
  Phase A.** See the v0.1.5 entry below for the full feature writeup.
  On merge: dropped the worker's defensive `plexSync.migrate(db)` boot
  call in favor of Phase A's canonical `entityGraph.migrate(db)` (same
  underlying schema, `lib/sync/_schema.js`); combined `npm test` to run
  both `test-entity-graph.js` and `test-sync-plex.js`. Also fixes a
  boot crash in the PR as originally opened — unrelated calendar-
  sources/secret-box routes had leaked into `server.js` from another
  in-flight branch and referenced modules that don't exist here; that
  code was removed as out of scope for this PR.

## 0.1.2 — 2026-08-10

- **PHA-1624 Phase A (PHA-1872): entity graph — schema, read API, entity
  page, ⌘K search.**
  The first slice of the "everything app" entity graph (design doc
  PHA-1624): one node per real-world thing, edges typed and
  provenance-tagged, and a page every node can point to. This PR ships
  the read-only spine; sync workers (Plex/Kavita/seerr/…) land in
  Phase B.

  - **Schema (`lib/sync/_schema.js`):** `entities`, `entity_aliases`,
    `entity_edges`, `entity_review_queue`, plus an `entities_fts` FTS5
    virtual table with insert/update/delete triggers. Wired into the
    boot migration right after `userModel.migrate(db)`. Idempotent —
    safe to call on every boot, same pattern as PHA-1618.
  - **Read API:** `GET /api/entities`, `/api/entities/:id`,
    `/api/entities/:id/edges`, `/api/entities/:id/backlinks`,
    `/api/entities/search`, `/api/entities/:id/review-queue`, and
    `/api/review-queue` — all behind the existing `auth` middleware,
    all 404ing with `{error:'not_found'}` for missing ids to match the
    rest of the app.
  - **Entity page:** a vanilla-JS view at `/entity/:id` — header +
    meta strip, quick-action deep-link buttons, edges grouped by type
    (collapsible, per the wireframe in design doc §7), backlinks, and
    an aliases/source-ids footer.
  - **⌘K / Ctrl+K search palette:** global listener, hits render name +
    kind + matched alias, Enter/click navigates to the entity page.
  - **`scripts/seed-dune.js`:** the Dune walkthrough from design doc
    §11 — book (Kavita), audiobook (Audiobookshelf), film (Plex),
    Frank Herbert, David Lynch, and a `Dune franchise` concept node
    tying the three formats together via `available_as` /
    `tagged_with` / `adaptation_of`. Idempotent, direct-DB, no write
    API involved (Phase A is read-only by design).
  - **Tests (`scripts/test-entity-graph.js`):** 38 assertions covering
    migration idempotency, entity/edge CRUD at the DB layer, edge
    direction filtering + grouping, backlinks staleness filtering,
    review-queue scoping, FTS5 name/alias search, and the full Dune
    walkthrough end-to-end.

## 0.1.1 — 2026-08-10

- **PHA-1623: per-service health checks — the launcher knows when an
  app is down.**
  The failure mode this prevents is real: Emily taps SillyTavern, gets
  a white iframe from the reverse proxy / crashed backend, and concludes
  the whole Homestead platform is broken — when in fact the launcher
  itself is fine, only one downstream service is sick. The launcher
  now polls every service tile on its own schedule and shows a subtle
  red dot + "down since HH:MM" badge on any tile that's been failing
  two checks in a row.

  - **Per-service config:** each tile gets two new optional fields —
    `health_url` (defaults to the tile URL) and `health_interval_sec`
    (defaults to 60s; set to 0 to opt a tile out). The new-edit sheet
    surfaces both fields directly under "Health check (optional)".

  - **Server-side checker (`lib/health-checker.js`):** one independent
    `setInterval` per enabled service — the work order explicitly says
    "setInterval is fine at this scale" and the launcher's ~20 services
    is exactly that scale. Each probe tries HEAD first (lighter on the
    target), falls back to GET on 405/501 (some apps don't implement
    HEAD), and uses an `AbortController` with a 5s timeout.

  - **Status semantics:**
    - `2xx` / `3xx` → `up`
    - `401` / `403` → `up` (auth walls are healthy — the work order
      explicitly calls this out: "auth-walled apps (401) show UP")
    - timeouts, `5xx`, `conn-refused` → `fail`
    - 1 fail = still `up` (so a single transient blip doesn't flap)
    - 2 consecutive fails = `down`; `down_since` stamped on transition
    - any `up` after `down` clears `down_since` (recovery)
    - consecutive fails counter resets to 0 on success

  - **Runtime state table (`service_health_state`):** one row per
    service, joined to `services` on delete-cascade. Carries `status`,
    `last_status_code`, `last_checked_at`, `last_ok_at`, `down_since`,
    `consecutive_fails`, `last_error`. The state is wiped automatically
    when a service is deleted (`ON DELETE CASCADE`).

  - **`/api/services` now inlines the health snapshot** so the UI never
    needs a second round-trip to render the badge. The tile stays auth-
    gated; only the dedicated **`/api/services/health`** endpoint
    (unauthenticated, for agents and future push-notification consumers)
    exposes the full per-service list with the up/down/unknown counts.

  - **UI badge:** `.svc-health` chip with a red dot + "down since
    HH:MM" label appears on any down tile. The dot sits in the
    opposite corner from the existing owner-dot so it doesn't fight
    Brandon's per-user colour scheme. Tap-through still works — the
    badge is a CSS overlay, not a button — and the tile gets a subtle
    red-tinted border to make a stack of down tiles scannable at a
    glance.

  - **Optional DOWN-transition hook** (`onDownTransition`) is wired in
    `server.js` but the body is a log line until the push notifications
    primitive (PHA-1619) lands. The shape is what the future hook will
    expect — when PHA-1619 merges, only the body needs to change.

  - **Acceptance tests** (`scripts/test-health-checker.js`, run via
    `npm test`): 60 assertions covering the auth-wall classification,
    interval clamping, the 2-fail debounce, the recovery clears-
    down_since invariant, the HEAD-405 fallback, the 5s timeout, the
    conn-refused path, and the end-to-end start/tick/persist flow
    against a temp SQLite.

  Acceptance: stopping a test container flips its tile to `down` within
  two intervals; restarting clears it. Auth-walled apps (401, 403)
  show `up`. State survives server restarts because it's persisted in
  SQLite. Test results: `60 pass, 0 fail`.


- **Web push notifications.** Standard VAPID-based push (no Firebase),
  with a per-user subscription store and a server-side `notify(userId,
  payload)` primitive that downstream features (PHA-1617 events
  webhook, future agent handoffs) can build on. Surface area:
  - `GET /api/push/vapid-public-key` (public): returns the server's
    VAPID public key so the service worker can subscribe.
  - `POST /api/push/subscribe` (auth): idempotent — re-subscribing the
    same endpoint resets its failure counter.
  - `POST /api/push/unsubscribe` (auth): removes by endpoint.
  - `GET /api/push/prefs` / `PUT /api/push/prefs` (auth): per-user
    quiet hours (default 21:00–08:00) and three category toggles
    (`chore_due`, `take_turns`, `system`).
  - `POST /api/notify` (auth): `{ userId | username, payload, force }`
    — `force` bypasses quiet hours for urgent agent-driven handoffs.
  - Subscriptions returning 404/410 from the push service are pruned
    on the failed send; other failures increment `failure_count`.
  - Daily digest: server-side scheduler on a 30-minute tick, idempotent
    via a per-user/per-category `notification_log` dedupe.
- **Schema additions.** New tables `push_subscriptions`,
  `notification_prefs`, `notification_log` — all keyed to
  `users.id` (the stable PK), so the future PHA-1618 user-model
  migration is a no-op for these tables.
- **Frontend.** Avatar menu gains an "Enable push notifications"
  button + per-user prefs editor (quiet hours + category toggles).
  Auto-resubscribes on login if the browser already has a granted
  permission, so a returning user on a new device does not have to
  click "Enable" again.
- **Service worker (`public/sw.js`).** Adds `push` and
  `notificationclick` handlers. Click focuses an existing Homestead tab
  or opens a new one; rotating-chore handoffs are sticky
  (`requireInteraction: true`).
- **VAPID keypair** generated on first boot, persisted to
  `DATA_DIR/vapid.json` (mode 0600), loaded into `web-push` at
  startup. Rotation invalidates every existing subscription (browsers
  will see 410 Gone on next push) — keep the file across restarts.
- **README** updated with push-notification setup, iOS 16.4+ install
  requirements, and a curl-based smoke test against `/api/notify`.

## v0.1.5 (2026-08-09) — PHA-1873 (PHA-1624 Phase B-1)

- **Plex sync worker.** New `lib/sync/plex.js` (`syncPlex({db, baseUrl, token})`)
  walks a Plex Media Server library and reconciles entities + edges in
  Homestead's entity graph (PHA-1624 design doc §5.1). The worker
  installs the entity-graph schema on first call (`lib/sync/_schema.js`)
  so it's boot-ready even before Phase A's standalone migration lands.
  Acceptance: 65 tests in `scripts/test-sync-plex.js` covering movie +
  show + season + episode walks, person dedup (lowercased name),
  concept dedup (slug), tagged_with + directed_by + part_of +
  available_as edge emission, idempotent re-runs, stale-marking of
  edges whose upstream record disappeared, cross-library sibling
  detection via `(title_lower, year)`, and FTS5 index population for
  the cmd-K search palette (Phase A consumer).
- **Schema module shared between Phase A and Phase B-1.**
  `lib/sync/_schema.js` exports the `SCHEMA_SQL` constant + an
  idempotent `migrate(db)` installer for the entity-graph tables
  (`entities`, `entity_aliases`, `entity_edges`,
  `entity_review_queue`, `entities_fts` + triggers). Phase A can
  either call this directly or mirror the DDL in its own migration;
  either way the worker boots without a schema dependency.
- **Admin endpoints for manual sync + status.** `POST /api/admin/sync/plex`
  kicks the worker asynchronously (admin-only); `GET /api/admin/sync/plex/status`
  returns the last-run summary + a `running` flag. Both endpoints
  guard against concurrent triggers with a single-process serialization
  flag (a fresh sync waits for the in-flight one to drain rather than
  queueing).
- **Scheduled cron tick every 6h.** The Plex worker runs from the
  existing boot scheduler on a separate cadence from the chore digest
  (which still fires every 30 min). The 6h interval is wall-clock; the
  first tick happens 10s after boot and then every 30 min *only when
  the 6h has elapsed*. Skipped silently when `PLEX_TOKEN` is unset so
  installs without Plex keep working.
- **PR scope.** One branch (`pha-1624-entity-graph-phase-b1-plex`)
  off `phattbeats/homestead@main`, one PR, title `PHA-1624 Phase B-1:
  Plex sync worker`, body references design doc §5.1. **Merge is
  blocked on Phase A's schema PR (PHA-1872) landing first** — the
  worker self-installs the schema as a defensive fallback, but the
  canonical migration should be Phase A's.

## v0.1.0 (2026-08-09) — PHA-1619

- **Web push notifications.** Standard VAPID-based push (no Firebase),
  with a per-user subscription store and a server-side `notify(userId,
  payload)` primitive that downstream features (PHA-1617 events
  webhook, future agent handoffs) can build on. Surface area:
  - `GET /api/push/vapid-public-key` (public): returns the server's
    VAPID public key so the service worker can subscribe.
  - `POST /api/push/subscribe` (auth): idempotent — re-subscribing the
    same endpoint resets its failure counter.
  - `POST /api/push/unsubscribe` (auth): removes by endpoint.
  - `GET /api/push/prefs` / `PUT /api/push/prefs` (auth): per-user
    quiet hours (default 21:00–08:00) and three category toggles
    (`chore_due`, `take_turns`, `system`).
  - `POST /api/notify` (auth): `{ userId | username, payload, force }`
    — `force` bypasses quiet hours for urgent agent-driven handoffs.
  - Subscriptions returning 404/410 from the push service are pruned
    on the failed send; other failures increment `failure_count`.
  - Daily digest: server-side scheduler on a 30-minute tick, idempotent
    via a per-user/per-category `notification_log` dedupe.
- **Schema additions.** New tables `push_subscriptions`,
  `notification_prefs`, `notification_log` — all keyed to
  `users.id` (the stable PK), so the future PHA-1618 user-model
  migration is a no-op for these tables.
- **Frontend.** Avatar menu gains an "Enable push notifications"
  button + per-user prefs editor (quiet hours + category toggles).
  Auto-resubscribes on login if the browser already has a granted
  permission, so a returning user on a new device does not have to
  click "Enable" again.
- **Service worker (`public/sw.js`).** Adds `push` and
  `notificationclick` handlers. Click focuses an existing Homestead tab
  or opens a new one; rotating-chore handoffs are sticky
  (`requireInteraction: true`).
- **VAPID keypair** generated on first boot, persisted to
  `DATA_DIR/vapid.json` (mode 0600), loaded into `web-push` at
  startup. Rotation invalidates every existing subscription (browsers
  will see 410 Gone on next push) — keep the file across restarts.
- **README** updated with push-notification setup, iOS 16.4+ install
  requirements, and a curl-based smoke test against `/api/notify`.

## v0.0.5 (2026-08-09)

- **PHA-1618: generalized user model — `users` is now a profile cache, not a directory of record.**
  Authentik is the directory of record; Homestead never creates or
  deletes user rows on its own. Identity, groups, and membership live in
  authentik (or the next OIDC provider that fronts life.phatt.vip).
  Homestead keeps a thin local row per user with display-only fields
  (display name, color, avatar, preferences) and the `auth_provider` /
  `provider_subject` tuple needed to attach the identity to the row.

  Concretely:
  - **Schema:** `users.username` carries `COLLATE NOCASE` so case-insensitive
    uniqueness is enforced at the SQLite layer (no functional-index
    gymnastics in app code). New profile-cache columns: `avatar_url`,
    `preferences` (JSON), `auth_provider`, `provider_subject`,
    `claimed_at`, `last_seen_at`, `updated_at`. New tables: `groups`
    (string cache of group names, mirrored from PHA-1577), `user_groups`
    (M2M), `tile_visibility_groups` + `tile_visibility_users` (per-tile
    access predicates, replaces the owner-dot model).
  - **JIT provisioning in the auth middleware.** When SWAG forwards
    `X-authentik-username` (header-trust, PHA-1574), the request lands on
    `provisionOrClaim(username, provider, subject, groups)` which either
    CLAIMs the existing seeded row (case-insensitive match) or CREATEs a
    new profile row keyed on the username. All chore / activity / list
    history stays on the claimed row — the seeded brandon/emily rows
    predate the header-trust path, so this is the contract that keeps
    existing data alive through the migration.
  - **Group reconciliation.** `reconcileGroups(userId, [groups])` is the
    single source of truth for `user_groups` membership; it replaces
    (not merges) the user's full M2M with the groups asserted by the
    auth provider on every authenticated request. Group changes in
    authentik propagate on the user's next request — no dual
    administration, ever. The legacy `users.is_admin` flag is kept as a
    denormalized convenience (auto-syncs to `admins` group membership)
    so admin-only HTTP endpoints don't need to walk the M2M on every
    check.
  - **CLAIM-first semantics.** Seeded profiles (`admin`, `brandon`,
    `emily`) ARE the authentik accounts — never duplicated. The v0.0.1
    `brandon`/`emily` env-seeded pair is replaced by a single admin
    user plus three CLAIM-ready profiles. LAN passwords default to
    `ADMIN_PASSWORD` / `BRANDON_PASSWORD` / `EMILY_PASSWORD` env vars
    (or `'changeme'`) so the built-in `/api/login` keeps working as the
    PHA-1574 LAN fallback.
  - **No Homestead-side user CRUD beyond profile fields.** The
    v0.0.2 `POST /api/users` (admin-create) and `DELETE /api/users/:u`
    endpoints are gone — users come from authentik. `PUT /api/users/:u`
    remains for profile-only edits (display, color, avatar, preferences)
    and is open to the user themselves or an admin.
  - **Migration preflight.** A v0.0.x user table with case-collisions
    (e.g. both `Brandon` and `brandon`) refuses to boot with a clear
    error naming the duplicates — `users.username` cannot carry
    `COLLATE NOCASE` on a column that already has duplicates, and the
    existing schema would reject the migration with a far less helpful
    `UNIQUE constraint failed`.
  - **Case-collision preflight refuses to boot.** If the user table has
    both casings of the same name, `migrate()` throws with the
    collision list. Rename the duplicates before restarting.
  - **Tests:** `scripts/test-user-model.js` exercises the migration,
    CLAIM semantics, CREATE path, case-insensitive lookup, group
    reconciliation, `is_admin` denormalization, the case-collision
    preflight, and the acceptance-criterion grep gates
    (`brandon`/`emily` comparison strings and legacy `both` enum — only
    the `UPDATE ... = 'all' WHERE ... = 'both'` migration lines are
    permitted). 43/43 tests pass. `npm test` runs the suite in ~0.3s.

  Acceptance (verified):
  - Existing `admin` row survives migration untouched; seeded
    `brandon` / `emily` CLAIM on first authenticated request, history
    preserved (chore / activity / list rows stay attached to the seeded
    id).
  - A new authentik-only user (`alex`) gets a fresh row on first
    request; group membership is honored from `X-authentik-groups`.
  - Zero hardcoded `brandon`/`emily` comparison strings in non-comment
    server code (grep-verifiable). The only remaining matches are in
    comment blocks explaining the migration and in the seed-time
    `INSERT INTO users` statements that establish the CLAIM targets.
  - Zero runtime `'both'` enum references; only the `UPDATE ... = 'all'
    WHERE ... = 'both'` migration lines remain, and they run once on
    first boot against any legacy v0.0.1 data.

- **Architecture: server.js now delegates to `lib/user-model.js`.** The
  data layer (migrations, `provisionOrClaim`, `reconcileGroups`,
  `validateUsername`, `validateAssignee`) is a pure DB module with no
  HTTP / express dependency, importable directly from tests. `server.js`
  shrinks from 411 → 347 lines and the test suite runs without spawning
  a subprocess.

- **/api/groups endpoint.** Read-only view of the group cache plus
  `?mine=1` for the authenticated user's groups. `POST`/`PUT`/`DELETE`
  on groups are intentionally not exposed — authentik owns the
  lifecycle.

- **/api/users response shape.** Now includes the v0.0.5 profile-cache
  fields (`avatar_url`, `preferences`, `auth_provider`,
  `provider_subject`, `claimed_at`, `last_seen_at`, `created_at`) so
  the v0.0.2 frontend (PHA-1682) can render the same assignment
  pickers without code changes.

## v0.0.4 (2026-08-06)

- **Fix: container crash on boot (regression from v0.0.3).** The
  runtime stage of the multi-stage Dockerfile failed to `COPY
  package.json` into the slim image, but `server.js` requires it at
  module load to populate `PKG_VERSION` for the `/api/version` endpoint
  added in v0.0.3. Result: every container started since v0.0.3 crashed
  at boot with `MODULE_NOT_FOUND` and never served. SWAG's nginx
  upstream for `life.phatt.media` then failed to resolve and refused to
  start, taking every other subdomain down with it. Fix is a
  single-line `COPY package.json ./` in the runtime stage.

## v0.0.3 (2026-08-04)

- **`/api/health` JSON endpoint (PHA-1706):** returns
  `200 OK` + `Content-Type: application/json` with body
  `{ ok, service, version, commit, uptime, db }`. Unauthenticated by
  design so SWAG, container orchestrators, and Uptime Kuma can probe
  it without a session. The `db` field reflects a live `SELECT 1`
  against the SQLite file and reports `"ok"` or `"error"` so monitoring
  can tell a live Homestead from a half-broken one. Replaces the
  39 KB SPA HTML that the SPA fallback used to serve for unmatched
  `/api/*` paths.
- **`/api/version` JSON endpoint (PHA-1706):** returns
  `{ version, commit }` for cache-busting diagnostics. The `commit`
  field is injected at build time via `docker build
  --build-arg COMMIT_SHA=$(git rev-parse --short HEAD)`; falls back to
  `null` in dev runs.
- Release workflow now bakes the short git SHA into the image as
  `COMMIT_SHA` so `/api/version` reports the real commit instead of
  `null`. See `.github/workflows/release.yml`.
- **API 404 JSON (PHA-1704):** unknown `/api/*` paths now return
  `HTTP 404` + `{"error":"not_found"}` instead of the SPA HTML shell.
  Previously the Express catch-all wildcard served the 39KB `index.html`
  for every unmatched `/api/*` path, breaking health checks, masking
  "feature missing" from JS clients, and wasting bandwidth. The SPA
  fallback now excludes `/api/*` so even a regression in the 404 handler
  can't re-introduce the bug.
- **`GET /api/logout` → 405 (PHA-1705):** logout now rejects GET with
  `405 Method Not Allowed` + `{"error":"method_not_allowed","allow":"POST"}`
  instead of falling through to the SPA fallback. Logout mutates server
  state (destroys the session), so per RFC 9110 §9.2.1 it must not be
  reachable via a safe method — otherwise `<img src="/api/logout">`
  becomes a CSRF logout vector the moment any future fallback handler
  respects the verb. Defense in depth on top of the PHA-1704 catch-all:
  PHA-1704 already prevents the SPA-HTML-200 behavior at the routing
  layer; this handler makes the intent explicit at the route definition
  site and returns the semantically correct status code (the resource
  exists, just not via GET).
- **`/favicon.ico` serves the SVG icon (PHA-1707):** browsers auto-request
  `/favicon.ico` for every tab; without an explicit handler the SPA
  catch-all served the 39 KB `index.html` as the favicon response, pure
  waste on every tab load. The handler serves the existing `public/icon.svg`
  (191 bytes) with the correct `image/svg+xml` content-type. The manifest
  already points at `/icon.svg` as the icon source of truth, and modern
  browsers accept SVG favicons. Legacy browsers fall through to the
  manifest. Same bytes, same ETag, no redirect overhead — 0.5% of the
  bandwidth.
- **`/robots.txt` (PHA-1708):** added `public/robots.txt` with
  `User-agent: *` / `Disallow: /`. Without this file, `express.static`
  had nothing to serve for `/robots.txt` and fell through to the SPA
  catch-all, which returned the 39 KB `index.html`. Cloudflare then
  wrapped that HTML in its auto-injected content-signal boilerplate
  and served it as a ~39 KB `text/plain` response — real crawlers
  (Googlebot, Bingbot, AhrefsBot, ...) parse robots.txt for
  `User-Agent:` / `Disallow:` / `Allow:` directives and either ignored
  the boilerplate or treated it as "no rules = allow everything". A
  blanket disallow is the right policy for a login-gated household
  dashboard: the SPA shell, manifest, and login UI have no SEO value,
  and per-user content (tasks / events / services) is behind auth
  anyway. Edit `public/robots.txt` directly if a different policy is
  ever needed — no code change required.

## v0.0.2 (2026-08-03)

- Generic N-user model: replaced hardcoded `brandon` / `emily` users with a
  dynamic users table administered from the in-app Settings sheet.
- Admin bootstrap: a single `ADMIN_PASSWORD` env var seeds the `admin`
  user on first DB creation. Admin then creates household users from
  Settings → Users.
- New `/api/users` CRUD endpoints for admin-only user management.
- Settings sheet (admin only) for creating users and rotating passwords.
- Dynamic user pickers everywhere tasks, chores, and tile owners used to
  hardcode two named users.
- Chore rotation works for any number of assigned users (previously
  hardcoded for two-person households).
- Removed `USER` node directive from the Dockerfile; the container now
  runs as root so bind-mounts of `/data` on Unraid do not need per-host
  UID alignment.

## v0.4.3 (2026-08-24) — Porch default-visible + wall admin surface (PHA-2556)

Closes the PHA-2493 / PHA-2556 reopen-class defect: the seeded wall was
visibility=group, group_name=media-club, but the user-model seed put
every user in `household` only, so a fresh install yielded
`GET /api/walls → {"walls":[]}` and the Porch tab rendered the
"No walls yet" empty state. The previous smoke test masked this by
open-coding an `INSERT INTO user_groups` to grant brandon media-club
membership — exactly the bug the test was supposed to catch.

- **`lib/walls.js#seed()`** — the seeded wall is now `household`
  (visibility=group, group_name=household), so every seeded user
  (admin / brandon / emily, all already in `household` via
  `lib/user-model.js#seed`) can see it on first boot, with no manual
  group grants.
- **`lib/walls.js`** — new exports `createWall`, `adminAddMember`,
  `adminRemoveMember`, `validateWallInput`, plus the regex constant
  `SLUG_RE`. All four are admin-only and exercise the same
  `assertMember` gate as the rest of `/api/walls`.
- **`server.js`** — four new routes: `POST /api/walls` (admin),
  `POST /api/walls/:slug/members` (admin), `DELETE
  /api/walls/:slug/members/:username` (admin), and `GET /api/groups`
  (admin). Admin-only listing `GET /api/walls/all` exposes every wall
  to the management sheet regardless of membership, backstopping the
  constitutional 404-private wall existence rule for the regular
  `GET /api/walls`.
- **`lib/wall-members.js#getMembers()`** — group walls now UNION in
  members derived from `user_groups` (not just `wall_memberships`),
  so the member listing shows the full roster of group-derived
  members with no separate `wall_memberships` row required.
- **`public/index.html`** — new admin sheet "Walls · manage walls"
  (avatar menu → ⚙️ Settings → 🧱 Walls) lists every wall, exposes
  per-wall member management (add by username, remove via ×), and a
  "Create wall" form with visibility=group|direct picker and group
  selector (populated from `GET /api/groups`).
- **`lib/scope-display.js`** — fixed vocabulary entry
  `read:walls:household` so app manifests can request access to the
  household wall by its canonical name.
- **Smoke updates:**
  - `scripts/smoke-walls.js` rewritten with two cases: (1) fresh
    install, no DB writes — asserts the household wall is visible and
    postable by brandon out-of-the-box; (2) admin route grants access
    to a fresh media-club wall via the new POST /api/walls and
    POST /api/walls/:slug/members — still no DB writes.
  - `scripts/smoke-notifications.js` — switched all media-club
    references to household; kept the (legitimate test-infrastructure)
    quiet-hours override.
  - `scripts/smoke-porch-ui.js` — switched media-club → household,
    dropped the open-coded DB grant.
  - `scripts/test-walls.js` — assertions updated for the seeded
    wall; new Test 2 covers `createWall` / `adminAddMember` /
    `adminRemoveMember` including the group-grant path.
  - `scripts/test-invite-to-wall.js` + `scripts/test-feed-component.js`
    — media-club references switched to household.
- **`docs/DEFINITION-OF-DONE.md` + `CONTRIBUTING.md`** — fresh-install
  acceptance amendment: verification scripts may not perform setup
  the product itself cannot perform. Allowed test-infrastructure DB
  writes are enumerated (quiet-hours override, fresh-DB seed, schema
  mirrors in the test harness).

## v0.0.1 (2026-07-29)

- Initial public release.
- Tasks and chores with take-turns rotation, calendar, apps launcher with
  owner + open-mode, full-screen iframe shell, session auth.