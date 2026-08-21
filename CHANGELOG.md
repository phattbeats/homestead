## Unreleased — PHA-2149 (PHA-2147.1) — media storage primitive

- **`lib/media.js`.** General-purpose content-addressed media store —
  the foundation Porch walls (PHA-2147.2), entity-graph covers,
  list-item photos, and Popcorn Vote (PHA-2052) build on.
  - `media_uploads` table, migrated in the same boot-migration chain
    as `entityGraph`/`agentTokens`/`calendarSources`.
  - `POST /api/media` (auth, multipart `file` field): `sharp`
    downscales images over 2048px and generates a 320px JPEG thumb;
    videos pass through raw (transcoding is out of scope). Size caps
    `image 10MB / video 50MB`, mime allowlist (jpeg/png/webp,
    mp4/webm/quicktime). Uploads are deduped by sha256 — a
    byte-identical re-upload returns the existing row's id instead of
    writing a second copy.
  - `GET /api/media/:id` / `/api/media/:id/thumb` — `res.sendFile`
    with `Cache-Control: private, max-age=3600`. Video thumb requests
    fall back to the original file (no video thumbnailing yet).
  - `DELETE /api/media/:id` (owner or admin) — soft-delete
    (`deleted_at`), 24h grace window before the retention sweep reaps
    the file + row so posts referencing the media don't 404
    mid-transition.
  - Retention sweep (`cleanupSweep`) piggybacks on the existing
    30-minute scheduler tick — reaps expired (`expires_at`) and
    grace-expired soft-deleted rows.
  - Storage path: `DATA_DIR/media/{yyyy-mm}/{sha256-prefix}/{sha256}.{ext}`.
- New deps: `sharp`, `multer`. Both resolve via prebuilt binaries on
  `node:22-bookworm-slim` (Dockerfile stage 1) — no libvips apt
  package needed.
- Tests: `scripts/test-media.js` (happy path, dedupe, mime allowlist,
  oversized rejection, retention expiry, soft-delete + grace window),
  `scripts/smoke-media.js` (end-to-end upload/fetch/thumb against a
  live server, `Cache-Control` header check). Both wired into
  `npm test` / `npm run test:smoke`.
- Fixed `scripts/smoke-push.js`, which required a hardcoded
  contributor-local absolute path to `server.js` and broke the
  `npm run test:smoke` chain for anyone else.

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

## Unreleased — PHA-2210 (PHA-2200 capture layer) — analytics events

- **`lib/analytics.js` (new).** Capture layer for the Homestead
  analytics pipeline. Design lives in comment `b627c024-…` on
  PHA-2210 (schema review approved by Brandon 2026-08-21 04:16).
  Three rules govern the module:
  - **Best-effort.** A failed `analytics_events` INSERT never throws
    into the caller's request path; capture is supposed to be
    invisible. Same fire-and-forget contract as `notification_log`.
  - **Closed enum.** `KINDS` is a frozen Set of 23 event kinds;
    `logEvent` validates against it at the helper layer (no schema
    CHECK, per the existing polymorphic-TEXT pattern in
    `notification_log.category` / `wall_posts.kind`).
  - **`logMutation` dual-write.** Wall mutations share one helper
    that writes BOTH `notification_log` (user-facing activity feed)
    AND `analytics_events` (operator dashboard source) atomically
    from one call site. For non-wall mutations, callers use
    `logEvent` directly.
- **`analytics_events` table** (migrated by `analytics.migrate(db)`
  after `walls.migrate(db)` to keep FK-to-users ordering).
  Append-only log with `id`, `ts`, `user_id`, `kind`,
  `subject_type`, `subject_id`, plus the two promoted INTEGER
  columns: `bytes` (media uploads) and `duration_seconds`
  (sessions + drawer calls). 4 indexes: `ts`, `(user_id, ts)`,
  `(kind, ts)`, and a partial `(bytes, ts) WHERE bytes IS NOT NULL`.
- **Wired call sites this PR:**
  - `lib/walls.js`: `wall_post_created`, `wall_reaction_added`,
    `wall_comment_added` via `logMutation` (dual-write); plus
    `first_post` / `first_reaction` funnel signals via `logFirst`.
  - `lib/media.js`: `media_uploaded` with `bytes` populated.
  - `lib/health-checker.js`: `tile_health_transition` on UP ↔ DOWN
    flips.
  - `server.js`: `session_started` (both header-trust and password
    paths) + `session_ended` with `duration_seconds`; `first_login`
    funnel signal; `drawer_call_completed` / `drawer_call_failed`
    on the `/api/drawer` route with `duration_seconds`; `push_delivered`
    / `push_failed` per push subscription.
- **`logFirst(db, entry)` helper.** Like `logEvent` but only writes
  if no row of `(user_id, kind)` exists yet — the funnel signal
  guard for `first_login` / `first_post` / `first_reaction`.
  Idempotent on retry.
- **`prune(db, opts)` helper.** 180-day raw cap with nightly
  rollups into `daily_stats` (rollups land in follow-up 1). Idempotent
  and safe to call on every scheduler tick.
- **Deferred to follow-ups** (per the schema review ship-sequence):
  rollups into `daily_stats`, operator dashboard behind
  `admins-group`, Hearth-facing read API behind PAT.
  Module-lifecycle events (`module_enabled` / `module_disabled` /
  `module_first_enable`) wire themselves when PHA-2200 lands on
  main — capture schema is structural and stable regardless.
- **Version:** 0.1.21 → 0.1.22 (PHA-2210 ships on the v0.1.22 line
  ahead of the v0.3.0 release branch; capture works without the
  module registry being live, so it doesn't have to wait for the
  PHA-2200 gate).
- **Tests:** `scripts/test-analytics-capture.js` (69 assertions
  across 12 sections: KINDS shape, schema + indexes, logEvent
  basic/closed-enum/promoted-columns, logMutation dual-write +
  best-effort, logFirst dedup, prune, call-site imports, package
  version, npm-test wiring). Full `npm test` chain exit 0; existing
  tests (test-walls, test-media) updated to mirror the analytics
  tables so they don't trigger the best-effort warning stderr noise.

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
