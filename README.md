# Homestead

A shared-life app for self-hosted households. Tasks and chores with
take-turns rotation, a calendar, and a launcher grid that opens your
self-hosted services in a full-screen iframe shell inside Homestead.

Mobile-first PWA — install it to a phone home screen and it behaves like a
native app. Single-container Node app with SQLite; no external runtime
dependencies.

## Features

- **Modular onboarding (v0.3.0)** — Homestead greets every new user
  with a single room — the Porch, a feed of posts from the wall they
  were invited to — and nothing else. Adding a module (Lists,
  Calendar, Chores, Apps, Agent) adds a room. The agent is opt-in
  so the BYOK "paste your key" ask arrives after the user already
  likes the app. Substrate features (entity graph, activity feed,
  media, push, auth) are always on. Existing users see no change —
  every module is enabled for you automatically. See [Modular
  nature](#modular-nature-v030) below for the registry contract.

- **Tasks** — assign to any user or to Everyone. Due dates, repeat
  daily/weekly/monthly. The "take turns" toggle swaps the assignee between
  the assigned users every time a recurring chore is checked off — checking
  off a recurring task rolls it forward instead of marking it done.
- **Calendar** — month grid with per-person colour pips. Tap a day to see
  or add events. **Universal read-through (v0.1.9):** events created
  in any configured external calendar (Nextcloud / Apple iCloud /
  MS365 / Google) appear in the grid without a Homestead-side entry.
  **Per-user source config UI (v0.1.13):** avatar menu → Calendar
  sources to add / edit / delete / refresh any provider source. See
  [Calendar read-through](#calendar-read-through-universal-caldav--graph--google)
  below for setup.
- **Entity graph (v0.1.6)** — Phase B-2 Kavita sync worker
  (PHA-1624 Phase B-2, PHA-1874) walks your Kavita library every 6h
  and reconciles manga + book series into Homestead's entity graph.
  Kavita authors become `person` entities (lowercased-name dedup per
  design doc §14); Kavita genres + tags become `concept` entities
  (slug-keyed dedup). Cross-library sibling works (same title +
  year, different editions or languages) emit `available_as` edges.
  Edges: `authored_by`, `tagged_with`, `available_as`. Manual
  trigger: `POST /api/admin/sync/kavita` (admin-only); status:
  `GET /api/admin/sync/kavita/status`. Set `KAVITA_API_KEY` (and
  optionally `KAVITA_URL`) in the container env to enable. Skipped
  silently when unset so installs without Kavita keep working.
- **Entity dedup + review queue (v0.1.11)** — Phase C (PHA-1624 /
  PHA-1876) decision layer. `lib/dedup/matcher.js` runs a 3-tier
  identity check on every new `work` candidate: (1) deterministic
  ID match across `isbn / tmdb_id / audible_id / plex_guid /
  kavita_id`, (2) shared TMDB collection + same year, (3) fuzzy
  title + author (`0.6 * title_sim + 0.3 * author_sim +
  0.1 * year_proximity`). Tier 1/2 emit `adaptation_of` edges
  between siblings (never merge); Tier 3 ≥ 0.9 auto-aliases;
  Tier 3 0.7..0.9 emits a row in `entity_review_queue` for human
  review. The entity page shows a "⚠️ Needs review" badge +
  Merge/Don't merge buttons when there are pending items; the
  manual merge endpoint (`POST /api/review-queue/:id/merge`) is
  the **only** path that collapses two entities. A 6h cron
  (`POST /api/admin/sync/sibling-detector`) catches same-title +
  same-author works that aren't linked via `adaptation_of`.
- **Entity graph (v0.1.5)** — Plex sync worker (PHA-1624 Phase B-1)
  walks your Plex library every 6h and reconciles movies / shows /
  seasons / episodes into Homestead's entity graph (`works`, `people`,
  `concepts`) with typed edges (`available_as`, `part_of`,
  `tagged_with`, `directed_by`). The graph is the meta-agent's (PHA-1617)
  primary sense organ and powers the cmd-K search palette (Phase A).
  Manual trigger: `POST /api/admin/sync/plex` (admin-only); status:
  `GET /api/admin/sync/plex/status`. Set `PLEX_TOKEN` (and optionally
  `PLEX_URL`) in the container env to enable.
- **Services launcher** — editable tile grid (long-press a tile to edit).
  Tap a tile to open the service inside Homestead in a full-screen iframe,
  with a draggable escape dot (tap to return to the dashboard; drag to
  reposition, it snaps to an edge and fades when idle). Tiles marked
  "New tab" open normally instead. Each tile has an owner (any user or
  Everyone); the grid shows yours plus shared by default, with a
  "showing mine / all" toggle.
- **Per-service health checks (v0.0.6)** — every tile gets an optional
  `health_url` (defaults to the tile URL) and a check interval. The
  server polls each tile on its own schedule; two consecutive failures
  mark the tile down and a red dot + "down since HH:MM" badge appears
  on it. Tap-through still works. 401/403 are treated as UP (auth walls
  are healthy). The unauthenticated `GET /api/services/health` returns
  the full per-service state for agents and monitoring.
- **Session auth** — `bcrypt`-hashed passwords, signed session cookies,
  90-day rolling expiry.
- **Per-user personal access tokens (v0.1.15, PHA-1617.3)** — avatar
  menu → **🔌 Connected agents** opens the token manager. Mint a PAT
  to give your own agent (OpenClaw, scripts, anything MCP-speaking)
  bearer-token access with exactly your session's powers. Plaintext is
  shown **once** in a copy-once modal (navigator.clipboard + manual-
  select fallback); Homestead only stores the bcrypt hash. List, view
  the 16-char non-secret prefix, revoke. The PAT layer is the
  contract for the upcoming chat drawer (PHA-1617.5/.6) and the
  MCP server (PHA-1617.8). See [Personal access tokens](#personal-access-tokens-pha-16173) below.
- **The Porch Wall (PHA-2151 + PHA-2206)** — `/porch.html` is the
  standalone thin shell when the wall module is the user's only
  enabled room; when other modules are also enabled, the SAME feed
  surface mounts in-place inside `#page-porch` of the SPA via
  `window.HomesteadFeed.mount(target, opts)`. The shared component
  lives at `public/components/feed.js`. Either way you get a
  chronological, group-scoped photo/video/link/text feed on top of
  the media (PHA-2149) and walls (PHA-2150) primitives:
  drag-drop / paste / file-picker upload with progress and a
  friendly "too large" toast, link posts with a best-effort
  server-side title/description preview (`GET /api/link-preview`),
  2000-char text posts, five-emoji reactions (👍😂🔥👀❤️, idempotent
  toggle), and flat inline comments. Pagination is an explicit
  "Older" button (cursor-based, 20 at a time) — no infinite scroll.
- **Push notifications** — web-push reminders for chores due today,
  overdue chores, and rotating "your turn" handoffs. Per-user quiet hours
  and per-category on/off toggles. No Firebase — standard VAPID keys
  generated once and stored in `/data/vapid.json`. Requires the PWA to
  be installed to a phone home screen (iOS 16.4+ / Android Chrome).

## Modular nature (v0.3.0)

v0.3.0 ships Homestead as a **feed-first, modular** app. The
core deliverable is the Porch — a single-room feed of posts from
a wall the user was invited to. Every other "room" (Lists,
Calendar, Chores, Apps, Agent) is opt-in: the user enables it
when they're ready, and it shows up as another tab. The agent is
opt-in so the "paste your key" prompt doesn't gate the first-run
experience.

### The module registry

Every module Homestead can render — built-in or third-party — is
declared in a single registry at `lib/modules.js`. The registry
ships in source. It is the **shared intake path** for both
built-in modules and (future) third-party apps per PHA-2201.

The registry holds six built-ins for v0.3.0:

| Key       | Name    | Open mode | Default | Requires |
|-----------|---------|-----------|---------|----------|
| `wall`    | Porch   | frame     | ✅      | —        |
| `lists`   | Lists   | frame     | ❌      | —        |
| `calendar`| Calendar| frame     | ❌      | —        |
| `chores`  | Chores  | frame     | ❌      | `lists`  |
| `apps`    | Apps    | frame     | ❌      | —        |
| `agent`   | Agent   | drawer    | ❌      | —        |

`wall` is the only module that is enabled for new users (per
Amendment 2 from PHA-2200, comment `04093be5`). Adding a new
module to the registry MUST NOT backfill existing users — see
the `scripts/test-default-off-future.js` acceptance test for the
discipline contract.

### Third-party app contract

A third-party app registers by providing a manifest entry that
satisfies the same 16-field shape as a built-in (see
`lib/registry-validate.js` `REQUIRED_FIELDS`):

```
key, name, description, icon, room, requires, tier,
version, author, url, open_mode, scopes, mcp,
webhooks, entity_kinds, default_enabled
```

`validateEntryShape(entry)` is the canonical intake gate. Built-in
modules and third-party apps go through the **same function** —
no private internal-only fields are allowed. See
`scripts/test-shared-registry-third-party.js` for the validator
symmetry proof.

### Three layout shapes

The SPA bootstrap (`GET /api/me/layout`) returns one of four
shapes based on the user's enabled-set size:

| Layout      | Enabled count | What the SPA renders |
|-------------|---------------|----------------------|
| `empty`     | 0             | Onboarding — no rooms, `+ Add rooms` pill |
| `feed-only` | 1             | Single tab (no drawer chrome) |
| `feed-tabs` | 2–3           | Top tab strip + drawer chrome |
| `meadow`    | 4+            | Full grid + drawer + add-room pill |

`agentDrawer: true` is set when the `agent` module is enabled
(so the SPA renders the chat-drawer FAB). `addRoomVisible: true`
when at least one module in the registry is not yet enabled by
this user (drives the `+ Add rooms` pill).

### Cascade rules

When a module declares `requires: [...]` (e.g. `chores` requires
`lists`), enabling the module without the requirement flag
throws `requires_unmet` with the unmet list. The caller can
retry with `{ withRequirements: true }` to cascade. Disabling
a module that has active dependents (`lists` → `chores`) throws
`dependents_active` until `{ withDependents: true }` is passed.
See `scripts/test-requires-cascade.js`.

### Agent gate (PHA-2208 / PHA-2200.7)

The `agent` module is a deliberate toggle. When disabled:

- The chat-drawer FAB (`#drawerFab`) carries the `off` class
  (CSS hides it via `opacity:0 + pointer-events:none + scale(.7)`).
- `POST /api/drawer` returns 403 `{ error: 'agent_disabled' }`.
- `GET /api/gazette/brief` returns 403 `{ error: 'agent_disabled' }`.

The SPA flips the FAB class on `boot()` and on every
`applyAgentFab()` invocation (the helper is exposed on `window`
so the add-a-room sheet can re-call it after a live
enable/disable). The server-side gate is a separate check at
the route entry from the HMAC-signed dispatcher (PHA-1617.6) —
both run, neither bypasses. The 200 body of `/api/gazette/brief`
is a placeholder; the real wire shape lands with PHA-1617's
brief-assembly contract. See `scripts/test-agent-gating.js` for
the 33-assertion acceptance suite.

## Calendar read-through (universal: CalDAV / Graph / Google)

Homestead reads events from configured external calendars through a
provider-agnostic `CalendarSource` interface. **v0.1.13** ships three
adapters behind the same contract:

  * **`CalDAVSource`** — Nextcloud and Apple iCloud, one implementation
    parameterized on `base_url` (HTTP Basic auth with an app-password).
  * **`GraphSource`** (PHA-1864) — Microsoft 365 via Microsoft Graph
    (`/me/calendars/{id}/calendarView`). OAuth2 access + refresh
    tokens; the adapter refreshes on 401 / pre-emptively on
    `expires_at`. Wire with the Azure app registration whose
    `Calendars.Read` offline-access scope was granted.

`GoogleSource` (PHA-1865) is the next child issue — the provider name
is reserved in the API allow-list so the UI can ship before that lands;
POST is rejected with 501 today. The PHA-1868 per-user source config
UI lists google in the add-source picker but marks it as
**coming soon** until PHA-1865 merges.

### Setup

1. Generate an at-rest credential key:

       openssl rand -hex 32

   Store it as `CALENDAR_CRED_KEY` in the runtime environment. Until
   this is set, `/api/health.ok` flips to `false` and
   `POST /api/calendar-sources` returns 503.

2. Generate the per-provider credential:

       - Nextcloud: Settings → Security → App passwords
       - Apple iCloud: https://appleid.apple.com → Sign-In and Security
         → App-Specific Passwords (2FA required)
       - Microsoft 365: an Azure app registration with the
         `Calendars.Read` and `offline_access` scopes; complete the
         OAuth2 device-code or auth-code flow and capture the resulting
         `access_token` + `refresh_token` pair (the adapter refreshes
         on 401 / `expires_at`)

3. **Add the source via the UI** (avatar menu → Calendar sources →
   + Add source, v0.1.13). The sheet is provider-aware: CalDAV
   sources need an app-password; Microsoft 365 sources need an
   access token + refresh token + client_id (Azure app registration).
   For a household-shared calendar (e.g. Nextcloud's Shade/Kelly
   Household), tick the **Shared** checkbox (admin only).

   For scripted / bulk setups the curl payload is the same JSON the
   UI submits:

   CalDAV:

       curl -X POST -H 'Content-Type: application/json' \
         -b cookies.txt \
         -d '{
           "provider": "caldav_nextcloud",
           "account_id": "brandon",
           "calendar_id": "personal",
           "base_url": "https://nextcloud.phatt.vip/remote.php/dav",
           "display_name": "Personal",
           "color": "#7c9eb8",
           "app_password": "xxxx-xxxx-xxxx-xxxx"
         }' \
         http://homestead.lan:3080/api/calendar-sources

   Microsoft 365:

       curl -X POST -H 'Content-Type: application/json' \
         -b cookies.txt \
         -d '{
           "provider": "ms365",
           "account_id": "brandon@phatt.vip",
           "calendar_id": "AAMkAGRiYW5kb24tY2Fs",
           "display_name": "Work",
           "color": "#8a9ec4",
           "access_token": "<oauth2 access token>",
           "refresh_token": "<oauth2 refresh token>",
           "expires_at": "2026-08-15T20:00:00Z",
           "client_id": "<azure app client id>",
           "tenant_id": "common",
           "scope": "Calendars.Read offline_access"
         }' \
         http://homestead.lan:3080/api/calendar-sources

   The credentials are encrypted at rest (AES-256-GCM) and **never
   returned by any API endpoint**. To rename, recolor, or pause a
   source without re-prompting the credential, the UI uses
   `PATCH /api/calendar-sources/:id` (display_name / color /
   enabled). Disabling a source removes its events from the merged
   feed immediately; re-enabling brings them back the next time
   the merge endpoint runs a sync.

