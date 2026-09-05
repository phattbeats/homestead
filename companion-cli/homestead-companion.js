#!/usr/bin/env node
// Homestead local companion — reference CLI (PHA-2881, PHA-2855 phase 2).
//
// This is the OTHER end of lib/agent-connections.js's pairing flow
// (PHA-2880, phase 1). It runs on the USER's own machine — laptop,
// phone, wherever OpenClaw / Claude Code / Codex actually lives — and
// is the only thing that ever holds:
//   * the user's Homestead session cookie (used once, to redeem a
//     pairing code — Homestead never sees the companion's browser
//     OAuth cookies for OpenClaw/Claude Code/Codex, and this CLI never
//     asks for or stores them either)
//   * the plaintext connection secret handed back at redemption time
//
// Protocol (mirrors lib/agent-connections.js's header contract exactly):
//   1. User opens the "Connect an agent" wizard in the Homestead web UI
//      (PHA-2882), picks a provider tile, and gets a 6-character
//      pairing code (10-minute TTL, single-use).
//   2. Companion logs in as that same user (`login`) and redeems the
//      code (`pair`) — POST /api/agent-connections/redeem-pairing-code
//      while session-authenticated. Homestead checks the code was
//      minted under the SAME user_id as the redeeming session; a
//      different logged-in user cannot claim someone else's code.
//   3. Homestead returns the connection id + a one-time plaintext
//      secret. The companion stores it locally (~/.homestead-companion/
//      connections.json) and never sends it back to Homestead again.
//   4. Every subsequent companion -> Homestead request is signed with
//      that secret using the same HMAC-SHA256 scheme and header trio as
//      lib/agent-endpoints.js's outbound dispatch:
//        X-Homestead-Request-Id   <uuid>
//        X-Homestead-Timestamp    <unix seconds>
//        X-Homestead-Signature    sha256=HMAC_SHA256(secret, ts + "." + rawBody)
//      (`sign`, `relay-one-event`). lib/agent-connections.js's
//      verifySignature() rejects a Number(timestamp) more than 5
//      minutes off the server's clock, so the timestamp MUST be unix
//      seconds — not the ISO-8601 string agent-endpoints.js's outbound
//      dispatchers use for the same-named header in the other
//      direction (homestead -> harness).
//
// Usage:
//   homestead-companion login   --base-url <url> --username <u> --password <p>
//   homestead-companion pair    --base-url <url> --code <XXXXXX>
//   homestead-companion sign    --body <json-string|->
//   homestead-companion relay-one-event --url <url> --body <json-string|->
//   homestead-companion whoami
//
// State lives in $HOMESTEAD_COMPANION_HOME (default ~/.homestead-companion)
// as connection.json: { base_url, connection_id, provider, secret, session_cookie }.
// This is a reference skeleton for the PHA-2855 phase 4 acceptance proof,
// not a packaged/distributed binary — no auto-update, no keychain
// integration, no multi-connection management yet.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function configDir() {
  return process.env.HOMESTEAD_COMPANION_HOME || path.join(os.homedir(), '.homestead-companion');
}

