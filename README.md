# Homestead

![Homestead — Your home. Your data. Your apps.](docs/brand/homestead-banner.png)

A shared-life app for self-hosted households. Tasks and chores with
take-turns rotation, shared lists, a calendar, a group feed, and a launcher
grid that opens your self-hosted services in a full-screen iframe shell
inside Homestead.

Mobile-first PWA — install it to a phone home screen and it behaves like a
native app. Single-container Node app with SQLite; no external runtime
dependencies.

## Features

- **Modular rooms** — a new user lands on a single room, the Porch (a feed
  of posts from the wall they were invited to). Lists, Calendar, Chores,
  Apps, and Agent are opt-in rooms that each user enables when they want
  them. See [Modules](#modules).
- **Tasks** — assign to any user or to Everyone. Due dates, repeat
  daily/weekly/monthly. The "take turns" toggle swaps the assignee between
  the assigned users every time a recurring chore is checked off.
- **Shared lists** — a fresh household starts with Groceries; add packing
  or general lists as needed.
- **Calendar** — month grid with per-person colour pips, merged with events
  read (and written back) from external calendars. See
  [Calendar sources](#calendar-sources).
- **Feed (the Porch)** — chronological, group-scoped photo, video, link, and
  text posts with emoji reactions and inline comments. Live updates over
  server-sent events.
- **Services launcher** — editable tile grid. Tap a tile to open a service
  inside Homestead in a full-screen iframe, with a draggable escape dot to
  return to the dashboard. Tiles can instead open in a new tab. Each tile
  has an owner (a user or Everyone) and an optional health check that shows
  a "down" badge after consecutive failures.
- **Push notifications** — web-push reminders for chores due today, overdue
  chores, and take-turns handoffs, with per-user quiet hours. Standard VAPID
  keys; no Firebase. See [Push notifications](#push-notifications).
- **Agent access** — per-user personal access tokens let your own scripts or
  MCP-speaking agents act with exactly your session's permissions. See
  [Personal access tokens](#personal-access-tokens).
- **Session auth** — bcrypt-hashed passwords, signed session cookies,
  rolling expiry.

See the [glossary](docs/GLOSSARY.md) for the canonical name of every
user-facing surface.

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
  -e ADMIN_PASSWORD=choose-a-strong-password \
  ghcr.io/phattbeats/homestead:latest
```

Browse to `http://localhost:3081/` and log in as `admin` with the seed
password, then go to Settings → Users to create household accounts.

A Compose file is provided in [`docker-compose.yml`](docker-compose.yml);
edit the network and volume paths to match your environment.

### First-run setup

1. **Log in as `admin`** with the `ADMIN_PASSWORD` you set. The admin account
   is bootstrapped from that variable on the very first run only.
2. **Create household users** from Settings → Users with a temporary
   password for each person.
3. **Each user logs in** and changes their password in-app.

`ADMIN_PASSWORD` is read **only** when the database is first created.
Changing it later does nothing; rotate passwords in-app. (Deleting
`/data/life.db` re-seeds but wipes all data.)

## Configuration

| Env var             | Required       | Purpose                                                              |
|---------------------|----------------|----------------------------------------------------------------------|
| `SESSION_SECRET`    | yes            | Random string (32+ chars) used to sign session cookies. The server refuses to boot without a real value. |
| `ADMIN_PASSWORD`    | first run only | Seed password for the `admin` user on first DB creation.             |
| `DATA_DIR`          | no             | Where the SQLite file lives. Defaults to `/data`.                    |
| `PORT`              | no             | In-container listen port. Defaults to `3080`.                        |
| `CALENDAR_CRED_KEY` | for calendar sources | 32-byte hex key used to encrypt calendar credentials at rest (`openssl rand -hex 32`). |
| `PLEX_URL`, `PLEX_TOKEN` | no        | Enables the optional Plex library sync.                              |
| `KAVITA_URL`, `KAVITA_API_KEY` | no  | Enables the optional Kavita library sync.                            |

## Data

Everything lives in `/data/life.db`. Back this file up to keep tasks,
events, and your launcher grid. Migrations run on boot and never touch
existing data.

## Reverse proxy

Homestead trusts one upstream proxy (`app.set('trust proxy', 1)`) and sets
`SameSite=Lax` cookies, so it works behind any TLS-terminating reverse
proxy. Point a hostname at the container's port 3080.

To launch services inside the iframe shell you will usually need to relax
their `X-Frame-Options` / `Content-Security-Policy` headers in your proxy.
For nginx:

```nginx
location / {
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "frame-ancestors 'self' https://your-hostname";
    # ...your usual proxy_pass / proxy_set_header lines...
}
```

If a service still refuses to render in the frame, edit its tile and switch
"Open mode" to **New tab**.

## Modules

Every room Homestead can render is declared in a single registry at
`lib/modules.js`. The built-ins:

| Key        | Name     | Open mode | On for new users | Requires |
|------------|----------|-----------|------------------|----------|
| `wall`     | Porch    | frame     | yes              | —        |
| `lists`    | Lists    | frame     | no               | —        |
| `calendar` | Calendar | frame     | no               | —        |
| `chores`   | Chores   | frame     | no               | `lists`  |
| `apps`     | Apps     | frame     | no               | —        |
| `agent`    | Agent    | drawer    | no               | —        |

- Adding a module to the registry never backfills existing users; it ships
  default-off.
- Enabling a module whose requirement is off fails with `requires_unmet`
  unless the caller passes `{ withRequirements: true }`. Disabling a module
  that others depend on fails with `dependents_active` unless
  `{ withDependents: true }` is passed.
- Third-party apps use the same intake path as built-ins: a manifest that
  passes `validateEntryShape` in `lib/registry-validate.js`.

`GET /api/me/layout` returns the SPA layout for the user's enabled set:
`empty` (0 modules), `feed-only` (1), `feed-tabs` (2–3), or `meadow` (4+).

## Calendar sources

Homestead merges events from external calendars through a provider-agnostic
`CalendarSource` interface:

- **CalDAV** — Nextcloud and Apple iCloud (HTTP Basic with an app password).
  Supports create, update, and delete write-back.
- **Microsoft 365** — via Microsoft Graph, using OAuth2 access and refresh
  tokens from your own Azure app registration (`Calendars.Read`,
  `offline_access`).
- **Google** — reserved in the API; not yet implemented.

### Setup

1. Generate an at-rest credential key and set it as `CALENDAR_CRED_KEY`:

       openssl rand -hex 32

   Until it is set, `POST /api/calendar-sources` returns 503; the core
   health probe is unaffected.

2. Create a credential at your provider (a Nextcloud or iCloud app password,
   or an Azure app registration for Microsoft 365).

3. Add the source from the avatar menu → Calendar sources → + Add source, or
   post the same JSON the UI submits:

       curl -X POST -H 'Content-Type: application/json' \
         -b cookies.txt \
         -d '{
           "provider": "caldav_nextcloud",
           "account_id": "alice",
           "calendar_id": "personal",
           "base_url": "https://cloud.example.com/remote.php/dav",
           "display_name": "Personal",
           "color": "#7c9eb8",
           "app_password": "xxxx-xxxx-xxxx-xxxx"
         }' \
         http://localhost:3081/api/calendar-sources

   Admins can tick **Shared** to make a source visible to the household.

4. Read merged events with
   `GET /api/events/merged?from=YYYY-MM-DD&to=YYYY-MM-DD`. Each event
   carries `origin` (`native` or `provider:<provider>`) and a `stale` flag.

Credentials are encrypted at rest (AES-256-GCM) and never returned by any
API endpoint. Sources are re-synced in the background when the cache is more
than 5 minutes old. Write-back endpoints:

- `POST   /api/calendar-sources/:id/events`
- `PUT    /api/calendar-sources/:id/events/:externalId`
- `DELETE /api/calendar-sources/:id/events/:externalId`

## Push notifications

Reminders use the [Web Push protocol](https://www.w3.org/TR/push-api/).

1. On first boot the server generates a VAPID keypair at
   `DATA_DIR/vapid.json` (mode 0600) and serves the public key at
   `GET /api/push/vapid-public-key`.
2. After logging in, tap your avatar → **Enable push notifications**.
3. A 30-minute tick sends chore-due, overdue, and take-turns handoff
   reminders, respecting each user's quiet hours (default 21:00–08:00) and
   per-category toggles.
4. Subscriptions that return 404 or 410 are pruned automatically.
5. Automation can send a notification with `POST /api/notify`
   (`{ userId | username, payload: { title, body, url, tag, category },
   force }`); `force: true` bypasses quiet hours.

**iOS 16.4 or newer is required**, and the PWA must be installed via
Safari → Share → Add to Home Screen before push permission can be granted.
A first-login install coach walks new users through this; it never requests
notification permission itself.

## Personal access tokens

Avatar menu → **Connected agents** opens the token manager. A token gives
your own agent or script bearer-token access with exactly your session's
powers.

- `GET /api/agent-tokens` — list your tokens.
- `POST /api/agent-tokens` — `{ label, expires_at? }`. The plaintext token
  is returned **once**; only a bcrypt hash is stored.
- `DELETE /api/agent-tokens/:id` — revoke immediately. There is no undo.

Use a token as `Authorization: Bearer homestead_pat_…`.
`GET /api/me/snapshot` returns a single-call summary (profile, today's
tasks and events, the upcoming week, recent activity) intended for agents;
send `X-Homestead-Tz: <IANA name>` to pin "today" to the user's clock.

## Development

```bash
npm install
DATA_DIR=./data SESSION_SECRET="$(openssl rand -hex 32)" npm start
npm test
```

The first run creates `./data/life.db` and seeds the admin user. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
before opening a pull request.

## Unraid

A Community Applications template is included at
[`unraid-template.xml`](unraid-template.xml).

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Source is public; noncommercial use
is permitted under the terms of that license.
