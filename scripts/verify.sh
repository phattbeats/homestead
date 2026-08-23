#!/usr/bin/env bash
# PHA-2501 standing policy enforcement — one-shot verify command.
#
# Per Brandon's 2026-08-23 directive (Definition of Done), every Homestead
# change must come with artifact-grade evidence (screenshot, curl transcript,
# commit SHA + passing smoke). This script makes "attach real verification"
# cost an agent ONE command, not an afternoon.
#
# What it does:
#   1. Boots a scratch Homestead instance on port 3105 with an ephemeral
#      DATA_DIR (fresh DB) and the standard seeded users (admin / brandon).
#   2. Runs the SPA page-error guard (catches duplicate top-level
#      declarations like the PHA-2494 bug — see scripts/smoke-spa-pageerrors.js).
#   3. Runs the post-login mobile-viewport screenshot smoke (catches login
#      render breakage — see scripts/smoke-postlogin-screenshot.js).
#   4. Drops screenshots into ./verify-out/.
#   5. Prints SHA-of-current-branch + a curl transcript of /api/health.
#
# Use cases:
#   - Locally before opening a PR: ./scripts/verify.sh
#   - In CI: same script, after `npm ci`.
#
# Optional env:
#   VERIFY_KEEP_DATA=1   leave DATA_DIR on disk for postmortem
#   VERIFY_PORT=3106     override the ephemeral port

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PORT="${VERIFY_PORT:-3105}"
VERIFY_OUT="${VERIFY_OUT:-$REPO_DIR/verify-out}"
TMP_DATA="$(mktemp -d -t homestead-verify-XXXXXX)"
KEEP_DATA="${VERIFY_KEEP_DATA:-0}"

# Playwright Chromium is provisioned by `npx playwright install chromium`
# or by the CI workflow. Honor an explicit override for constrained envs.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-0}"

echo "==> PHA-2501 verify.sh — Homestead Definition of Done guard"
echo "    repo: $REPO_DIR"
echo "    port: $PORT"
echo "    data: $TMP_DATA"
echo "    out:  $VERIFY_OUT"
echo

cleanup() {
  local rc=$?
  if [[ "$KEEP_DATA" != "1" ]]; then
    rm -rf "$TMP_DATA"
  else
    echo "    (VERIFY_KEEP_DATA=1 — left $TMP_DATA on disk for postmortem)"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# 1. Fresh install (ensure dev deps including playwright are present).
if [[ ! -d node_modules/playwright ]]; then
  echo "==> Installing dev dependencies (NODE_ENV=development npm ci)"
  NODE_ENV=development npm ci --no-audit --no-fund
fi

# 2. Run the SPA page-error guard.
echo "==> Step 1/3 — SPA page-error guard"
if ! node scripts/smoke-spa-pageerrors.js; then
  echo "✗ SPA page-error guard FAILED — see output above" >&2
  exit 1
fi
echo

# 3. Run the post-login screenshot smoke (Definition of Done artifact).
echo "==> Step 2/3 — Post-login 390px mobile screenshot smoke"
VERIFY_OUT="$VERIFY_OUT" \
DATA_DIR="$TMP_DATA" \
PORT="$PORT" \
ADMIN_PASSWORD="verify-admin-pw" \
BRANDON_PASSWORD="verify-brandon-pw" \
SESSION_SECRET="verify-secret" \
NODE_ENV=production \
  node scripts/smoke-postlogin-screenshot.js
echo

# 4. Curl transcript of /api/health (proof of life on the same scratch instance).
echo "==> Step 3/3 — /api/health curl transcript"
DATA_DIR="$TMP_DATA" PORT="$PORT" ADMIN_PASSWORD="verify-admin-pw" \
SESSION_SECRET="verify-secret" NODE_ENV=production \
  node -e "const app = require('./server.js'); app.listen($PORT, '127.0.0.1');" &
SERVER_PID=$!
# Wait for boot. The first boot seeds the DB which adds a few hundred ms.
HEALTH_BODY=""
for _ in $(seq 1 60); do
  if HEALTH_BODY="$(curl -sf "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"; then
    if [[ -n "$HEALTH_BODY" ]]; then break; fi
  fi
  sleep 0.25
done
if [[ -z "$HEALTH_BODY" ]]; then
  echo "    (could not reach /api/health on :$PORT — server still booting?)" >&2
else
  echo "    GET /api/health:"
  echo "$HEALTH_BODY" | python3 -m json.tool | sed 's/^/    /'
fi
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
echo

echo "==> Branch / SHA"
echo "    branch: $(git rev-parse --abbrev-ref HEAD)"
echo "    sha:    $(git rev-parse HEAD)"
echo "    short:  $(git rev-parse --short HEAD)"
echo

echo "==> Done. Artifacts:"
ls -la "$VERIFY_OUT" 2>/dev/null | sed 's/^/    /'
echo
echo "Attach these (or their paths) to the closing comment of any UI/API issue."
echo "Per PHA-2501 standing policy: no evidence, no done."