4. Read merged events via `/api/events/merged?from=YYYY-MM-DD&to=YYYY-MM-DD`.
   Each event carries `origin` (`native` or `provider:<provider>`) and
   `stale: bool` so the month grid can paint per-provider pips and
   per-provider stale badges.

### Operational notes

- **Freshness window is 5 minutes.** The cache is checked on every
  read; if `last_synced_at` is older than 5 minutes the merge endpoint
  kicks a background re-sync (errors land on `last_error` and the event
  keeps its `stale: true` flag).
- **No credentials reach the browser.** The DTO layer
  (`lib/calendar-sources.js#publicView`) is the single source of truth
  for what the client sees; the leak check is a load-bearing
  acceptance test.
- **Phase 2 write-back (v0.1.10, PHA-1866).** Homestead now round-trips
  events through CalDAV providers (Nextcloud, Apple iCloud) using
  RFC 4791 PUT/DELETE with `If-None-Match: *` on create and
  `If-Match: <etag>` on update/delete. Create / update / delete an
  event on a source via:
  - `POST   /api/calendar-sources/:id/events`
  - `PUT    /api/calendar-sources/:id/events/:externalId`
  - `DELETE /api/calendar-sources/:id/events/:externalId`

  The body shape is the same shape `vevent` has in the adapter
  contract: `{ title, description?, location?, start, end?, allDay? }`.
  A successful write returns `{ externalId, href, etag }` and fires
  a background re-sync so the next `GET /api/events/merged` picks up
  the change. Provider errors surface as 502 with the upstream status
  code. Recurrence editing is still deferred to a follow-up (PHA-1620
  step 4: single-VEVENT only).

