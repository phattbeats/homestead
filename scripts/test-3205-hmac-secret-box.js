#!/usr/bin/env node
// #3205 acceptance tests — envelope-encrypt the agent HMAC secrets at rest.
//
// Before this change a copied `life.db` WAS the keyring: `agent_endpoints.secret`
// and `agent_connections.secret` sat in SQLite as plaintext HMAC keys, so
// anybody holding the file could sign new drawer POSTs and events-webhook
// deliveries as that user. PHA-3199 closed the replay window for captured
// traffic; this closes "you don't even need a captured POST".
//
// What these tests hold down:
//   1. secret-box's envelope primitives: shape detection, round-trip,
//      tamper detection, key resolution (HMAC_CRED_KEY → CALENDAR_CRED_KEY),
//      and that a MALFORMED HMAC_CRED_KEY throws rather than silently
//      falling back to a working key.
//   2. Encrypt-at-rest on every write path (endpoint create/rotate,
//      connection redeem/rotate) — the column is never plaintext.
//   3. Decrypt on every read path that needs the key (copy-once reveal,
//      dispatch signing) — a functional HMAC round-trip after encryption.
//   4. The stolen-DB property: dump the raw column, and that value is NOT
//      a usable HMAC key. This is the actual threat model in the issue.
//   5. Boot migration: plaintext rows → envelopes, in a transaction,
//      idempotent, row counts unchanged, original plaintext recoverable.
//   6. One-release dual-read: a plaintext row (what a rolled-back image
//      sees) still opens, so the rollback window is real and not aspirational.
//   7. Fail-closed: no key → new secrets refused, migration skipped,
//      health probe reports false.
//
// No mocking: real SQLite (temp files), real AES-GCM, real HMAC.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentEndpoints = require('../lib/agent-endpoints');
const agentConnections = require('../lib/agent-connections');
const secretBox = require('../lib/secret-box');

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
function assertThrows(fn, re, label) {
  try {
    fn();
  } catch (err) {
    if (re.test(String(err && err.message))) ok(label);
    else ng(label, `threw ${err && err.message} (did not match ${re})`);
    return;
  }
  ng(label, 'did not throw');
}

const KEY_HEX = 'a'.repeat(64);
const OTHER_KEY_HEX = 'b'.repeat(64);
process.env.HMAC_CRED_KEY = KEY_HEX;

function freshDb(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `homestead-3205-${prefix}-`));
  const db = new Database(path.join(tmpDir, 'life.db'));
  userModel.migrate(db);
  agentEndpoints.migrate(db);
  agentConnections.migrate(db);
  return { db, tmpDir };
}

