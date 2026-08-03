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
  or add events.
- **Services launcher** — editable tile grid (long-press a tile to edit).
  Tap a tile to open the service inside Homestead in a full-screen iframe,
  with a draggable escape dot (tap to return to the dashboard; drag to
  reposition, it snaps to an edge and fades when idle). Tiles marked
  "New tab" open normally instead. Each tile has an owner (any user or
  Everyone); the grid shows yours plus shared by default, with a
  "showing mine / all" toggle.
- **Session auth** — `bcrypt`-hashed passwords, signed session cookies,
  90-day rolling expiry.

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
