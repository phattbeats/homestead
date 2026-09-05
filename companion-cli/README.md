# Homestead local companion (reference CLI)

PHA-2881 (PHA-2855 phase 2). This is a minimal, dependency-free Node
reference implementation of the companion side of Homestead's
agent-pairing protocol (`lib/agent-connections.js`, PHA-2880). It exists
to (a) document the wire protocol precisely enough that a real
OpenClaw/Claude Code/Codex companion can implement it, and (b) give the
PHA-2855 phase 4 acceptance proof something runnable end to end.

It is **not** a packaged or distributed binary — no auto-update, no
keychain integration, single connection at a time.

## Security boundary

Homestead never receives or stores your OpenClaw/Claude Code/Codex
browser OAuth cookies. Those live only on your machine, wherever your
companion/harness already keeps them. The companion's only two
Homestead-facing secrets are:

1. A short-lived Homestead **session cookie**, obtained once via
   `login`, used only to redeem a pairing code.
2. The **connection secret** minted at pairing time, used to sign every
   subsequent request.

Both are stored locally in `~/.homestead-companion/connection.json`
(mode `0600`), never re-uploaded.

## Protocol

1. In the Homestead web UI, open **Settings → Connect an agent**, pick a
   provider tile, and get a 6-character pairing code (10-minute TTL,
   single-use, bound to your logged-in user).
2. On your own machine:
   ```
   homestead-companion login --base-url https://homestead.example.lan --username brandon --password ...
   homestead-companion pair  --code ABCD23
   ```
3. Every subsequent companion → Homestead request is signed:
   ```
   X-Homestead-Request-Id:  <uuid>
   X-Homestead-Timestamp:   <unix seconds>
   X-Homestead-Signature:   sha256=HMAC_SHA256(secret, timestamp + "." + rawBody)
   ```
   Timestamps beyond 5 minutes of clock skew are rejected
   (`lib/agent-connections.js`'s `verifySignature`). Note this is **unix
   seconds**, not the ISO-8601 string `lib/agent-endpoints.js`'s
   outbound (Homestead → harness) dispatchers use for the
   same-named header in the other direction.

## Commands

| Command | Purpose |
|---|---|
| `login --base-url <url> --username <u> --password <p>` | Session-authenticate as the pairing user. |
| `pair --code <XXXXXX> [--base-url <url>]` | Redeem a pairing code; stores the one-time secret. |
| `sign --body <json\|->` | Print the signed header trio for an arbitrary body (stdin with `-`). |
| `relay-one-event --url <url> --body <json\|->` | Sign and POST one event to `<url>` (defaults to `<base_url>/api/agent-connections/<id>/events`). |
| `whoami` | Print current companion state (secrets redacted). |

State lives at `$HOMESTEAD_COMPANION_HOME/connection.json`
(default `~/.homestead-companion/connection.json`).