function cleanup({ db, tmpDir }) {
  try { db.close(); } catch (_) { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function brandonId(db) {
  return db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
}

console.log('#3205 agent HMAC secret envelope tests\n');

// ---- Test 1: envelope primitives ----
{
  console.log('Test 1: secret-box envelope primitives');
  const sealed = secretBox.sealSecret('homestead_aes_example');
  assertEq(sealed.split(':').length, 3, 'envelope is <iv>:<tag>:<ciphertext>');
  assert(secretBox.isEnvelope(sealed), 'isEnvelope accepts a sealed value');
  assertEq(secretBox.openSecret(sealed), 'homestead_aes_example', 'seal/open round-trips');

  const sealed2 = secretBox.sealSecret('homestead_aes_example');
  assert(sealed !== sealed2, 'a fresh IV per seal — same plaintext, different ciphertext');
  assert(!sealed.includes('homestead'), 'ciphertext does not contain the plaintext');

  assert(!secretBox.isEnvelope('homestead_aes_abcdef0123456789abcdef0123456789abcdef0'),
    'isEnvelope rejects a plaintext secret');
  assert(!secretBox.isEnvelope(null), 'isEnvelope rejects null');
  assert(!secretBox.isEnvelope('one:two'), 'isEnvelope rejects a 2-part value');
  assert(!secretBox.isEnvelope('::::'), 'isEnvelope rejects empty parts');

  // GCM must reject tampering — flip a byte in the ciphertext.
  const parts = sealed.split(':');
  const ct = Buffer.from(parts[2], 'base64');
  ct[0] ^= 0xff;
  const tampered = [parts[0], parts[1], ct.toString('base64')].join(':');
  assertThrows(() => secretBox.openSecret(tampered), /authenticate|unable to|Unsupported/i,
    'tampered ciphertext fails to decrypt');
  console.log('');
}

// ---- Test 2: key resolution + fail-closed posture ----
{
  console.log('Test 2: HMAC key resolution');
  const savedHmac = process.env.HMAC_CRED_KEY;
  const savedCal = process.env.CALENDAR_CRED_KEY;

  delete process.env.HMAC_CRED_KEY;
  delete process.env.CALENDAR_CRED_KEY;
  assertEq(secretBox.hmacKeyReady(), false, 'no key at all → hmacKeyReady() false');
  assertThrows(() => secretBox.sealSecret('x'), /HMAC_CRED_KEY is not set/,
    'sealSecret throws without a key (never writes plaintext)');
  assertThrows(() => secretBox.openSecret('homestead_aes_legacy'), /HMAC_CRED_KEY is not set/,
    'openSecret throws without a key even for a legacy plaintext row');

  process.env.CALENDAR_CRED_KEY = OTHER_KEY_HEX;
  assertEq(secretBox.hmacKeyReady(), true, 'CALENDAR_CRED_KEY alone is a valid fallback');
  assertEq(secretBox.openSecret(secretBox.sealSecret('fallback-path')), 'fallback-path',
    'seal/open works on the fallback key');

  // A malformed HMAC_CRED_KEY must NOT silently fall through to a working
  // CALENDAR_CRED_KEY. That fallback would keep signing under the old key
  // after a typo — the "it looked configured" failure this module exists
  // to prevent.
  process.env.HMAC_CRED_KEY = 'too-short';
  assertEq(secretBox.hmacKeyReady(), false, 'malformed HMAC_CRED_KEY → not ready');
  assertThrows(() => secretBox.sealSecret('x'), /HMAC_CRED_KEY must be 64 hex characters/,
    'malformed HMAC_CRED_KEY throws instead of falling back');

  if (savedHmac === undefined) delete process.env.HMAC_CRED_KEY; else process.env.HMAC_CRED_KEY = savedHmac;
  if (savedCal === undefined) delete process.env.CALENDAR_CRED_KEY; else process.env.CALENDAR_CRED_KEY = savedCal;
  assertEq(secretBox.hmacKeyReady(), true, 'restored key → ready');
  console.log('');
}

// ---- Test 3: agent_endpoints encrypt-at-rest + decrypt-on-sign ----
{
  console.log('Test 3: agent_endpoints — encrypt at rest, decrypt to sign');
  const ctx = freshDb('eps');
  const { db } = ctx;
  const uid = brandonId(db);

  const created = agentEndpoints.create(db, uid, {
    harnessLabel: 'Laptop OpenClaw', kind: 'drawer', url: 'http://phattvip.lan:18789/h',
  });
  assert(created.secret_plaintext.startsWith('homestead_aes_'), 'copy-once reveal still returns plaintext');
  assertEq(created.secret_prefix, created.secret_plaintext.slice(0, 16) + '…',
    'prefix chip is derived from the plaintext');

  const row = db.prepare('SELECT secret FROM agent_endpoints WHERE id = ?').get(created.id);
  assert(secretBox.isEnvelope(row.secret), 'column holds an envelope');
  assert(!row.secret.includes('homestead_aes_'), 'column does not hold the plaintext');
  assertEq(secretBox.openSecret(row.secret), created.secret_plaintext, 'envelope opens to the revealed secret');

  // Sign path: dispatch rows must hand back a usable key.
  const forDispatch = agentEndpoints.listEnabledForDispatch(db, uid, 'drawer');
  assertEq(forDispatch.length, 1, 'one dispatchable endpoint');
  assertEq(forDispatch[0].secret, created.secret_plaintext, 'dispatch row carries the plaintext for HMAC signing');
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"hello":"drawer"}';
  const sig = agentEndpoints.signPayload(forDispatch[0].secret, ts, body);
  assert(sig.startsWith('sha256=') && sig.length === 'sha256='.length + 64, 'dispatch row signs a payload');

  // Rotate: new envelope, new plaintext, old plaintext no longer verifies.
  const rotated = agentEndpoints.update(db, created.id, {}, { ownerUserId: uid, rotateSecret: true });
  assert(rotated.secret_plaintext !== created.secret_plaintext, 'rotate mints a different secret');
  const rotatedRow = db.prepare('SELECT secret FROM agent_endpoints WHERE id = ?').get(created.id);
  assert(secretBox.isEnvelope(rotatedRow.secret), 'rotated secret is an envelope');
  assertEq(secretBox.openSecret(rotatedRow.secret), rotated.secret_plaintext, 'rotated envelope opens to the new secret');
  cleanup(ctx);
  console.log('');
}

// ---- Test 4: agent_connections encrypt-at-rest + verifySignature round-trip ----
{
  console.log('Test 4: agent_connections — encrypt at rest, verify after decrypt');
  const ctx = freshDb('conn');
  const { db } = ctx;
  const uid = brandonId(db);

  const minted = agentConnections.mintPairingCode(db, uid, { provider: 'openclaw', label: 'Laptop' });
  const redeemed = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: uid });
  assert(redeemed.secret_plaintext.startsWith('homestead_conn_'), 'redeem reveals the plaintext secret once');

  const row = db.prepare('SELECT secret FROM agent_connections WHERE id = ?').get(redeemed.id);
  assert(secretBox.isEnvelope(row.secret), 'column holds an envelope');
  assert(!row.secret.includes('homestead_conn_'), 'column does not hold the plaintext');

  // The real inbound path, after encryption: sign with the companion's
  // secret, verify with what the server can read back.
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ topic: 'mailbox', body: 'hello' });
  const sig = agentEndpoints.signPayload(redeemed.secret_plaintext, ts, body);
  assert(agentConnections.verifySignature(secretBox.openSecret(row.secret), ts, body, sig),
    'verifySignature accepts a decrypted secret after encrypt-at-rest');

  const active = agentConnections.listActiveForDispatch(db, uid);
  assertEq(active.length, 1, 'one active connection for dispatch');
  assertEq(active[0].secret, redeemed.secret_plaintext, 'dispatch row carries the plaintext');

  // revoke clears it
  agentConnections.revoke(db, redeemed.id, { ownerUserId: uid });
  const cleared = db.prepare('SELECT secret FROM agent_connections WHERE id = ?').get(redeemed.id);
  assertEq(cleared.secret, null, 'revoke leaves no secret behind');
  cleanup(ctx);
  console.log('');
}

