# Homestead

A shared-life app for self-hosted households. Tasks and chores with
take-turns rotation, a calendar, and a launcher grid that opens your
self-hosted services in a full-screen iframe shell inside Homestead.

Mobile-first PWA — install it to a phone home screen and it behaves like a
native app. Single-container Node app with SQLite; no external runtime
dependencies.

## Features

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
- **Push notifications** — web-push reminders for chores due today,
  overdue chores, and rotating "your turn" handoffs. Per-user quiet hours
  and per-category on/off toggles. No Firebase — standard VAPID keys
  generated once and stored in `/data/vapid.json`. Requires the PWA to
  be installed to a phone home screen (iOS 16.4+ / Android Chrome).

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

### First-login install coach (v0.1.22+)

Non-technical friends don't always know to install a PWA to the Home
Screen. On the very first login from a fresh browser, Homestead
auto-opens an install coach sheet (PHA-2219) with platform-specific
instructions and an inline visual. Dismiss is sticky: a quiet
"Set up notifications" chip lives in the avatar menu thereafter and
opens the same sheet on tap — no nagging.

The coach never asks for notification permission itself. Permission
is requested only after the user installs, and only when they tap
"Enable push notifications" in the avatar menu (iOS denies are
painful to reverse, so we don't ask at the door).

Every step of the funnel (prompt shown → instructions opened →
installed → permission granted → first push delivered) is recorded
in `install_funnel_events` via `POST /api/funnel/install`. The
analytics dashboard (PHA-2210) reads those rows; until that ships,
ad-hoc SQL on the table is fine.

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

## Unraid

A Community Applications template ships in the repo at
[`unraid-template.xml`](unraid-template.xml). Drop the file on a share your
Unraid server can reach and point Community Applications at it.

## License

UNLICENSED. All rights reserved. Source is public for review and personal
use; redistribution, modification, and commercial use require explicit
permission.