## Push notifications

Homestead sends reminders via the [Web Push protocol](https://www.w3.org/TR/push-api/)
so you don't need a phone-number-bound service like Firebase. The flow:

1. On first boot the server generates a VAPID keypair (stored at
   `DATA_DIR/vapid.json`, mode 0600) and exposes the **public** key via
   `GET /api/push/vapid-public-key` (no auth).
2. After logging in, tap your avatar → **Enable push notifications**.
   The browser registers a `PushSubscription` with the push service and
   posts it to `POST /api/push/subscribe` (auth).
3. The server schedules a daily digest on a 30-minute tick:
   - **Chore due today / overdue** — categories: `chore_due`.
   - **Take-turns handoff** — categories: `take_turns` (only fires on
     the day the rotating chore's due date lands).
4. Each notification respects the user's quiet hours window (default
   21:00–08:00 local) and per-category toggle. Both are editable from
   the avatar menu.
5. Subscriptions that return 404 or 410 from the push service are
   pruned automatically; other failures increment a `failure_count` so
   a flapping endpoint can be investigated via `/data/life.db` directly.
6. Agents / automation can drive the same primitive via
   `POST /api/notify` with `{ userId | username, payload: { title, body,
   url, tag, category }, force }` — `force: true` bypasses quiet hours
   (use sparingly).

### iOS requirements

**iOS 16.4 or newer is required** for web push to a PWA. The PWA must
be installed to the Home Screen via **Safari → Share → Add to Home
Screen** before push permission is offered — push will silently no-op
when the app is opened in a regular Safari tab. After the install,
re-open Homestead from the Home Screen icon (not from Safari) and the
"Enable push notifications" button in the avatar menu will request
permission normally.

### Testing without a real device

```bash
# Get the VAPID public key (browser does this implicitly)
curl -s http://localhost:3080/api/push/vapid-public-key | jq

# After subscribing in the browser, you can fire a test push at any user
# from any authenticated session:
curl -s -c /tmp/c.txt -b /tmp/c.txt \
  -X POST http://localhost:3080/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"***"}'

curl -s -b /tmp/c.txt \
  -X POST http://localhost:3080/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"title":"Test","body":"hello from curl","tag":"manual-test"}}'
```

The endpoint returns `{ userId, username, delivered, skipped, errors }`
so a CI smoke test can assert on `delivered > 0` once the test client
has a real subscription.

## Personal access tokens (PHA-1617.3)

The token manager is the SPA-side of the per-user PAT backend shipped in
PHA-1617.1. The user-facing flow lives behind the avatar menu → **🔌
Connected agents** entry. From there, a user can:

1. **List** every token they own. Each row shows the label, a 16-char
   non-secret prefix chip (`homestead_pat_Xxxxxxxx…` — the prefix is
   stored in plaintext so the lookup index works without a bcrypt scan;
   the secret portion is hashed), the scope (`active` / `admin` /
   `revoked` / `expired`), and the created / expires / last-used
   metadata.
2. **Mint** a new token by hitting **+ New token**. The issue sheet
   takes a label (required, ≤ 64 chars) and an optional expiry date.
   On submit it `POST`s to `/api/agent-tokens`, then opens a
   **copy-once reveal modal** showing the plaintext in a dark
   monospace card. The plaintext is the only time the user will ever
   see it — the server only stores the bcrypt hash. The "I've stored
   it — close" acknowledgement button stays disabled until the user
   either fires the Copy button (which uses `navigator.clipboard.writeText`
   with a manual-select fallback for insecure origins) OR ticks the
   manual acknowledgement checkbox.
3. **Revoke** any token they own via the per-row action. Revocation
   is immediate — `DELETE /api/agent-tokens/:id` sets `revoked_at`,
   the prefix is removed from the partial unique index, and any
   subsequent `Bearer homestead_pat_…` request with that plaintext
   fails at the prefix lookup. There is no undo.

The UI is a pure SPA consumer of three endpoints that already exist on
`main`:

- `GET    /api/agent-tokens` — list the signed-in user's tokens
  (admin can pass `?user=<username>` to view another user's tokens;
  the v0 UI hides this behind the avatar menu and only shows own).
- `POST   /api/agent-tokens` — `{ label, expires_at? }` →
  `{ id, label, token_prefix, token_plaintext, expires_at, … }`.
  Returns the plaintext **once**; the row on disk never contains it.
- `DELETE /api/agent-tokens/:id` — revoke (owner-scoped;
  admin-only routes via `/api/users/:username/agent-tokens` are out
  of scope for this UI; the cross-household admin view belongs to
  the agent_endpoints surface planned for PHA-1617.4).

The full design contract lives in the PHA-1617 design doc (`doc
'meta-agent-socket-design' rev 1`), specifically §4 (PAT auth) and
§9.1 (this user settings UI). The PAT layer is the foundation for the
chat drawer (PHA-1617.5/.6), the events webhook (PHA-1617.7), and the
MCP server wrapper (PHA-1617.8); minting a token here is the only
thing the user has to do to unlock all four.

## Stack

- Node 22
- Express 5
- better-sqlite3 (single-file DB at `/data/life.db`, WAL mode)
- Plain HTML/CSS/JS frontend (no build step)

## Agent context (PHA-1617 — BYO-harness meta-agent socket)

- **`GET /api/me/snapshot`** (v0.1.18) — single-call morning-brief
  context for the connected harness. Returns the user's profile +
  groups, today's tasks/events/overdue, upcoming week, and recent
  activity in one round-trip. Auth required (session cookie, PAT, or
  header-trust). Send `X-Homestead-Tz: <IANA name>` to pin `today`
  to the user's wall clock. The same builder backs the future MCP
  tool (`homestead_get_user_context`) and the drawer POST `snapshot`
  field, so the envelope can't drift between callers. See the
  meta-agent-socket design doc §7 for the full schema.

## Quick start (Docker)

```bash
docker run -d \
  --name homestead \
  --restart unless-stopped \
  -p 3081:3080 \
  -v /path/to/data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e ADMIN_PASSWORD=changeme \
  ghcr.io/phattbeats/homestead:latest
```

Browse to `http://localhost:3081/`. Log in as `admin` with the seed
password, then go to Settings → Users to create household accounts.

### First-run setup

1. **Log in as `admin`** with the `ADMIN_PASSWORD` you set. The admin
   account is bootstrapped by the env var on the very first run only —
   change this password in-app immediately if it was left at the default.
2. **Create household users** from Settings → Users. Set a username and a
   temporary password for each person.
3. **Each user logs in** and changes their temporary password in-app.
   After that, password rotation is a regular user setting, not an env
   var.

The `ADMIN_PASSWORD` env var is read **only** when the database is first
created. Changing it later does nothing — delete `/data/life.db` to
re-seed (which wipes all data). Use the in-app password change for
everyday rotation.

## Docker Compose

See [`docker-compose.yml`](docker-compose.yml) for a Compose file using the
published GHCR image (no build step needed).

## Reverse proxy

Homestead trusts the upstream proxy (`app.set('trust proxy', 1)`) and sets
`SameSite=Lax` cookies, so it works behind any TLS-terminating reverse
proxy. Point a hostname at the container's port 3080 (the in-container
port; the compose example maps it to host 3081) and you're done.

