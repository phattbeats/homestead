#!/usr/bin/env node
// (phase 2) acceptance test for companion-cli/homestead-companion.js.
//
// Drives the CLI as a real subprocess against a live server.js instance,
// end to end: mint a pairing code (as the browser session would),
// `login` + `pair` (as the companion would), `sign`, then
// `relay-one-event` against a throwaway HTTP listener standing in for
// a future Homestead inbound route — verifying the signature with
// lib/agent-connections.js's verifySignature() exactly as a real
// receiver would.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const agentConnections = require('../lib/agent-connections');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const CLI = path.join(__dirname, '..', 'companion-cli', 'homestead-companion.js');

// Per-invocation watchdog: a stuck CLI fails this one step with its
// output instead of stalling the whole run until run-tests.js kills it.
const CLI_TIMEOUT_MS = 15000;

function runCli(args, env) {
  // HANG ROOT CAUSE (PHA-3317) — start any future hang investigation here.
  // The Homestead server under test runs *inside this process* (server.js
  // is required above and listens on 127.0.0.1). The old runCli used
  // execFileSync, which blocks this process's event loop until the child
  // exits. The child (`login`) makes an HTTP request to that in-process
  // server, which can never accept or answer while the loop is blocked:
  // the child waits on the server, and the server waits on the child.
  // That is a deadlock, not a Node, sandbox or socket-reaping bug.
  //
  // Rule: never wait synchronously (execFileSync/spawnSync) on a
  // subprocess that talks to a server living in this process. Use async
  // spawn, as here, so the event loop keeps serving requests while the
  // child runs.
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: CLI_TIMEOUT_MS },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      resolve({ status: 1, out: `${stdout}${stderr}${err.message}` });
    });
    child.on('close', (code, signal) => {
      const status = signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : (code == null ? 1 : code);
      resolve({ status, out: stdout + stderr });
    });
  });
}

function request(base, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...base, ...opts }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* */ }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

