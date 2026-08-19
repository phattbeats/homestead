# Changelog

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

## v0.0.1 (2026-07-29)

- Initial public release.
- Tasks and chores with take-turns rotation, calendar, apps launcher with
  owner + open-mode, full-screen iframe shell, session auth.