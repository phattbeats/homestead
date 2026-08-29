# Owner Recovery — Operational Runbook

_PHA-2708: preventing another owner lockout._

This document describes the break-glass pathway for the household
owner. Read it before you need it. It does **not** contain any
hashes, tokens, or passwords — operational state only.

---

## What "owner" means here

Homestead has exactly one household owner per install: the row with
`is_admin = 1`. On a fresh install that is the user named `admin`,
seeded with `ADMIN_PASSWORD` (or `BRANDON_PASSWORD` if Brandon's
account is your working admin). The reconciliation that sets
`is_admin = 1` runs on every boot:

```
[user-model.js] update users set is_admin = 1 where username in (members of 'admins' Authentik group)
```

If you replace the owner (future PHA), the new row is whatever has
`is_admin = 1` at the time of the recovery. The recovery primitives
resolve `findOwnerUserId` lazily — they don't hard-code a username
and don't migrate state across owner changes.

---

## The three things that can break owner access

1. **Authentik / OIDC outage.** SWAG cannot reach Authentik; the
   `x-authentik-username` header is absent on every request.
2. **Owner lost the LAN password.** No header-trust probe can help
   if the owner doesn't have one; only the local `password_hash`
   can confirm them when Authentik is up.
3. **Every identity_link row for the owner was unlinked** AND the
   `local_credentials.password_hash` was rotated or deleted.

PHA-2708 closes all three loops with the same primitive: a
host-side CLI (`scripts/reset-owner-password.js`) that mints a
short-lived, one-shot, sha256-hashed reset token directly against
the SQLite DB and an HTTP endpoint that consumes it. The CLI does
**not** require Homestead to be reachable, which means it works
for case (1) where SWAG is down.

---

## When to use this runbook

You should use this when the owner is locked out AND the
`scripts/reset-owner-password.js` is your safest available
recovery path. Reach for it when:

- The owner is the only `is_admin = 1` user AND they cannot sign
  in via `/api/login` (forgotten or rotated password) AND
  Authentik is unreachable.
- You can `ssh` to the Unraid host that holds the Homestead
  container. That host has the SQLite DB at `$DATA_DIR/life.db`.

---

## Procedure — mint a reset token

On the host that owns the Homestead data dir:

```bash
DATA_DIR=/var/lib/homestead /usr/local/bin/node \
  /opt/homestead/scripts/reset-owner-password.js
```

(This is the path on the Unraid container; replace `DATA_DIR` and
the script path as your install requires.)

The CLI prints a single JSON document to stdout. The fields you
care about:

| Field | Meaning |
|---|---|
| `token` | **Plaintext reset token.** 32 random bytes hex. Save it now — it does not persist anywhere besides the JSON line you're reading. |
| `expires_at` | Milliseconds since epoch when the token expires (default 60 minutes). |
| `curl_example` | A ready-to-paste curl line for the consume step. |
| `warning` | Reminder that the plaintext is one-shot. |

The CLI writes a single row to `analytics_events` with
`kind = 'owner_recovery_minted'`, `actor` = the OS user running
the CLI, and `meta.source = 'reset-owner-password.js'`. You can
grep the analytics feed for that kind to find this event later.

### Override the TTL

For low-trust environments you may want a shorter window:

```bash
DATA_DIR=/var/lib/homestead /usr/local/bin/node \
  /opt/homestead/scripts/reset-owner-password.js --ttl-min 10
```

### Revoke a leaked or stale token

If you minted a token and never used it (or it leaked), clear it
before expiry:

```bash
DATA_DIR=/var/lib/homestead /usr/local/bin/node \
  /opt/homestead/scripts/reset-owner-password.js --revoke
```

This writes `kind = 'owner_recovery_revoked'` to the audit
log. A fresh mint after `--revoke` succeeds immediately.

### Refusal: alreadyActive

The CLI refuses to mint a second token while one is still active
(unexpired). Either wait until expiry or `--revoke` the active
token first. We enforce one-active-token-at-a-time to keep the
threat model simple: a leaked token never races a fresh one
because there is at most one of each.

---

## Procedure — consume the token

From any machine that can reach Homestead — no login required, run
the `curl_example` line printed by the CLI:

```bash
curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"token":"<paste plaintext>","new_password":"REPLACE_ME_8_CHARS_MIN"}' \
  http://homestead.lan:3001/api/admin/owner/recover
```

The endpoint is **deliberately unauthenticated** — no session
cookie, no `x-authentik-username` header, nothing. This is the
whole point: the scenario this runbook exists for is "Authentik is
unreachable AND the owner forgot their password," which means there
is no session or header to present. The one-shot, 256-bit,
TTL-bound token IS the credential, the same way a password is the
credential for `/api/login`. The endpoint rotates the owner's
`local_credentials.password_hash` via the canonical
`setLocalPassword` (bcrypt + user-table sync), clears the recovery
token columns, and writes `kind = 'owner_recovery_consumed'` to the
audit log.

A successful response looks like:

```json
{ "ok": true, "username": "admin" }
```

A failed response (bad token, wrong format, replay) returns 401
with `{ "error": "invalid_or_expired_token" }`. Replay is
impossible — the hash is wiped on a successful consume.

