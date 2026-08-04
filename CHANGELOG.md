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