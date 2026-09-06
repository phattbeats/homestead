// PHA-3214 (PHA-1647 / PHA-3198): split server.js into Express routers.
//
// Second domain extracted — the two public probes (/api/health and
// /api/version). Chosen as PR2 of the PHA-3214 workstream because the
// surface is trivial (2 handlers, no auth, no params, no body) and
// gives us a smoke-test for the relocation pattern that will be
// re-used for PR3-PR11 (agent-endpoints, auth, walls, mailbox, …).
//
// The health probe is the single most-probed route in production —
// Watchtower polls it on every roll, the Authentik provider hits it
// during the proxy-provider creation, and the operator's first action
// on any incident is `curl /api/health`. Miss-risk here is small but
// non-zero: if `/api/health` ever 404s, the entire Watchtower chain
// goes red and stops auto-rolling. The same miss-risk that bit us on
// PHA-2883 (a stand-in listener that returned 200 while the real
// route was never wired) applies even to a 2-handler module.
//
// Pattern (per the PHA-3198 spec):
//   routes/<domain>.js exports a factory that takes the shared deps
//   (db, secretBox, version, commit) and returns an Express Router with
//   just this domain's endpoints. server.js mounts it via
//     app.use('/api', healthRouter({ db, secretBox, version, commit }));
//   so the URL paths stay byte-identical (`/api/health`, `/api/version`).
//
// What depends on what:
//   - `db`:        better-sqlite3 instance from server.js. Health probe
//                  runs a `SELECT 1` to confirm the connection is alive.
//   - `secretBox`: lib/secret-box.js. Used for CALENDAR_CRED_KEY readiness
//                  and PHA-3200 sessionSecret readiness; these are
//                  reported back in the JSON so operators can spot a
//                  misconfigured box without dumping secrets.
//   - `version`:   the package.json version (string). Reported on both
//                  endpoints so operators can confirm the roll landed.
//   - `commit`:    process.env.COMMIT_SHA at boot. Reported on both
//                  endpoints; null when the env var wasn't set at boot
//                  (local dev).
//
// Behavior must not change: this file is a pure relocation of the two
// handlers that previously lived at server.js L597–L625. The smoke
// scripts that hit /api/health (scripts/test-2588-health-default.js,
// scripts/test-health-checker.js, scripts/smoke-*.js — see CONTRIBUTING.md
// "verification recipe") are the acceptance gates; all must stay green
// with no edits.
//
// PHA-3200 fail-closed check: `sessionSecretReady` is the readiness
// signal the operator watches. If this regresses, a misconfigured
// secret box that booted on a hardcoded fallback would show up as
// `false` here — without it, a half-configured install could pass the
// /api/health probe and only fail later when a user couldn't log in.

'use strict';

const { Router } = require('express');

module.exports = function healthRouter({
  db,
  secretBox,
  version,
  commit,
}) {
  if (!db) throw new Error('healthRouter: db is required');
  if (!secretBox) throw new Error('healthRouter: secretBox is required');
  if (typeof version !== 'string') throw new Error('healthRouter: version is required');

  const PROCESS_STARTED_AT_MS = Date.now();

  const r = Router();

  // ---- public probes (no auth) ----
  r.get('/health', (req, res) => {
    let dbStatus = 'ok';
    try {
      db.prepare('SELECT 1 AS one').get();
    } catch (err) {
      dbStatus = 'error';
    }
    // CALENDAR_CRED_KEY is required for any source with a non-empty
    // cred_blob. Its absence only disables that optional integration:
    // it must not make the core service health probe fail on a README-default
    // install. Keep the readiness signal separately for calendar operators.
    const credKeyReady = secretBox.keyReady();
    const sessionReady = secretBox.sessionSecretReady();
    res.json({
      ok: dbStatus === 'ok',
      service: 'homestead',
      version,
      commit,
      uptime: Math.round((Date.now() - PROCESS_STARTED_AT_MS) / 1000),
      db: dbStatus,
      calendarCredKeyReady: credKeyReady,
      // PHA-3200: separate readiness signal for the session cookie signer.
      // A misconfigured box that booted on a hardcoded fallback would have
      // logged `false` here — operators can spot it from a Watchtower
      // health probe without dumping the secret.
      sessionSecretReady: sessionReady,
    });
  });

  r.get('/version', (req, res) => {
    res.json({ version, commit });
  });

  return r;
};