#!/usr/bin/env node
// test-process environment shim.
//
// Loaded via `node --require ./scripts/_test-bootstrap.js` from every
// `node scripts/test-*.js` invocation in `npm test`. Centralizes the
// three env vars Homestead now requires to boot on a workstation:
//
//   - SESSION_SECRET: a 64-char random hex string. The server is now
//     fail-closed on a missing/placeholder/short secret. Most
//     older tests relied on the silent fallback
//     (`process.env.SESSION_SECRET || 'life-app-secret-change-me'`)
//     and never set it; this shim keeps those tests running without
//     touching every file. Tests that explicitly want to exercise the
//     fail-closed path (e.g. scripts/test-session-secret-boot.js)
//     overwrite process.env.SESSION_SECRET themselves after this shim
//     runs.
//
//   - HMAC_CRED_KEY: a 64-char random hex string. Envelope-
//     encrypts the agent HMAC secrets (`agent_endpoints.secret`,
//     `agent_connections.secret`) with AES-256-GCM. Without a key the
//     create / redeem / rotate paths throw, so any test that pairs a
//     harness or signs a dispatch needs one. secret-box falls back to
//     CALENDAR_CRED_KEY; we set the HMAC-specific var explicitly so the
//     name the operator is told about is the one under test. Tests that
//     want the fail-closed path delete it themselves after this shim
//     runs, exactly as test-3200-session-secret.js does for
//     SESSION_SECRET.
//
//   - HOMESTEAD_INSECURE_TEST_COOKIES=1: flips the production
//     `secure: true` cookie flag off so tests can complete the
//     round-trip `POST /api/login` → `GET /api/...` over plain
//     http://127.0.0.1. Production never sees this var.
//
//   - NODE_ENV: defaults to 'test' when unset. Some tests override to
//     'production' themselves; we don't clobber.
//
// Why one shim instead of editing every test: 29 test files
// `require('../server.js')` and most of them set neither var. Touching
// each is high-risk and pointless — the right answer is "tests run
// with a valid env by default".

'use strict';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  // Deterministic per-process secret, 64 hex chars (32 random bytes).
  // Generated once per Node process so cookies survive within a test
  // run; tests that need a *specific* secret can overwrite this after
  // require. The 64-char hex format matches the operator-facing
  // `openssl rand -hex 32` so the production code path is exercised.
  process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
}

if (!process.env.HMAC_CRED_KEY && !process.env.CALENDAR_CRED_KEY) {
  process.env.HMAC_CRED_KEY = require('crypto').randomBytes(32).toString('hex');
}

if (!process.env.HOMESTEAD_INSECURE_TEST_COOKIES) {
  process.env.HOMESTEAD_INSECURE_TEST_COOKIES = '1';
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}