function configPath() {
  return path.join(configDir(), 'connection.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readBodyArg(bodyArg) {
  if (bodyArg === '-' || bodyArg === undefined) {
    return fs.readFileSync(0, 'utf8'); // stdin
  }
  return bodyArg;
}

// HMAC-SHA256(secret, timestamp + "." + rawBody) — identical construction
// to agent-endpoints.js's signPayload() / agent-connections.js's
// verifySignature(). Timestamp MUST be unix seconds (a string of digits),
// since verifySignature() does Number(timestamp) and compares against
// Date.now() / 1000.
function signPayload(secret, timestampSeconds, rawBody) {
  const h = crypto.createHmac('sha256', secret);
  h.update(String(timestampSeconds));
  h.update('.');
  h.update(rawBody == null ? '' : String(rawBody));
  return 'sha256=' + h.digest('hex');
}

function newRequestId() {
  return crypto.randomUUID();
}

function unixSeconds() {
  return String(Math.floor(Date.now() / 1000));
}

// Builds the signed header trio (plus Content-Type) for a companion ->
// Homestead request carrying `rawBody`.
function buildSignedHeaders(secret, rawBody) {
  const timestamp = unixSeconds();
  const requestId = newRequestId();
  return {
    'Content-Type': 'application/json',
    'X-Homestead-Request-Id': requestId,
    'X-Homestead-Timestamp': timestamp,
    'X-Homestead-Signature': signPayload(secret, timestamp, rawBody),
  };
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* non-JSON response */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// `login` — authenticates as the user with a username/password against
// Homestead's session-cookie auth (the SAME auth the browser wizard
// uses). This is the one and only credential exchange the companion
// does directly with Homestead; it is never given, and never stores,
// the user's OpenClaw/Claude Code/Codex OAuth cookies — those stay on
// the companion's own machine, used locally by whatever harness the
// companion wraps.
async function cmdLogin(args) {
  const baseUrl = required(args, 'base-url');
  const username = required(args, 'username');
  const password = required(args, 'password');

  const res = await httpRequest(new URL('/api/login', baseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    fail(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const cookie = (res.headers['set-cookie'] || [])[0];
  if (!cookie) fail('login succeeded but no session cookie was returned');

  const cfg = loadConfig() || {};
  cfg.base_url = baseUrl;
  cfg.session_cookie = cookie.split(';')[0];
  saveConfig(cfg);
  console.log(`Logged in as ${username} against ${baseUrl}. Session cookie stored in ${configPath()}.`);
}

// `pair` — redeems a pairing code minted by the "Connect an agent"
// wizard, while session-authenticated as the SAME user (per `login`
// above). Stores the returned connection id + one-time secret locally;
// this is the only time the secret plaintext ever crosses the wire.
async function cmdPair(args) {
  const cfg = loadConfig();
  if (!cfg || !cfg.session_cookie) {
    fail('not logged in — run `login` first');
  }
  const baseUrl = args['base-url'] || cfg.base_url;
  const code = required(args, 'code');

  const res = await httpRequest(new URL('/api/agent-connections/redeem-pairing-code', baseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cfg.session_cookie },
    body: JSON.stringify({ code }),
  });
  if (res.status !== 200) {
    fail(`pairing failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  if (!res.body || !res.body.secret_plaintext) {
    fail('pairing response did not include a secret — unexpected server response');
  }

  cfg.base_url = baseUrl;
  cfg.connection_id = res.body.id;
  cfg.provider = res.body.provider;
  cfg.scopes = res.body.scopes;
  cfg.secret = res.body.secret_plaintext;
  saveConfig(cfg);
  console.log(`Paired as connection #${res.body.id} (${res.body.provider}). Secret stored in ${configPath()} — never printed again.`);
}

// `sign` — pure utility: given a raw JSON body (arg or stdin), prints
// the header trio a signed companion request would carry. Useful for
// wiring the signing scheme into an existing harness without adopting
// this whole CLI.
async function cmdSign(args) {
  const cfg = loadConfig();
  if (!cfg || !cfg.secret) fail('no paired connection — run `login` and `pair` first');
  const rawBody = readBodyArg(args.body);
  const headers = buildSignedHeaders(cfg.secret, rawBody);
  console.log(JSON.stringify(headers, null, 2));
}

// `relay-one-event` — signs and POSTs a single JSON event body to
// `--url` (defaults to `<base_url>/api/agent-connections/<id>/events`,
// the inbound route future phases wire up). This is the end-to-end
// proof PHA-2855 phase 4's acceptance test drives: mint code -> pair ->
// relay-one-event -> Homestead verifies the signature with
// lib/agent-connections.js's verifySignature() against the stored
// secret.
async function cmdRelayOneEvent(args) {
  const cfg = loadConfig();
  if (!cfg || !cfg.secret) fail('no paired connection — run `login` and `pair` first');
  const targetUrl = args.url || new URL(`/api/agent-connections/${cfg.connection_id}/events`, cfg.base_url).toString();
  const rawBody = readBodyArg(args.body);
  const headers = buildSignedHeaders(cfg.secret, rawBody);

  const res = await httpRequest(targetUrl, { method: 'POST', headers, body: rawBody });
  console.log(JSON.stringify({ status: res.status, body: res.body ?? res.raw }, null, 2));
  if (res.status >= 400) process.exitCode = 1;
}

async function cmdWhoami() {
  const cfg = loadConfig();
  if (!cfg) fail('no companion state found — run `login` and `pair` first');
  const { secret, session_cookie, ...safe } = cfg;
  console.log(JSON.stringify({
    ...safe,
    session_cookie: session_cookie ? '(present)' : null,
    secret: secret ? secret.slice(0, 16) + '…' : null,
  }, null, 2));
}

function required(args, key) {
  if (args[key] === undefined || args[key] === true) {
    fail(`missing required --${key}`);
  }
  return args[key];
}

function fail(msg) {
  console.error(`homestead-companion: ${msg}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'login': return cmdLogin(args);
    case 'pair': return cmdPair(args);
    case 'sign': return cmdSign(args);
    case 'relay-one-event': return cmdRelayOneEvent(args);
    case 'whoami': return cmdWhoami(args);
    default:
      console.error(`Usage: homestead-companion <login|pair|sign|relay-one-event|whoami> [--flags]`);
      process.exit(command ? 1 : 0);
  }
}

if (require.main === module) {
  main().catch(err => fail(err.stack || String(err)));
}

module.exports = { signPayload, buildSignedHeaders, unixSeconds, newRequestId, configPath, loadConfig, saveConfig };
