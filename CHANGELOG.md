# Changelog

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