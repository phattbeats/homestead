#!/usr/bin/env node
// PHA-2704 acceptance tests for the canonical identity foundation.
//
// What this script guards:
//   * local_credentials and identity_links tables exist and have the
//     expected schema (FKs, UNIQUE constraint on (provider, issuer,
//     provider_subject), migration-state flag table).
//   * One-time backfill from users.pass_hash into local_credentials
//     runs on first boot only — re-runs are no-ops.
//   * One-time backfill from users.auth_provider + provider_subject
//     into identity_links runs on first boot only.
//   * provisionOrClaim() prefers identity_links (canonical), then
//     username (transitional fallback), then CREATE.
//   * linkIdentity() refuses UNIQUE-constraint collisions (provider
//     collision → 409 mapping at the API layer).
//   * unlinkIdentity() refuses to drop the last link when the user
//     also has no local credential (no orphaning).
//   * Multi-provider is supported (one user, multiple identity_links
//     rows, different (provider, issuer, provider_subject) triples).
//   * setLocalPassword() / verifyLocalPassword() round-trip through
//     local_credentials (NOT users.pass_hash).
//   * Migration preserves user_id values (no row renumbering) and
//     does not change memberships/history.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const identity = require('../lib/identity');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-p2704-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

console.log('PHA-2704 identity foundation tests\n');

