# Changelog

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
