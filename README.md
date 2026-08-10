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
  or add events. **Universal read-through (v0.1.1):** events created in
  any configured external calendar (Nextcloud / Apple iCloud / MS365 /
  Google) appear in the grid without a Homestead-side entry. See
  [Calendar read-through](#calendar-read-through-universal-caldav--graph--google)
  below for setup.
- **Services launcher** — editable tile grid (long-press a tile to edit).
  Tap a tile to open the service inside Homestead in a full-screen iframe,
  with a draggable escape dot (tap to return to the dashboard; drag to
  reposition, it snaps to an edge and fades when idle). Tiles marked
  "New tab" open normally instead. Each tile has an owner (any user or
  Everyone); the grid shows yours plus shared by default, with a
  "showing mine / all" toggle.
- **Session auth** — `bcrypt`-hashed passwords, signed session cookies,
  90-day rolling expiry.
- **Push notifications** — web-push reminders for chores due today,
  overdue chores, and rotating "your turn" handoffs. Per-user quiet hours
  and per-category on/off toggles. No Firebase — standard VAPID keys
  generated once and stored in `/data/vapid.json`. Requires the PWA to
  be installed to a phone home screen (iOS 16.4+ / Android Chrome).

## Calendar read-through (universal: CalDAV / Graph / Google)

Homestead reads events from configured external calendars through a
provider-agnostic `CalendarSource` interface. v0.1.1 ships the first
adapter (`CalDAVSource`) covering both **Nextcloud** and **Apple iCloud**
via a single implementation parameterized on `base_url`. **Microsoft 365**
and **Google Calendar** are follow-up child issues that register behind
the same interface — no merge-layer or API-surface changes needed.

### Setup

1. Generate an at-rest credential key:

       openssl rand -hex 32

   Store it as `CALENDAR_CRED_KEY` in the runtime environment. Until
   this is set, `/api/health.ok` flips to `false` and
   `POST /api/calendar-sources` returns 503.

2. Generate an **app-password** for each provider:

       - Nextcloud: Settings → Security → App passwords
       - Apple iCloud: https://appleid.apple.com → Sign-In and Security
         → App-Specific Passwords (2FA required)

3. Add the source via the API (the UI is the PHA-1868 follow-up):

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

   The app-password is encrypted at rest (AES-256-GCM) and **never
   returned by any API endpoint**. For a household-shared calendar
   (e.g. Nextcloud's Shade/Kelly Household), set `shared: true` (admin
   only).

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
- **Phase 2 write-back** (createEvent / updateEvent / deleteEvent via
  CalDAV PUT) is tracked under PHA-1866 — single-VEVENT scope per the
  work order (recurrence editing deferred).

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

## Stack

- Node 22
- Express 5
- better-sqlite3 (single-file DB at `/data/life.db`, WAL mode)
- Plain HTML/CSS/JS frontend (no build step)

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