If you want services launched from inside Homestead's iframe shell to work,
you'll likely need to relax their `X-Frame-Options` / `Content-Security-Policy`
headers in your proxy. Most self-hosted apps ship with restrictive iframe
headers by default. For nginx:

```nginx
location / {
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "frame-ancestors 'self' https://your-hostname";
    # ...your usual proxy_pass / proxy_set_header lines...
}
```

If a particular service still refuses to behave inside the frame, edit its
tile and switch "Open mode" to **New tab**.

## Configuration

| Env var            | Required     | Purpose                                                       |
|--------------------|--------------|---------------------------------------------------------------|
| `SESSION_SECRET`   | yes          | Long random string used to sign session cookies.             |
| `ADMIN_PASSWORD`   | first run only | Seed password for the `admin` user on first DB creation.    |
| `DATA_DIR`         | no           | Where the SQLite file lives. Defaults to `/data`.            |
| `PORT`             | no           | In-container listen port. Defaults to `3080`.                 |

The seed password is read **only** when the database is first created. Use
the in-app password change (admin: Settings → Users) to rotate a user's
password for real.

## Data

Everything lives in `/data/life.db`. Back this file up to keep tasks,
events, and your services launcher grid. The app runs migrations on boot
(ALTER TABLE adds new columns without touching existing data).