### What the new password should be

- At least 8 characters (server.js validates this for the recovery
  path; the regular `/api/users/:username/password` accepts 4+ to
  preserve backwards compatibility with legacy seed passwords).
- Anything else the household uses (entropy, a password manager,
  etc.). It does **not** need to differ from any prior password —
  bcrypt salts render collisions irrelevant.

---

## Failure modes the CLI protects you from

The CLI is intentionally boring: a few hundred lines of bash-style
Node that takes ONE user-facing argument and emits ONE JSON
document. It does not depend on:

- Authentik / OIDC (it doesn't make any HTTP calls at all).
- The Homestead server process being up.
- The owner's session.
- Anything else in the Homestead stack. It opens the SQLite file
  directly via `better-sqlite3` and writes the row.

The CLI is the only sanctioned way to mint a recovery token. The
HTTP `/api/admin/owner/recover` endpoint deliberately does not
expose a mint — that would let an attacker with any admin session
mint against themselves.

---

## What the `audit` events look like

Every step writes one row to `analytics_events` with
`subject_type = 'owner_recovery'`. The kinds:

| Kind | When |
|---|---|
| `owner_recovery_minted` | Operator ran the CLI; new token issued. |
| `owner_recovery_consumed` | Token used; password rotated. |
| `owner_recovery_revoked` | Operator ran `--revoke`; active token cleared. |
| `owner_recovery_rejected` | Endpoint saw a bad / expired / replayed token. |
| `owner_password_reset_by_admin` | Admin used `/api/users/:username/password` to rotate the owner's password without going through the recovery path. |
| `password_reset_by_admin` | Admin used the same path to rotate a non-owner's password. |

`meta` for these rows contains `route`, `source`, `ttl_min`,
`actor`, etc. **It never contains plaintext tokens, password
hashes, or new passwords.** The lib-level contract that asserts
this lives in `scripts/test-2708-owner-recovery.js`.

### Filtering the feed

```sql
SELECT ts, kind, subject_id, meta
  FROM analytics_events
 WHERE subject_type = 'owner_recovery'
 ORDER BY ts DESC
 LIMIT 50;
```

---

## Hard rules baked into the lib

| Behavior | Test that guards it |
|---|---|
| `unlinkIdentity` of the OWNER's last identity_link blocks with `would_lock_out_owner` (HTTP 409). | `Group 1 — owner protection` |
| `unlinkIdentity` of any non-owner user's last path still blocks with `no_login_path` (PHP-2704 contract preserved). | same |
| `mint` stores `recovery_token_hash = sha256(token)`; the plaintext never touches the DB. | `Group 2` |
| A second mint within the TTL of an active token returns `alreadyActive: true` and refuses to write. | `Group 2` |
| `consume` clears the hash on success — replay is impossible. | `Group 2` |
| `consume` clears the hash on a presented-but-expired token so stale rows do not pile up. | `Group 2` |
| `consume` uses `crypto.timingSafeEqual` on the hash comparison. | `Group 2` |
| `consume` with wrong/empty/non-string token returns `invalid_or_expired_token` (no probe leak). | `Group 2` |
| `/api/login` works with **no** `x-authentik-username` header — outage-resilience. | `Group 3` |
| `/api/me` returns `{ user: null }` (200) with no headers — soft-unauthenticated, not 401. | `Group 3` |
| `GET /api/admin/owner/login-paths` requires admin; carries no secret columns. | `Group 4` |
| `POST /api/admin/owner/recover` requires NO prior session or headers — the token is the only credential — and rejects new_password < 8 chars. | `Group 4` |
| Audit `meta` has no plaintext tokens or passwords. | `Group 2 + 4` |

If any of these fail, reject the change. The owner lockout
prevention isn't a feature add — it's the entire reason this PHA
exists.

---

## What this runbook deliberately does NOT do

- It does NOT back up or rotate the SQLite DB before minting. The
  CLI writes a single row and reports success/failure. Make your
  own backup with `cp $DATA_DIR/life.db $DATA_DIR/life.db.bak.$(date +%s)`
  if you're worried about a corruption event. Don't break glass
  on a database you cannot afford to lose.
- It does NOT touch `identity_links` rows. Those belong to
  PHA-2706 / PHA-2703. Rotating the owner's password has nothing
  to do with linking them to a new Authentik subject.
- It does NOT log the plaintext token to disk anywhere
  (analytics_events meta, ops logs, anywhere). The only place the
  plaintext exists is the JSON document printed on stdout by the
  CLI — and that lives only in your shell scrollback.

---

## See also

- `lib/identity.js` — the canonical primitives. The comment block
  at the top of the PHA-2708 section explains the threat model.
- `scripts/test-2708-owner-recovery.js` — the contract. If the
  runbook and the test disagree, the test wins.
- `scripts/smoke-2708-owner-recovery.js` — the end-to-end
  evidence generator. Run it on any Homestead install to capture
  verify-out/ artifacts for a deploy review.
- PHA-2708 (this issue) — original requirements.
- PHA-2704 — the identity foundation this PHA builds on. Read
  that first if you need to understand the schema.
- `docs/DEFINITION-OF-DONE.md` — evidence requirements for a
  closed issue.
