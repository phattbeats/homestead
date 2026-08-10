# Changelog

## v0.1.8 (2026-08-10) — PHA-1622

- **Activity feed.** New `lib/activity.js` (`migrate`, `logActivity`,
  `listActivity`, `prune`) backing an `activity` table (id, ts,
  actor_user_id, verb, object_type, object_id, summary_text, meta
  json), joined against `users` at read time so the API returns
  actor display/color inline. `logActivity()` is best-effort — a
  broken feed row never fails the mutation it describes.
  Every mutating endpoint now logs exactly one row: task
  create/update/complete/reopen/delete (rotation swaps recorded in
  `meta.rotated_to`), event create/update/delete, service (tile)
  create/update/delete, user profile edit, and login — the last one
  gated on "new device only" (a session that didn't already carry
  that username), not every header-trust request, so it doesn't fire
  on every poll.
  `GET /api/activity?since&user&before&limit` serves the UI and
  future agent consumers (PHA-1617); `before` is an id cursor for
  pagination.
  Retention: prune() drops rows older than 90 days, then trims to the
  newest 10k if still over cap; wired into the existing 30-minute
  scheduler tick alongside the digest/sync jobs.
  UI: a reverse-chron "Activity" card on the Home page, consecutive
  same-actor rows grouped under one avatar dot, with a "Load more"
  cursor-paginated tail.
  Acceptance: 14 tests in `scripts/test-activity.js`; manually swept
  every mutating endpoint end-to-end (create/toggle/delete on tasks,
  events, services; login) and confirmed one activity row per call.

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
>>>>>>> origin/main

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

## v0.0.1 (2026-07-29)

- Initial public release.
- Tasks and chores with take-turns rotation, calendar, apps launcher with
  owner + open-mode, full-screen iframe shell, session auth.