// ---- Test 5: the stolen-DB property ----
{
  console.log('Test 5: a stolen life.db is not the keyring');
  const ctx = freshDb('steal');
  const { db } = ctx;
  const uid = brandonId(db);

  const ep = agentEndpoints.create(db, uid, {
    harnessLabel: 'Phone', kind: 'events', url: 'http://phone.lan:9000/hook',
  });
  const conn = agentConnections.redeemPairingCode(
    db,
    agentConnections.mintPairingCode(db, uid, { provider: 'codex', label: 'Box' }).pairing_code,
    { userId: uid },
  );

  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"event":"task_created"}';
  const goodSig = agentEndpoints.signPayload(conn.secret_plaintext, ts, body);

  // An attacker with only the DB file reads the columns and tries to sign.
  const stolenConn = db.prepare('SELECT secret FROM agent_connections WHERE id = ?').get(conn.id).secret;
  const stolenEp = db.prepare('SELECT secret FROM agent_endpoints WHERE id = ?').get(ep.id).secret;
  assert(!agentConnections.verifySignature(stolenConn, ts, body, goodSig),
    'connection ciphertext is not a valid HMAC key');
  assert(!agentConnections.verifySignature(stolenEp, ts, body, goodSig),
    'endpoint ciphertext is not a valid HMAC key');
  // And a signature forged *with* the dumped column value must not verify
  // against the real secret.
  const forgedSig = agentEndpoints.signPayload(stolenConn, ts, body);
  assert(!agentConnections.verifySignature(conn.secret_plaintext, ts, body, forgedSig),
    'a signature made with the dumped column does not verify');
  cleanup(ctx);
  console.log('');
}

