# Changelog

## Unreleased

### Security: `X-authentik-username` only counts from a listed proxy

Homestead signed in as whoever `X-authentik-username` named, from any client that could reach it, including as `admin`. It now believes that header (and `X-authentik-groups`) only when the TCP peer is in the new `HOMESTEAD_TRUSTED_PROXIES` (IPs or CIDRs, `loopback` as shorthand). When unset, which is the default, proxy sign-in is off, the headers are ignored, and the first one from an untrusted peer is logged once. The peer is the socket address, so a forged `X-Forwarded-For` doesn't help. This covers all three places that read the header: every authenticated route, `/api/me`, and invite redemption.

**Upgrading:** if you sign in through SWAG or nginx + an Authentik outpost, set `HOMESTEAD_TRUSTED_PROXIES` to the proxy's IP before upgrading, and make sure the proxy overwrites client-sent `X-authentik-*` headers (README, "Proxy sign-in"). OIDC and local login are unaffected. `scripts/test-header-trust-gate.js` sends the spoof and checks for 401, no session cookie and no user claimed.

### Security: no default admin password, no Plex token in entity data

- **First boot needs a real `ADMIN_PASSWORD`.** The seeded `admin` (and `brandon` / `emily` when their own variables are unset) used to fall back to `changeme`. Creating a new database now refuses to start if `ADMIN_PASSWORD` is unset, shorter than 8 characters, or a placeholder such as `changeme`. `BRANDON_PASSWORD` / `EMILY_PASSWORD`, when set, get the same check. Existing databases are unaffected: the seed runs only when the users table is empty. `docker-compose.yml` and the Unraid template no longer ship `changeme`.
- **Plex sync no longer stores the server's `X-Plex-Token`.** Plex `work` entities carried `thumb_url` / `art_url` with the token in the query string, and `/api/entities/*` returns `meta` to every signed-in user (the search index held it too). The sync now stores only the image paths (`thumb`, `art`), and the entity-graph boot migration removes the token from rows already stored. Rotate the Plex token if the instance had members who should not have it.

### Fixes

- Health checks: a service coming back up no longer sends admins a second "X is down / Down since null" push, and the checker no longer logs `prev_status is not defined` on every transition. Recovery calls `onUpTransition` (logged only).
- The Connected agents (tokens) and Calendar sources sheets no longer crash as soon as they have a row (`esc()` now accepts numbers).
- `GET /api/groups` works for every signed-in user again. An admin-only copy of the route shadowed it, so non-admins got a 403 and an empty Connectors page.
- Calendar sources now really re-sync in the background once their cache is more than 5 minutes old, as the README said. A source that just failed waits one window before the next try.
- Microsoft 365 calendar sources keep refreshed tokens. The refreshed token was used for one sync and then discarded.
- `/api/events/merged` returns each provider event's source `display_name`, so calendar pip labels show "Work" instead of the provider kind.
- The provider buttons on Add calendar source no longer clip at 390px; they wrap two per row.

### Security: app tokens reach only the routes their scopes name

An installed app's token used to work like a full login on any `/api` route that had no scope check of its own (for example `/api/users`, `/api/apps`, `/api/agent-tokens`). App tokens are now deny-by-default: they reach only the routes listed in `API_SCOPE_RULES` in `lib/scope-display.js`, and only with a scope that route accepts. Every other route, including routes added later, answers 403 `insufficient_scope`. A per-wall grant (`read:walls:media_club`) reaches only that wall; `read:walls` also covers the forum. A token whose scopes are not a JSON array now gets nothing instead of full access. Signed-in members and personal access tokens (`user` scope) are unchanged. `scripts/test-app-token-scope-guard.js` walks every authenticated route on the live router, mounted routers included, and fails if any is reachable without its scope.

- A request made with a token (app or personal) no longer gets a session cookie. It did: the cookie lasted 14 days, survived revoking the token, and, replayed without the token, skipped the scope check entirely. Stored sessions created that way are refused.
- The app API activity log now records the full path (`GET /api/lists`) for routes served by a mounted router; it recorded `GET /lists`.

### `/api/version` reports the release tag

Release images are built with `APP_VERSION` set from the git tag, and `/api/version` and `/api/health` report that ahead of `package.json`. Until now they said `0.6.0` on every v0.6.x release. `package.json` is now 0.6.7.

### PHATT ID assertions

