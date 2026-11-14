# Removing someone from PHATT ID: runbook

Status: **Homestead, Nextcloud, SillyTavern tested on the live app with a throwaway account. Authentik, Ghost, TeamSpeak tested on throwaway containers of the same image/version as prod. Plex is a manual unshare step, accepted untested by Brandon. Clubhouse/Arcade not tested** (see section 6). Issue: PHA-5023. Related: PHA-4953 (Clubhouse cut-off), PHA-4102 (delete hooks), PHA-4090 (export/delete round trip), `docs/architecture/PASSWORD-RECOVERY.md`.

Rules: a real member is never touched while testing. Use a `zz-offboard-<date>` account. No secrets in tickets or logs.

Legend: **AUTO** = happens with no human action once the PHATT ID changes. **MANUAL** = an operator does it. **UNVERIFIED** = written from how the app works, not yet run.

## 0. Decide: disable or delete
- **Disable** (reversible): steps 1-2 plus the per-app access cuts. Data stays.
- **Delete** (permanent): export first (section 3), get Brandon's OK on the manifest, then section 4. Never delete without a written export.
- Never run this on the owner/`admins` group member.

## 1. Turn off the PHATT ID (Authentik, auth.phatt.vip) — MANUAL
1. Admin > Directory > Users > the user > set **inactive** (API: `PATCH /api/v3/core/users/<pk>/` `{"is_active": false}`; shell: `ak shell -c` then `u.is_active=False; u.save()`). TESTED 2026-11-13 on a throwaway 2026.8.5 container.
2. Admin > Directory > Users > user > **Sessions**: delete all sessions. Revoke their tokens/app passwords.
3. Record the user pk and time in the ticket (no other identifiers).

Effect of step 1: no new SSO logins anywhere. Existing app sessions live on until each app's own session ends, so the per-app steps below still matter.

## 2. Per-app access cut (disable)

| App | What happens | Auto/Manual |
|---|---|---|
| Clubhouse + Arcade | Access cut within seconds of the PHATT ID going inactive (PHA-4953). Verify, don't assume. | AUTO |
| Homestead | OIDC login fails. Existing cookie session persists until expiry; admin can't revoke it from the UI. Delete the user (section 4) to kill it. Local password, if any: set via `scripts/reset-owner-password.js` is NOT a disable. | AUTO (login) / MANUAL (live session) |
| Plex | Unshare every library the user has access to (Settings > Users & Sharing > user > untick all libraries / remove friend). Also kill active streams. | MANUAL (accepted untested by Brandon 2026-11-14) |
| Ghost | Staff users: Settings > Staff > Suspend (Admin API `PUT /users/<id>/` `{"status":"inactive"}`). Members: Members > the member > delete (`DELETE /members/<id>/`). Ghost has no SSO tie, so nothing is automatic. | MANUAL, TESTED 2026-11-13 (throwaway ghost:6.72.0) |
| Nextcloud | `docker exec -u abc nextcloud php /app/www/public/occ user:disable <uid>`. If login is OIDC-only, step 1 already blocks new logins. | MANUAL, TESTED 2026-11-08 |
| TeamSpeak | ServerQuery (port 10011, serveradmin): `clientkick`, `banadd uid=<uid> banreason=...`, `servergroupdelclient`, `privilegekeylist` + `tokendelete token=<t>`. Not tied to PHATT ID. | MANUAL, ban/token/group TESTED 2026-11-13 (throwaway teamspeak:3.13); kick of a live client not run |
| SillyTavern | Multi-user mode: Admin panel > Users > disable the account. Not tied to PHATT ID unless fronted by Authentik forward-auth. On disk: record `data/_storage/<sha256("user:<handle>")>` (`enabled` flag) plus folder `data/<handle>/`. Disable = `enabled:false`; delete = remove both. | MANUAL, disk-level disable/delete TESTED 2026-11-13 (admin-UI path not run) |

