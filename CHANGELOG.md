# Changelog

## Unreleased — agent HMAC secrets envelope-encrypted at rest

`agent_endpoints.secret` (drawer + events-webhook HMAC) and `agent_connections.secret` (companion signing key) were plaintext in `life.db`. Both files documented the trade-off honestly — verification is symmetric HMAC, so the server must recompute the digest and therefore must *have* the key — but that made a copied `life.db` the keyring: copy `life.db` out of a backup tarball and you can sign new drawer POSTs and events-webhook deliveries as that user. An earlier fix closed the replay window for *captured* traffic; this closes "you don't need a captured POST at all."

**What changed:** both columns are now AES-256-GCM envelopes (`<iv>:<tag>:<ciphertext>`), reusing `lib/secret-box.js` — no second crypto module. Key is `HMAC_CRED_KEY`, falling back to `CALENDAR_CRED_KEY` so single-key installs keep working without a template edit. Writes encrypt (`create`, `rotate_secret`, `redeemPairingCode`, `rotateSecret`); only the sign/verify path decrypts (`listEnabledForDispatch` / `listActiveForDispatch` hand the dispatcher a usable key, exactly the contract they had with plaintext). `toPublic` still reveals plaintext **once** to the owner and still renders the `homestead_aes_…` prefix chip — never ciphertext wearing the copy-once plaintext's clothes.

**Boot migration:** `encryptSecretColumn` seals any legacy plaintext row in place, in one transaction, idempotent, at the end of each table's existing `migrate()`. Verified: row counts unchanged, every row decrypts back to its original plaintext, a second pass migrates 0. With no key configured the pass **skips** rather than throws (a keyless box still boots; the write paths already fail closed) and leaves rows intact — losing data because someone unset an env var is not a failure mode we ship.

**Dual-read window:** `openSecret` accepts plaintext or envelope for one release so a rolled-back image can still verify signatures this release wrote. `secret-box.LEGACY_PLAINTEXT_READ` is the flag to flip when that window closes.

**Fail-closed:** no key → `create()` / `redeemPairingCode()` / dispatch lookups throw rather than writing a plaintext key, `POST /api/agent-connections/:id/events` answers `503 hmac_key_unavailable` instead of a bare 500, and `/api/health` gains `hmacSecretsEncrypted`. A *malformed* `HMAC_CRED_KEY` never falls through to a working `CALENDAR_CRED_KEY` — that would keep signing under the old key after a typo.

**Tests:** `scripts/test-hmac-secret-box.js` (61 assertions) covers envelope shape + tamper detection, key resolution and the malformed-key case, encrypt-at-rest on every write path, a `verifySignature` round-trip *after* encryption, the stolen-DB property (the dumped column is not a usable HMAC key, and a signature forged with it does not verify), the migration, the dual-read, and the no-key posture. Existing at-rest assertions in `test-agent-endpoints.js` / `test-agent-connections.js` / `test-drawer-backend.js` / `test-events-dispatcher.js` were updated to assert "envelope that decrypts to the plaintext" instead of "column equals the plaintext."

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
