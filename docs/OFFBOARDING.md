# Removing someone from PHATT ID: runbook

Status: **draft. Homestead leg tested (automated, throwaway DB). Every other leg is untested against the live app** and marked so below. Issue: PHA-5023. Related: PHA-4953 (Clubhouse cut-off), PHA-4102 (delete hooks), PHA-4090 (export/delete round trip), `docs/architecture/PASSWORD-RECOVERY.md`.

Rules: a real member is never touched while testing. Use a `zz-offboard-<date>` account. No secrets in tickets or logs.

Legend: **AUTO** = happens with no human action once the PHATT ID changes. **MANUAL** = an operator does it. **UNVERIFIED** = written from how the app works, not yet run.

## 0. Decide: disable or delete
- **Disable** (reversible): steps 1-2 plus the per-app access cuts. Data stays.
- **Delete** (permanent): export first (section 3), get Brandon's OK on the manifest, then section 4. Never delete without a written export.
- Never run this on the owner/`admins` group member.

## 1. Turn off the PHATT ID (Authentik, auth.phatt.vip) — MANUAL
1. Admin > Directory > Users > the user > set **inactive** (API: `PATCH /api/v3/core/users/<pk>/` `{"is_active": false}`).
2. Admin > Directory > Users > user > **Sessions**: delete all sessions. Revoke their tokens/app passwords.
3. Record the user pk and time in the ticket (no other identifiers).

Effect of step 1: no new SSO logins anywhere. Existing app sessions live on until each app's own session ends, so the per-app steps below still matter.

## 2. Per-app access cut (disable)

| App | What happens | Auto/Manual |
|---|---|---|
| Clubhouse + Arcade | Access cut within seconds of the PHATT ID going inactive (PHA-4953). Verify, don't assume. | AUTO |
| Homestead | OIDC login fails. Existing cookie session persists until expiry; admin can't revoke it from the UI. Delete the user (section 4) to kill it. Local password, if any: set via `scripts/reset-owner-password.js` is NOT a disable. | AUTO (login) / MANUAL (live session) |
| Plex | Remove share: Plex bridge, or Settings > Users & Sharing > remove friend. Also kill active streams. | MANUAL (bridge-assisted) UNVERIFIED |
| Ghost | Staff users: Settings > Staff > Suspend. Members: Members > the member > delete or unsubscribe. Ghost has no SSO tie, so nothing is automatic. | MANUAL UNVERIFIED |
| Nextcloud | `occ user:disable <uid>` (or OCS `PUT /ocs/v1.php/cloud/users/<uid>/disable`). Disabling logs out sessions and app passwords. If login is OIDC-only, step 1 already blocks new logins. | MANUAL UNVERIFIED |
| TeamSpeak | Kick + ban the client's identity/UID, remove server group, delete the privilege key if one was issued. Not tied to PHATT ID. | MANUAL UNVERIFIED |
| SillyTavern | Multi-user mode: Admin panel > Users > disable the account. Not tied to PHATT ID unless fronted by Authentik forward-auth. | MANUAL UNVERIFIED |

## 3. Export on request — MANUAL
Produce one folder `export-<date>-<ticketid>/`, hand over via a link that expires. Contents per app:
- Homestead: `DATA_DIR=<dir> node scripts/offboard-user.js --username <u> --export <file>`. Every table that references the user is exported (found from the schema). Password, token and push-key columns are redacted. **AUTO-discovered, MANUAL-run. TESTED.** Uploaded media files are on disk under `DATA_DIR`; the export lists them but does not copy the files. Copy by hand. UNVERIFIED.
- Ghost: Members > export (CSV), or Admin API. UNVERIFIED.
- Nextcloud: copy the user's files folder; calendars/contacts via export. UNVERIFIED.
- Plex: watch history for the user (Tautulli, if running). UNVERIFIED.
- Authentik: `GET /api/v3/core/users/<pk>/` (profile fields + group names only).
- TeamSpeak, SillyTavern: chat logs / character data folder under the user's handle. UNVERIFIED.
- Clubhouse/Arcade: gap, no export hook yet (PHA-4090/4102 are blocked).

## 4. Delete, after export is confirmed — MANUAL
1. Homestead: same command with `--delete` (refuses unless the export file exists and the user isn't the owner). Dry run is the default. **TESTED.**
2. Ghost: delete member/staff. 3. Nextcloud: `occ user:delete <uid>` (removes files). 4. Plex: remove user. 5. TeamSpeak: remove identity DB entries. 6. SillyTavern: delete user data directory. 7. Clubhouse/Arcade: via delete hooks once PHA-4102 lands. 8. Authentik: delete the user last (so step 1's evidence stays reachable until verified).
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
- Live end-to-end on a throwaway PHATT ID: **not run.** Needs a throwaway account created in each app and admin access to each. See the issue for what's missing.