## 3. Export on request — MANUAL
Produce one folder `export-<date>-<ticketid>/`, hand over via a link that expires. Contents per app:
- Homestead: `DATA_DIR=<dir> node scripts/offboard-user.js --username <u> --export <file>`. Every table that references the user is exported (found from the schema). Password, token and push-key columns are redacted. **AUTO-discovered, MANUAL-run. TESTED.** Uploaded media files are on disk under `DATA_DIR`; the export lists them but does not copy the files. Copy by hand. UNVERIFIED.
- Ghost: Members > export (CSV); API `GET /members/upload/?limit=all&filter=email:'<email>'`. TESTED 2026-11-13.
- Nextcloud: copy the user's files folder; calendars/contacts via export. UNVERIFIED.
- Plex: watch history for the user (Tautulli, if running). UNVERIFIED.
- Authentik: `GET /api/v3/core/users/<pk>/` (profile fields + group names only; 20 fields on 2026.8.5). TESTED 2026-11-13.
- TeamSpeak, SillyTavern: chat logs / character data folder under the user's handle. UNVERIFIED.
- Clubhouse/Arcade: gap, no export hook yet (PHA-4090/4102 are blocked).

## 4. Delete, after export is confirmed — MANUAL
1. Homestead: same command with `--delete` (refuses unless the export file exists and the user isn't the owner). Dry run is the default. **TESTED.**
2. Ghost: delete member/staff (TESTED). 3. Nextcloud: `docker exec -u abc nextcloud php /app/www/public/occ user:delete <uid>` (removes files; this container needs user `abc`, not www-data). TESTED 2026-11-08. 4. Plex: remove user. 5. TeamSpeak: `clientdbdelete cldbid=<id>`, then lift the ban if no longer wanted. 6. SillyTavern: delete user data directory. 7. Clubhouse/Arcade: via delete hooks once PHA-4102 lands. 8. Authentik: delete the user last (so step 1's evidence stays reachable until verified). Deleting also removes the user's tokens/app passwords (TESTED).
Known leftovers: free-text mentions of the person in other people's posts; backups (age out by retention, say so to the member).

## 5. Verification (evidence per app)
For each app record: how checked, result, date. Account gone or disabled means: login attempt fails, lookup returns no user, share/slot absent. Screenshot or command output, no secrets.

| App | Check |
|---|---|
| Authentik | user `is_active=false` / not found; sessions list empty |
| Homestead | `SELECT count(*) FROM users WHERE username=?` = 0; referencing tables 0 for CASCADE (automated test does this) |
| Plex | user absent from Users & Sharing |
| Ghost | member/staff absent or suspended |
| Nextcloud | `occ user:info <uid>` shows disabled / not found |
| TeamSpeak | client banned / absent from DB |
| SillyTavern | account disabled/absent in admin list |
| Clubhouse/Arcade | login/API call with the throwaway's session fails |

## 6. Test record
- Homestead export+delete: `node --require ./scripts/_test-bootstrap.js scripts/test-offboard-user.js` passes (2026-11-08, throwaway DB, real schema).
- Nextcloud `occ user:disable` / `user:delete` on throwaway `zz-offboard-test`: enabled:false, then gone (2026-11-08). Homestead live DB: export+delete, 0 rows left, others untouched (2026-11-08).
- SillyTavern throwaway `zz-offboard-test` (record + folder): created, `enabled:false`, deleted; both gone (2026-11-13).
- Authentik (throwaway `zz-offboard-ak` + `zz-offboard-pg`, image 2026.8.5): user `zz-offboard-test` + app-password token created; `is_active` True -> False; serializer export 20 fields; delete -> 0 users, 0 tokens (2026-11-13). Live session revocation on disable not observed (no browser session).
- Ghost (throwaway `zz-offboard-ghost`, ghost:6.72.0, sqlite): member created, CSV export contains it, `DELETE` 204, filter total 0. Contributor staff `zz-offboard-staff`: active -> inactive via API, delete 204, lookup 404 (2026-11-13).
- TeamSpeak (throwaway `zz-offboard-ts3`, teamspeak:3.13): server group created, privilege key created then `tokendelete` -> 0 left, `banadd uid=` -> in banlist; then cleaned up, banlist empty (2026-11-13).
- All throwaway containers, network and volumes removed after the run; no prod container touched.
- Not run: **Plex** — Brandon 2026-11-14: no test needed, offboarding is a manual unshare of every library the user can access. **Clubhouse/Arcade** (export/delete hooks don't exist yet, PHA-4102/4090; PHA-4953 cut-off not observed).
