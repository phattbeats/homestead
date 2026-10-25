# Changelog

## Unreleased

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