// ---- Test 1: schema exists with expected shape ----
{
  console.log('Test 1: schema — local_credentials, identity_links, _identity_migration_state');
  const { db, tmpDir } = freshDb();

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
  assert(tables.includes('local_credentials'), 'local_credentials table created');
  assert(tables.includes('identity_links'), 'identity_links table created');
  assert(tables.includes('_identity_migration_state'), '_identity_migration_state table created');

  // local_credentials columns
  const lcCols = db.prepare("PRAGMA table_info(local_credentials)").all().map(c => c.name);
  for (const required of ['user_id', 'password_hash', 'recovery_token_hash', 'recovery_token_expires_at', 'created_at', 'updated_at']) {
    assert(lcCols.includes(required), `local_credentials has column ${required}`);
  }

  // identity_links columns
  const ilCols = db.prepare("PRAGMA table_info(identity_links)").all().map(c => c.name);
  for (const required of ['id', 'user_id', 'provider', 'issuer', 'provider_subject', 'linked_at', 'last_used_at']) {
    assert(ilCols.includes(required), `identity_links has column ${required}`);
  }

  // UNIQUE constraint on (provider, issuer, provider_subject)
  // SQLite stores UNIQUE as either a separate CREATE UNIQUE INDEX or
  // as a table-level constraint inside the CREATE TABLE. We accept
  // either form.
  const ilIndexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='identity_links'").all();
  const ilTableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='identity_links'").get() || {}).sql || '';
  const uniqueInIndex = ilIndexes.some(i => i.sql && i.sql.includes('UNIQUE') && i.sql.includes('provider') && i.sql.includes('issuer') && i.sql.includes('provider_subject'));
  const uniqueInTable = ilTableSql.includes('UNIQUE') && ilTableSql.includes('provider') && ilTableSql.includes('issuer') && ilTableSql.includes('provider_subject');
  assert(uniqueInIndex || uniqueInTable, 'identity_links has UNIQUE(provider, issuer, provider_subject)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: backfill local_credentials from users.pass_hash (one-time) ----
{
  console.log('\nTest 2: backfill local_credentials from users.pass_hash');
  const { db, tmpDir } = freshDb();

  const lcRows = db.prepare('SELECT user_id, password_hash FROM local_credentials ORDER BY user_id').all();
  assertEq(lcRows.length, 3, 'three local_credentials rows seeded from the three users');
  // bcrypt hashes are non-empty
  for (const r of lcRows) {
    assert(r.password_hash && r.password_hash.startsWith('$2'), `user ${r.user_id} password_hash is a bcrypt hash`, r.password_hash);
  }

  // Verify the existing plaintext 'changeme' (default LAN seed) works
  // against the migrated credentials — the backfill must preserve
  // password material, not re-hash plaintext.
  for (const r of lcRows) {
    assert(identity.verifyLocalPassword(db, r.user_id, 'changeme'), `user ${r.user_id} accepts the legacy 'changeme' password`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: backfill identity_links from users.auth_provider + provider_subject ----
{
  console.log('\nTest 3: backfill identity_links from users.auth_provider + provider_subject');
  // Build a DB that already has auth_provider/provider_subject populated
  // on a user, so we can verify the backfill picks it up.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-p2704-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  // Pre-create users table with the legacy v0.0.5+ shape, including
  // auth_provider and provider_subject populated on user id=1.
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE COLLATE NOCASE NOT NULL,
      display TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7c9a72',
      pass_hash TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      avatar_url TEXT,
      preferences TEXT NOT NULL DEFAULT '{}',
      auth_provider TEXT,
      provider_subject TEXT,
      claimed_at TEXT,
      last_seen_at TEXT,
      first_run_completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users (username, display, pass_hash, auth_provider, provider_subject, claimed_at)
      VALUES ('brandon', 'Brandon', '\$2b\$10\$fakehash', 'header_trust', 'brandon-from-authentik', '2026-01-01 12:00:00');
  `);
  userModel.migrate(db);
  const links = db.prepare('SELECT user_id, provider, issuer, provider_subject, linked_at FROM identity_links').all();
  assertEq(links.length, 1, 'one identity_link backfilled');
  assertEq(links[0].user_id, 1, 'link points at the pre-existing user_id=1');
  assertEq(links[0].provider, 'header_trust', 'provider preserved');
  assertEq(links[0].issuer, 'legacy-bootstrap', 'issuer defaulted to legacy-bootstrap');
  assertEq(links[0].provider_subject, 'brandon-from-authentik', 'provider_subject preserved');
  assertEq(links[0].linked_at, '2026-01-01 12:00:00', 'linked_at sourced from claimed_at');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: backfill is idempotent (re-running migrate does NOT re-hash or re-link) ----
{
  console.log('\nTest 4: backfill is idempotent on re-run');
  const { db, tmpDir } = freshDb();

  // Capture hashes BEFORE re-run.
  const before = db.prepare('SELECT password_hash FROM local_credentials ORDER BY user_id').all().map(r => r.password_hash);
  const linksBefore = db.prepare('SELECT user_id, provider, provider_subject FROM identity_links').all();

  // Re-run migrate on the same DB (migrate is supposed to be idempotent).
  userModel.migrate(db);

  const after = db.prepare('SELECT password_hash FROM local_credentials ORDER BY user_id').all().map(r => r.password_hash);
  const linksAfter = db.prepare('SELECT user_id, provider, provider_subject FROM identity_links').all();

  assertEq(after, before, 'password_hash values unchanged after re-migrate');
  assertEq(linksAfter, linksBefore, 'identity_links rows unchanged after re-migrate');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: provisionOrClaim prefers identity_links over username ----
{
  console.log('\nTest 5: provisionOrClaim lookup prefers identity_links');
  const { db, tmpDir } = freshDb();

  // Seed a non-default user via direct INSERT so the username is
  // 'casey' and the auth_provider/provider_subject are both populated
  // through the backfill.
  db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, auth_provider, provider_subject, claimed_at)
              VALUES ('casey', 'Casey', '#7c9eb8', '', 0, 'header_trust', 'casey-uid-99', '2026-01-01 12:00:00')`).run();
  const caseyId = db.prepare('SELECT id FROM users WHERE username = ?').get('casey').id;
  // Force re-run migrate so the backfill populates identity_links for casey.
  // (migrate is idempotent — the backfill will see auth_provider set and insert a link.)
  db.prepare('DELETE FROM _identity_migration_state WHERE key = \'identity_links_migrated\'').run();
  userModel.migrate(db);

  // Now rename the username. The identity_links row still points at
  // the same user_id but the username no longer matches the
  // provider_subject. This simulates the PHA-2703 "link Authentik later"
  // scenario where the user changed their display name and the
  // external identity subject is the stable canonical key.
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('casey-renamed', caseyId);

  // Lookup by the original identity subject — must resolve to caseyId.
  const linked = identity.findUserByIdentityLink(db, 'header_trust', 'legacy-bootstrap', 'casey-uid-99');
  assertEq(linked && linked.userId, caseyId, 'findUserByIdentityLink returns the renamed user');

  // provisionOrClaim with the new username should NOT find casey
  // (transitional username fallback misses because the row was renamed)
  // — it would CREATE a new user, which is the documented behavior.
  const newFromUsername = userModel.provisionOrClaim(db, 'casey-renamed', 'header_trust', 'casey-uid-99', ['household']);
  assertEq(newFromUsername.id, caseyId, 'provisionOrClaim by (provider, subject) hits the renamed user via identity_links');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: linkIdentity refuses UNIQUE-constraint collision ----
{
  console.log('\nTest 6: linkIdentity refuses collision (409 path)');
  const { db, tmpDir } = freshDb();
  const u1 = userModel.provisionOrClaim(db, 'dave', 'header_trust', 'dave', ['household']);
  const u2 = userModel.provisionOrClaim(db, 'eve', 'header_trust', 'eve', ['household']);

  // First link succeeds for u1, so the second link from u2 should throw.
  identity.linkIdentity(db, u1.id, 'authentik', 'https://authentik.phatt.vip/application/oauth/homestead/', 'shared-subject');
  let threw2 = false;
  let code2 = '';
  try {
    identity.linkIdentity(db, u2.id, 'authentik', 'https://authentik.phatt.vip/application/oauth/homestead/', 'shared-subject');
  } catch (e) {
    threw2 = true;
    code2 = e.code || '';
  }
  assert(threw2, 'collision throws');
  assertEq(code2, 'identity_collision', 'collision has code=identity_collision');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: unlinkIdentity refuses to orphan ----
{
  console.log('\nTest 7: unlinkIdentity refuses to orphan last link');
  const { db, tmpDir } = freshDb();
  // Use createUser so the user starts with NO identity_links (the
  // CLAIM flow would create one). Then add a single link and try to
  // remove it — should be blocked because the user has no local credential.
  const frankId = identity.createUser(db, { username: 'frank', display: 'Frank' });

  // No link exists yet → unlink is a no-op with blocked=null.
  let result = identity.unlinkIdentity(db, frankId, 'authentik', 'https://authentik.phatt.vip/', 'frank-uid');
  assertEq(result, { removed: false, blocked: null }, 'unlink of non-existent link returns removed=false');

  // Link ONE identity, no local credential → unlink blocked (would orphan).
  identity.linkIdentity(db, frankId, 'authentik', 'https://authentik.phatt.vip/', 'frank-uid');
  result = identity.unlinkIdentity(db, frankId, 'authentik', 'https://authentik.phatt.vip/', 'frank-uid');
  assertEq(result, { removed: false, blocked: 'no_login_path' }, 'unlink blocked when it would orphan');

  // Add local credential → unlink should now succeed.
  identity.setLocalPassword(db, frankId, 'frankpass');
  result = identity.unlinkIdentity(db, frankId, 'authentik', 'https://authentik.phatt.vip/', 'frank-uid');
  assertEq(result, { removed: true, blocked: null }, 'unlink succeeds after local credential added');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: multi-provider support ----
{
  console.log('\nTest 8: one user can have multiple identity_links (multi-provider)');
  const { db, tmpDir } = freshDb();
  // createUser → no identity_links to start. Then link three.
  const ginaId = identity.createUser(db, { username: 'gina', display: 'Gina' });
  identity.linkIdentity(db, ginaId, 'authentik', 'https://authentik.phatt.vip/', 'gina-uid');
  identity.linkIdentity(db, ginaId, 'github', 'https://github.com', 'gina-gh');
  identity.linkIdentity(db, ginaId, 'google', 'https://accounts.google.com', 'gina-ga');

  const links = identity.listIdentityLinks(db, ginaId);
  assertEq(links.length, 3, 'three links for one user');
  const providers = links.map(l => l.provider).sort();
  assertEq(providers, ['authentik', 'github', 'google'], 'all three providers linked');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: setLocalPassword / verifyLocalPassword round-trip ----
{
  console.log('\nTest 9: setLocalPassword / verifyLocalPassword round-trip');
  const { db, tmpDir } = freshDb();
  const hugoId = identity.createUser(db, { username: 'hugo', display: 'Hugo' });

  assert(!identity.hasLocalCredential(db, hugoId), 'hugo starts with no local credential');
  identity.setLocalPassword(db, hugoId, 'hugopass');
  assert(identity.hasLocalCredential(db, hugoId), 'hugo has local credential after setLocalPassword');
  assert(identity.verifyLocalPassword(db, hugoId, 'hugopass'), 'hugo accepts the new password');
  assert(!identity.verifyLocalPassword(db, hugoId, 'wrongpass'), 'hugo rejects a wrong password');
  assert(!identity.verifyLocalPassword(db, hugoId, ''), 'hugo rejects empty password');

  // The legacy users.pass_hash shadow sync is a server-side concern
  // (the /api/password and /api/users/:username/password routes write
  // it after calling identity.setLocalPassword). identity itself
  // doesn't touch the shadow — verify that here so future
  // refactors don't accidentally break it.
  const passShadow = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(hugoId).pass_hash;
  const localHash = db.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(hugoId).password_hash;
  assert(passShadow === '' && localHash.startsWith('$2'),
    'setLocalPassword writes to local_credentials only (shadow sync is server-side)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9b: shadow sync contract via the server-style helper ----
{
  console.log('\nTest 9b: shadow-sync helper keeps users.pass_hash in sync');
  const { db, tmpDir } = freshDb();
  const liamId = identity.createUser(db, { username: 'liam', display: 'Liam' });
  identity.setLocalPassword(db, liamId, 'liampass');
  // Simulate the server.js route pattern: after setLocalPassword,
  // copy the bcrypt hash into users.pass_hash as a deprecated shadow.
  db.prepare('UPDATE users SET pass_hash = (SELECT password_hash FROM local_credentials WHERE user_id = ?) WHERE id = ?').run(liamId, liamId);
  const passShadow = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(liamId).pass_hash;
  const localHash = db.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(liamId).password_hash;
  assertEq(passShadow, localHash, 'shadow sync pattern produces matching bcrypt hashes');
  assert(identity.verifyLocalPassword(db, liamId, 'liampass'), 'verifyLocalPassword still works after shadow sync');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 10: migration preserves user_id values and memberships ----
{
  console.log('\nTest 10: migration preserves user_id values + memberships/history');
  const { db, tmpDir } = freshDb();
  // Snapshot pre-migration IDs (well — we already migrated; we're
  // checking that the seed users keep the same IDs across the migration
  // shape. Run a second migrate and confirm IDs are unchanged.)
  const beforeIds = db.prepare('SELECT id, username FROM users ORDER BY id').all();
  // Add a wall_membership for brandon.
  const wallsExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='walls'").get();
  if (!wallsExist) {
    db.exec(`
      CREATE TABLE walls (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, visibility TEXT, group_name TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE wall_memberships (id INTEGER PRIMARY KEY, wall_id INTEGER, user_id INTEGER, role TEXT, joined_at TEXT);
      INSERT INTO walls (slug, name, visibility) VALUES ('household', 'Household', 'group');
    `);
  }
  const brandonId = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
  const householdWallId = db.prepare('SELECT id FROM walls WHERE slug = ?').get('household').id;
  db.prepare('INSERT INTO wall_memberships (wall_id, user_id, role) VALUES (?, ?, ?)').run(householdWallId, brandonId, 'admin');

  userModel.migrate(db); // re-run
  const afterIds = db.prepare('SELECT id, username FROM users ORDER BY id').all();
  assertEq(afterIds, beforeIds, 'user IDs unchanged across re-migrate');

  const memberships = db.prepare('SELECT * FROM wall_memberships WHERE user_id = ?').all(brandonId);
  assertEq(memberships.length, 1, 'membership history preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 11: createUser creates user + local_credentials atomically ----
{
  console.log('\nTest 11: identity.createUser creates user + local_credentials atomically');
  const { db, tmpDir } = freshDb();
  const id1 = identity.createUser(db, { username: 'iris', display: 'Iris', plaintext: 'irispass' });
  const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id1);
  assertEq(u.username, 'iris', 'user row created');
  assert(identity.hasLocalCredential(db, id1), 'local_credentials row created');
  assert(identity.verifyLocalPassword(db, id1, 'irispass'), 'plaintext password round-trips');

  // Duplicate username should reject.
  let threw = false;
  try {
    identity.createUser(db, { username: 'iris', plaintext: 'irispass2' });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'duplicate username rejected');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 12: linkIdentity self-link is a no-op ----
{
  console.log('\nTest 12: linkIdentity self-link is a no-op');
  const { db, tmpDir } = freshDb();
  const u = userModel.provisionOrClaim(db, 'jane', 'header_trust', 'jane', ['household']);
  // CLAIM created a (header_trust, legacy-bootstrap, jane) link. Re-linking should no-op.
  const before = db.prepare('SELECT COUNT(*) AS c FROM identity_links WHERE user_id = ?').get(u.id).c;
  const result = identity.linkIdentity(db, u.id, 'header_trust', 'legacy-bootstrap', 'jane');
  const after = db.prepare('SELECT COUNT(*) AS c FROM identity_links WHERE user_id = ?').get(u.id).c;
  assertEq(after, before, 'no new row created on self-link');
  assertEq(result, { id: null, alreadyLinked: true }, 'self-link returns alreadyLinked=true');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 13: linkIdentity rejects empty inputs ----
{
  console.log('\nTest 13: linkIdentity rejects missing provider/issuer/subject');
  const { db, tmpDir } = freshDb();
  const u = userModel.provisionOrClaim(db, 'kate', 'header_trust', 'kate', ['household']);
  for (const [missing, args] of [
    ['provider', { provider: '', issuer: 'iss', provider_subject: 'sub' }],
    ['issuer', { provider: 'p', issuer: '', provider_subject: 'sub' }],
    ['provider_subject', { provider: 'p', issuer: 'iss', provider_subject: '' }],
  ]) {
    let threw = false;
    try { identity.linkIdentity(db, u.id, args.provider, args.issuer, args.provider_subject); }
    catch (_) { threw = true; }
    assert(threw, `linkIdentity throws on missing ${missing}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