// ---- Test 6: boot migration ----
{
  console.log('Test 6: boot migration encrypts legacy plaintext rows in place');
  const ctx = freshDb('migrate');
  const { db } = ctx;
  const uid = brandonId(db);

  // Seed the pre-#3205 shape directly: real plaintext rows.
  const legacy = [
    'homestead_aes_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'homestead_aes_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'homestead_conn_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  ];
  for (const s of legacy.slice(0, 2)) {
    db.prepare(`INSERT INTO agent_endpoints (user_id, harness_label, kind, url, secret)
        VALUES (?, ?, 'drawer', 'http://x.lan/1', ?)`).run(uid, 'Legacy', s);
  }
  db.prepare(`INSERT INTO agent_connections (user_id, provider, status, secret)
      VALUES (?, 'openclaw', 'active', ?)`).run(uid, legacy[2]);

  const before = {
    eps: db.prepare('SELECT COUNT(*) c FROM agent_endpoints').get().c,
    conns: db.prepare('SELECT COUNT(*) c FROM agent_connections').get().c,
  };

  const epsResult = agentEndpoints.migrateSecretsAtRest(db);
  const connResult = agentConnections.migrateSecretsAtRest(db);
  assertEq(epsResult.migrated, 2, 'both plaintext endpoint rows migrated');
  assertEq(connResult.migrated, 1, 'the plaintext connection row migrated');

  assertEq(db.prepare('SELECT COUNT(*) c FROM agent_endpoints').get().c, before.eps, 'endpoint row count unchanged');
  assertEq(db.prepare('SELECT COUNT(*) c FROM agent_connections').get().c, before.conns, 'connection row count unchanged');

  const epsRows = db.prepare('SELECT id, secret FROM agent_endpoints ORDER BY id').all();
  assert(epsRows.every(r => secretBox.isEnvelope(r.secret)), 'every endpoint row is now an envelope');
  assertEq(epsRows.map(r => secretBox.openSecret(r.secret)), legacy.slice(0, 2),
    'each envelope decrypts back to its original plaintext');
  const connRow = db.prepare('SELECT secret FROM agent_connections WHERE id = 1').get();
  assertEq(secretBox.openSecret(connRow.secret), legacy[2], 'connection envelope decrypts back to its original plaintext');

  // Idempotent: a second boot changes nothing.
  const again = agentEndpoints.migrateSecretsAtRest(db);
  assertEq(again.migrated, 0, 'second migration pass migrates 0 rows');
  assertEq(again.scanned, 2, 'second pass still scans the rows');
  cleanup(ctx);
  console.log('');
}

// ---- Test 7: one-release dual-read (rollback image) ----
{
  console.log('Test 7: legacy plaintext still opens (one-release dual-read)');
  assertEq(secretBox.LEGACY_PLAINTEXT_READ, true, 'dual-read flag is on for this release');
  const legacy = 'homestead_aes_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  assert(!secretBox.isEnvelope(legacy), 'legacy row is not an envelope');
  assertEq(secretBox.openSecret(legacy), legacy, 'legacy plaintext passes through untouched');

  // A rolled-back image verifying against a row this release wrote: the
  // server can still decrypt it, and the HMAC still verifies.
  const sealed = secretBox.sealSecret('rollback-check');
  const ts = String(Math.floor(Date.now() / 1000));
  const body = 'x=1';
  const sig = agentEndpoints.signPayload('rollback-check', ts, body);
  assert(agentConnections.verifySignature(secretBox.openSecret(sealed), ts, body, sig),
    'signature made before a rollback still verifies after it');
  console.log('');
}

// ---- Test 8: migration without a key is a no-op, not a data loss event ----
{
  console.log('Test 8: no key → migration skipped, writes refused');
  const ctx = freshDb('nokey');
  const { db } = ctx;
  const uid = brandonId(db);
  db.prepare(`INSERT INTO agent_endpoints (user_id, harness_label, kind, url, secret)
      VALUES (?, 'Legacy', 'drawer', 'http://x.lan/1', 'homestead_aes_LEGACYROWLEGACYROWLEGACYROWLEGACYRO')`).run(uid);
  const legacyPlaintext = db.prepare('SELECT secret FROM agent_endpoints').get().secret;

  const savedHmac = process.env.HMAC_CRED_KEY;
  const savedCal = process.env.CALENDAR_CRED_KEY;
  delete process.env.HMAC_CRED_KEY;
  delete process.env.CALENDAR_CRED_KEY;
  try {
    const result = agentEndpoints.migrateSecretsAtRest(db);
    assertEq(result.skipped, 'no-hmac-key', 'migration reports it skipped');
    assertEq(result.migrated, 0, 'migration moved nothing');
    assertEq(db.prepare('SELECT secret FROM agent_endpoints').get().secret, legacyPlaintext,
      'the legacy row is left intact — a missing key must not destroy data');

    assertThrows(() => agentEndpoints.create(db, uid, {
      harnessLabel: 'New', kind: 'drawer', url: 'http://x.lan/2',
    }), /HMAC_CRED_KEY is not set/, 'create() refuses without a key');
    const minted = agentConnections.mintPairingCode(db, uid, { provider: 'openclaw' });
    assertThrows(() => agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: uid }),
      /HMAC_CRED_KEY is not set/, 'redeemPairingCode() refuses without a key');
    assertThrows(() => agentEndpoints.listEnabledForDispatch(db, uid, 'drawer'),
      /HMAC_CRED_KEY is not set/, 'dispatch lookup refuses without a key');

    // The reveal degrades rather than crashing a settings page.
    const list = agentEndpoints.list(db, uid);
    assertEq(list[0].secret_prefix, null, 'prefix chip degrades to null when the key is missing');
  } finally {
    if (savedHmac !== undefined) process.env.HMAC_CRED_KEY = savedHmac;
    if (savedCal !== undefined) process.env.CALENDAR_CRED_KEY = savedCal;
  }
  cleanup(ctx);
  console.log('');
}