console.log('companion CLI acceptance test\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-companion-http-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = { hostname: '127.0.0.1', port };
  const baseUrl = `http://127.0.0.1:${port}`;

  const password = process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD;

  // Browser session mints a pairing code for the claude_code tile.
  const loginRes = await request(base, {
    path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, { username: 'brandon', password });
  assertEq(loginRes.status, 200, 'seed login as brandon succeeds', JSON.stringify(loginRes.body));
  const browserCookie = (loginRes.headers['set-cookie'] || [])[0];

  const mintRes = await request(base, {
    path: '/api/agent-connections/pair', method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: browserCookie },
  }, { provider: 'claude_code', label: 'Companion CLI test', scopes: ['agent:invoke'] });
  assertEq(mintRes.status, 200, 'browser session mints a pairing code');
  const pairingCode = mintRes.body.pairing_code;
  assert(!!pairingCode, 'pairing code present');

  // Companion CLI: separate state dir per test run.
  const companionHome = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-companion-home-'));
  const env = { HOMESTEAD_COMPANION_HOME: companionHome };

  const loginCli = await runCli(['login', '--base-url', baseUrl, '--username', 'brandon', '--password', password], env);
  assertEq(loginCli.status, 0, '`login` succeeds', loginCli.out);

  const cfgAfterLogin = JSON.parse(fs.readFileSync(path.join(companionHome, 'connection.json'), 'utf8'));
  assert(!!cfgAfterLogin.session_cookie, 'login stores a session cookie locally');
  assert(!cfgAfterLogin.secret, 'login does not yet have a secret (not paired)');

  const pairCli = await runCli(['pair', '--code', pairingCode], env);
  assertEq(pairCli.status, 0, '`pair` succeeds', pairCli.out);

  const cfgAfterPair = JSON.parse(fs.readFileSync(path.join(companionHome, 'connection.json'), 'utf8'));
  assert(!!cfgAfterPair.secret, 'pair stores the one-time secret locally');
  assert(!!cfgAfterPair.connection_id, 'pair stores the connection id');
  assertEq(cfgAfterPair.provider, 'claude_code', 'pair stores the provider');

  // Re-pairing with the same (now consumed) code fails cleanly.
  const rePairCli = await runCli(['pair', '--code', pairingCode], env);
  assert(rePairCli.status !== 0, 're-pairing with a consumed code fails');

  // `sign` produces a header trio that a receiver can verify against
  // the stored secret using lib/agent-connections.js's verifySignature
  // — the exact function a future inbound route would call.
  const eventBody = JSON.stringify({ type: 'test_event', payload: { hello: 'world' } });
  const signCli = await runCli(['sign', '--body', eventBody], env);
  assertEq(signCli.status, 0, '`sign` succeeds', signCli.out);
  const headers = JSON.parse(signCli.out);
  assert(!!headers['X-Homestead-Signature'], 'sign output carries X-Homestead-Signature');
  assert(!!headers['X-Homestead-Timestamp'], 'sign output carries X-Homestead-Timestamp');
  assert(!!headers['X-Homestead-Request-Id'], 'sign output carries X-Homestead-Request-Id');

  const verified = agentConnections.verifySignature(
    cfgAfterPair.secret,
    headers['X-Homestead-Timestamp'],
    eventBody,
    headers['X-Homestead-Signature'],
  );
  assert(verified === true, 'verifySignature() accepts the CLI-signed request against the stored secret');

  const tamperedVerify = agentConnections.verifySignature(
    cfgAfterPair.secret,
    headers['X-Homestead-Timestamp'],
    eventBody + 'tampered',
    headers['X-Homestead-Signature'],
  );
  assert(tamperedVerify === false, 'verifySignature() rejects a tampered body');

  // `relay-one-event` against a throwaway listener standing in for a
  // future Homestead inbound route: the listener itself verifies the
  // signature exactly as a real route would.
  let received = null;
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const okSig = agentConnections.verifySignature(
        cfgAfterPair.secret,
        req.headers['x-homestead-timestamp'],
        body,
        req.headers['x-homestead-signature'],
      );
      received = { body, okSig, headers: req.headers };
      res.writeHead(okSig ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: okSig }));
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = receiver.address().port;

  const relayCli = await runCli(['relay-one-event', '--url', `http://127.0.0.1:${receiverPort}/inbound`, '--body', eventBody], env);
  assertEq(relayCli.status, 0, '`relay-one-event` succeeds', relayCli.out);
  assert(!!received, 'receiver got the relayed event');
  assert(received && received.okSig === true, 'receiver verified the relayed event signature');
  assertEq(received && received.body, eventBody, 'receiver got the exact raw body (byte-for-byte HMAC input)');

  // PHA-3317: a server that accepts the connection but never answers must
  // make the CLI fail fast, not hang.
  const blackHole = http.createServer(() => { /* never respond */ });
  await new Promise(resolve => blackHole.listen(0, '127.0.0.1', resolve));
  const bhHome = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-companion-bh-'));
  const t0 = Date.now();
  const bhCli = await runCli(
    ['login', '--base-url', `http://127.0.0.1:${blackHole.address().port}`, '--username', 'brandon', '--password', 'x'],
    { HOMESTEAD_COMPANION_HOME: bhHome, HOMESTEAD_COMPANION_TIMEOUT_MS: '500' },
  );
  const bhElapsed = Date.now() - t0;
  assert(bhCli.status !== 0 && bhCli.status < 128, '`login` against a silent server exits non-zero on its own', bhCli.out);
  assert(bhElapsed < 5000, '`login` against a silent server gives up quickly', `${bhElapsed}ms`);
  assert(/no response/.test(bhCli.out), 'timeout error names the cause', bhCli.out);
  blackHole.closeAllConnections();
  blackHole.close();

  receiver.close();
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  // explicit exit-on-success. The receiver / server listeners
  // are closed but Node's event loop can keep a few handles alive
  // (socket pairs, dns resolver cache) long enough that on slower CI
  // hosts the process sits idle past the run-tests.js wall-clock
  // timeout. `process.exit(0)` guarantees the runner sees a clean
  // exit and moves on to the next script. Mirrors the pattern used
  // by the other scripts in this dir that exit explicitly on pass.
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
