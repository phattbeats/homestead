# Changelog

## Unreleased

### The Forum

The Porch becomes **The Forum**. Nav label, page title, registry `name` and the "Vote off the Forum" copy are renamed; the page lives at `/forum` and `/porch.html` 301-redirects there (query string preserved, so old `?wall=&post=` deep links still work). `/api/me.default_route` is now always `/forum`, and the SPA sends every user there once per browser session after login (`/?home=1` skips it).

**Data model (all additive, idempotent):** `wall_posts.title/sticky/views`, `walls.category/sort`, `users.signature/birthday/last_active_at/last_visit_at`. A board is a wall, a thread a wall post, a reply a post comment — no second content store. Post counts and ranks are derived, never stored; Hearth shows as *Moderator · House Agent*. Three starter boards are seeded once (Announcements, General Chit-Chat = the existing Porch wall, Introduce Yourself); the old `Household Porch` name is rewritten, custom names are left alone.

**API:** `GET /api/forum/index`, `/boards/:slug/threads`, `/threads/:postId`, `/online` (15-min window), `/stats` (incl. birthdays); `PATCH /api/forum/threads/:postId` (admin sticky); `PATCH /api/forum/me` (signature, birthday). `POST /api/walls/:slug/posts` accepts an optional `title`.

### Other

- Boot errors about `SESSION_SECRET` now say where to set it.
- README rewritten as a generic public README.

## v0.5.24 (2026-09-07) — baseline

First release on the current version line. Earlier tags, releases and changelog entries were retired; the full history is in git.

Image: `ghcr.io/phattbeats/homestead:v0.5.24`