Homestead accepts `Authorization: PhattId <assertion>`: a short-lived, Ed25519-signed PHATT ID assertion forwarded by a trusted PHATT server (The Lodge) on behalf of the signed-in member. Off unless `PHATTID_HUB_URL` or `PHATTID_HUB_KEY` is set; `PHATTID_AUD` (default `life.phatt.vip`, Homestead's own host) and `PHATTID_SCOPES` (default `read:me read:lists write:lists read:tasks write:tasks read:events`) tune it. The member is matched only through the `identity_links` row they made with Link PHATT ID (provider `authentik`), never by username. v0.6.4 also matched by equal username; v0.6.5 drops that, because PHATT ID usernames are member-chosen. Since v0.6.6 household membership comes from PHATT ID: a request needs `household` in the hub-signed `groups` (else 403 `not_household`), Homestead's own household membership follows that claim, and a household member with no Homestead user gets a password-less stand-in keyed on their PHATT ID uuid, which Link PHATT ID later hands over to their own account. PhattId requests reach only a fixed route table (snapshot, lists, tasks, events reads) and never get a session cookie. Everything else answers 403. See README, "PHATT ID assertions".

### The Forum: board UI with three switchable skins

`/forum` is now a real forum instead of a second copy of the wall feed. Index, board and thread views render one shared markup; the look comes from one of three stylesheets in `public/forum/`:

- **Woodgrain** (default): vBulletin 3 layout in Homestead colours.
- **Classic**: phpBB2 / subSilver.
- **Night Owl**: starfield, marquee, hit counter, beveled buttons, Top Posters sidebar.

Pick a style from the chooser in the forum footer or in User CP. The choice applies instantly and is saved per user (`users.forum_skin`, additive, NULL = Woodgrain). It is also mirrored to localStorage so the right skin paints before the API answers.

- Index: collapsible categories, NEW markers, last post, thread/post counts, and a "What's Going On?" panel (who's online, birthdays, stats).
- Board: stickies first, replies/views, pager, and a **New Thread** form (replaces the FAB composer on this page).
- Thread: postbit (avatar, rank, rank stars, join date, post count), signatures, Quote, Thanks/emoticon reactions, and Quick Reply with smilies.
- The header tabs (Forum · Gazette · Rooms · Invites · Members) replace the bottom tab bar and the "+ Add a room" pill on this page. Members is a simple member list.
- Deep links still work: `?wall=<slug>` opens a board, `?post=<id>` a thread.

**API:** `PATCH /api/forum/me` accepts `forum_skin` (`woodgrain` | `classic` | `clubhouse`, anything else is 400). New `GET /api/forum/me` returns the caller's forum profile and last visit. `/api/me` includes `forum_skin`. `/api/forum/stats` adds `views` (sum of thread views) and `topPosters`. Board index rows carry the seeded board `description`.

The shoutbox panel ships with the shoutbox backend (#149) - see below.

### Agent HMAC secrets envelope-encrypted at rest

### The Shoutbox

The household chat strip now has a home on the Forum index. The panel is one shared markup with the same box pattern the rest of the forum uses, so all three skins get it:

- **Night Owl** leads the right column with the Shoutbox; **Woodgrain** and **Classic** put it after "What's Going On?".
- A post box plus the recent shouts. The server's classic emoticon table (`:D`, `<3`, …) is applied at render time, and `/me` shouts render in the house style (* name).
- Shouts arrive live over the existing SSE feed at `/api/shoutbox/events` - no reload. The feed is closed when you leave the index.

The panel reads and writes the shoutbox API; no new endpoints, no schema change.

## v0.6.0 (2026-10-16) — fresh start

First release on a fresh history: earlier tags, releases and changelog entries were retired. Upgrading from v0.5.24 brings the changes below.

Image: `ghcr.io/phattbeats/homestead:v0.6.0`

### The Forum

The Porch becomes **The Forum**. Nav label, page title, registry `name` and the "Vote off the Forum" copy are renamed; the page lives at `/forum` and `/porch.html` 301-redirects there (query string preserved, so old `?wall=&post=` deep links still work). `/api/me.default_route` is now always `/forum`, and the SPA sends every user there once per browser session after login (`/?home=1` skips it).

**Data model (all additive, idempotent):** `wall_posts.title/sticky/views`, `walls.category/sort`, `users.signature/birthday/last_active_at/last_visit_at`. A board is a wall, a thread a wall post, a reply a post comment — no second content store. Post counts and ranks are derived, never stored; Hearth shows as *Moderator · House Agent*. Three starter boards are seeded once (Announcements, General Chit-Chat = the existing Porch wall, Introduce Yourself); the old `Household Porch` name is rewritten, custom names are left alone.

**API:** `GET /api/forum/index`, `/boards/:slug/threads`, `/threads/:postId`, `/online` (15-min window), `/stats` (incl. birthdays); `PATCH /api/forum/threads/:postId` (admin sticky); `PATCH /api/forum/me` (signature, birthday). `POST /api/walls/:slug/posts` accepts an optional `title`.

### Other

- Boot errors about `SESSION_SECRET` now say where to set it.
- README rewritten as a generic public README.