// ---- Test 9: identifier guard on the migration helper ----
{
  console.log('Test 9: encryptSecretColumn refuses non-identifier table/column names');
  const ctx = freshDb('guard');
  assertThrows(() => secretBox.encryptSecretColumn(ctx.db, { table: 'agent_endpoints; DROP TABLE users' }),
    /not a plain SQL identifier/, 'table name with SQL is rejected');
  assertThrows(() => secretBox.encryptSecretColumn(ctx.db, { table: 'agent_endpoints', column: 'secret WHERE 1=1' }),
    /not a plain SQL identifier/, 'column name with SQL is rejected');
  cleanup(ctx);
  console.log('');
}

// ---- Test 10: exactly one decrypt point on the sign path ----
{
  console.log('Test 10: the sign path has a single decrypt point');
  const ctx = freshDb('onepoint');
  const { db } = ctx;
  const uid = brandonId(db);
  const ep = agentEndpoints.create(db, uid, {
    harnessLabel: 'Drawer', kind: 'drawer', url: 'http://harness.lan:1/drawer',
  });

  const one = agentEndpoints.getEnabledForDispatch(db, uid, ep.id, 'drawer');
  assert(one && one.secret === ep.secret_plaintext, 'getEnabledForDispatch yields the plaintext key');
  const many = agentEndpoints.listEnabledForDispatch(db, uid, 'drawer');
  assert(many[0].secret === ep.secret_plaintext, 'listEnabledForDispatch yields the same key');
  assertEq(one.secret, many[0].secret, 'single-row and sweep agree — one decrypt, one answer');

  // Structural guard, same shape as test-3214's server.js line-count
  // check. A dispatcher that hand-rolls `SELECT *` on a secret table gets
  // the stored ciphertext and signs with it — every harness rejects the
  // signature and the failure looks like "my harness is broken". This
  // shipped once already in this same PR; keep the tripwire.
  const libDir = path.join(__dirname, '..', 'lib');
  const offenders = [];
  for (const file of ['drawer-dispatch.js', 'events-dispatch.js', 'agent-runtime.js']) {
    const src = fs.readFileSync(path.join(libDir, file), 'utf8');
    if (/SELECT\s+\*\s+FROM\s+agent_(endpoints|connections)/i.test(src)) offenders.push(file);
  }
  assertEq(offenders, [], 'no dispatcher hand-rolls SELECT * on a secret table');
  cleanup(ctx);
  console.log('');
}

console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exitCode = 1;