## Development

```bash
npm install
DATA_DIR=./data npm start
```

The first run will create `./data/life.db` and seed the admin user.

## Support (PHA-2223)

If Homestead has earned a coffee, you can chip in — but only if you want
to, and only via a single quiet link. The link is
[github.com/sponsors/phattbeats](https://github.com/sponsors/phattbeats)
(the `funding` field in `package.json` points at the same URL so package
managers surface it too). Self-hosters who don't have an account can
support the project without signing up for anything.

**What this surface deliberately is not:**

- **Not a payment system.** Homestead itself handles no money — no card
  data, no webhooks, no financial records in `life.db`. Clicking the
  link opens the provider's site in a separate origin (`_blank` +
  `noopener,noreferrer`); Homestead's window can't be reached from the
  provider's tab and the provider's cookies can't reach Homestead.
- **Not analytics.** The only measurement is one plain total in a single
  `donation_counter(id, count)` row — no click history, time buckets,
  `user_id`, IP, user-agent, or referer. By schema, not by promises.
- **Not nagware.** The link lives in **one place**: the avatar menu's
  "About Homestead" sheet. It does not appear on the wall, in the
  meadow, in the Gazette, in onboarding, or in any notification. If you
  didn't go looking, you won't see it.
- **Not a tier system.** There are no supporter badges, no perks, no
  priority queues. Access to Homestead is independent of any payment.

These rules are policy, not preference — see PHA-2223 for the full
reasoning. If anything on this list ever changes, it is a Brandon
decision recorded on that issue, not a product iteration.

The in-app link, README, and package metadata all use the same GitHub
Sponsors URL selected for Homestead. It is intentionally not configurable:
changing the commercial surface requires a Brandon decision recorded on
PHA-2223.

## Unraid

A Community Applications template ships in the repo at
[`unraid-template.xml`](unraid-template.xml). Drop the file on a share your
Unraid server can reach and point Community Applications at it.

## License

Homestead uses a **split license** (PHA-2222):

| What | License |
|------|---------|
| Source code in this repository (`server.js`, `lib/`, `public/*.js`, `scripts/*.js`) | [GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`) |
| Documentation, specifications, README, the module registry spec, and the third-party app contract (PHA-2201) | [Creative Commons Attribution 4.0 International](LICENSE-docs) (`CC BY 4.0`) |

Copyright (C) 2026 PHATT Tech LLC.

The code under AGPL means: if you run a modified version of Homestead on a
server that users interact with over a network, you must make the
corresponding source available to those users. Running the unmodified
software for personal use (friends, household, media club) carries no such
obligation.

The split is deliberate: the third-party app contract — the wire format
apps use to talk to Homestead over MCP/REST in an iframe — is **CC BY 4.0**
so anyone can implement it from a closed-source codebase or a different
language. The copyleft boundary lives in the code that *runs on your
server*, not in the protocol apps use to talk to it.

See [`LICENSE`](LICENSE) and [`LICENSE-docs`](LICENSE-docs) for the full
texts, and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the DCO sign-off rule
that applies to every contribution.
