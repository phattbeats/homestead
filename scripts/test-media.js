#!/usr/bin/env node
// PHA-2149 acceptance tests for lib/media.js: happy path upload + fetch +
// thumb, retention expiry, oversized rejection, mime allowlist, and
// double-insert dedupe (sha collision -> same id). Drives lib/media.js
// directly against a temp SQLite file + temp DATA_DIR, same pattern as
// scripts/test-agent-tokens.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

// A minimal valid 1x1 PNG (transparent), used as the upload fixture.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

console.log('PHA-2149 media tests\n');

(async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-media-test-'));
  process.env.DATA_DIR = tmpDataDir;

  const userModel = require('../lib/user-model');
  const media = require('../lib/media');

  const dbPath = path.join(tmpDataDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  media.migrate(db);

  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');

  // Drive upload/fetch/remove through a real (in-process) HTTP server so
  // multer's multipart parsing runs exactly as it does in server.js.
  const app = require('express')();
  app.use((req, res, next) => {
    req.session = { user: { username: 'brandon' } };
    next();
  });
  app.post('/upload', media.upload);
  app.get('/media/:id', (req, res) => media.fetch(req.params.id, res, false));
  app.get('/media/:id/thumb', (req, res) => media.fetch(req.params.id, res, true));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  function multipartBody(fieldName, filename, mime, buf) {
    const boundary = '----homestead-test-boundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { boundary, body: Buffer.concat([head, buf, tail]) };
  }

  async function uploadFile(filename, mime, buf) {
    const { boundary, body } = multipartBody('file', filename, mime, buf);
    const res = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    return { status: res.status, json: await res.json() };
  }

  // ---- Test 1: happy path upload + fetch + thumb ----
  console.log('Test 1: happy path upload + fetch + thumb');
  const up1 = await uploadFile('smoke.png', 'image/png', PNG_1X1);
  assertEq(up1.status, 200, 'upload returns 200');
  assert(!!up1.json.id, 'upload returns an id');
  assertEq(up1.json.kind, 'image', 'kind=image');
  assert(up1.json.url.includes(up1.json.id), 'url includes id');
  assert(!!up1.json.thumbUrl, 'thumbUrl present for image');

  const row1 = db.prepare('SELECT * FROM media_uploads WHERE id = ?').get(up1.json.id);
  assert(!!row1, 'row exists in media_uploads');
  assertEq(row1.owner_user_id, brandon.id, 'owner is caller');
  assert(fs.existsSync(path.join(tmpDataDir, row1.path)), 'original file written to disk');
  assert(fs.existsSync(path.join(tmpDataDir, row1.thumb_path)), 'thumb file written to disk');

  const fetchRes = await fetch(`${base}/media/${up1.json.id}`);
  assertEq(fetchRes.status, 200, 'GET /media/:id returns 200');
  const fetchBuf = Buffer.from(await fetchRes.arrayBuffer());
  assert(fetchBuf.length > 0, 'GET /media/:id returns non-empty body');

  const thumbRes = await fetch(`${base}/media/${up1.json.id}/thumb`);
  assertEq(thumbRes.status, 200, 'GET /media/:id/thumb returns 200');

  // ---- Test 2: double-insert dedupe (same sha -> same id) ----
  console.log('\nTest 2: double-insert dedupe');
  const up2 = await uploadFile('smoke-again.png', 'image/png', PNG_1X1);
  assertEq(up2.status, 200, 'second identical upload returns 200');
  assertEq(up2.json.id, up1.json.id, 'dedupes to same id as first upload');
  assertEq(db.prepare('SELECT COUNT(*) c FROM media_uploads').get().c, 1, 'only one row exists after dedupe');

  // ---- Test 3: mime allowlist rejection ----
  console.log('\nTest 3: mime allowlist');
  const up3 = await uploadFile('bad.txt', 'text/plain', Buffer.from('not media'));
  assertEq(up3.status, 400, 'disallowed mime returns 400');

  // ---- Test 4: oversized file rejection ----
  console.log('\nTest 4: oversized file rejection');
  const bigBuf = Buffer.alloc(media.MAX_IMAGE_BYTES + 1024, 1);
  // Give it a valid-looking image mime so it fails on size, not mime.
  const up4 = await uploadFile('big.png', 'image/png', bigBuf);
  assertEq(up4.status, 413, 'oversized image returns 413');

  // ---- Test 5: retention expiry via cleanupSweep ----
  console.log('\nTest 5: retention expiry sweep');
  const up5 = await uploadFile('expiring.png', 'image/png', Buffer.concat([PNG_1X1, Buffer.from([0x00])]));
  const expRow = db.prepare('SELECT * FROM media_uploads WHERE id = ?').get(up5.json.id);
  db.prepare("UPDATE media_uploads SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(up5.json.id);
  const swept = media.cleanupSweep(db, { graceMs: 0 });
  assert(swept.reaped >= 1, 'sweep reaps at least the expired row');
  assert(!db.prepare('SELECT 1 FROM media_uploads WHERE id = ?').get(up5.json.id), 'row removed after sweep');
  assert(!fs.existsSync(path.join(tmpDataDir, expRow.path)), 'file unlinked after sweep');

  // ---- Test 6: soft-delete then grace-window sweep ----
  console.log('\nTest 6: soft-delete + grace window');
  const up6 = await uploadFile('delete-me.png', 'image/png', Buffer.concat([PNG_1X1, Buffer.from([0x01])]));
  const delRow = db.prepare('SELECT * FROM media_uploads WHERE id = ?').get(up6.json.id);

  const forbidden = media.remove(up6.json.id, emily.id);
  assertEq(forbidden.error, 'forbidden', 'non-owner non-admin cannot delete');

  const removed = media.remove(up6.json.id, brandon.id);
  assertEq(removed.ok, true, 'owner can soft-delete');
  const afterSoft = db.prepare('SELECT deleted_at FROM media_uploads WHERE id = ?').get(up6.json.id);
  assert(!!afterSoft.deleted_at, 'deleted_at stamped');

  const noSweepYet = media.cleanupSweep(db, { graceMs: 24 * 60 * 60 * 1000 });
  assert(!!db.prepare('SELECT 1 FROM media_uploads WHERE id = ?').get(up6.json.id), 'row survives sweep inside grace window');

  const sweptAfterGrace = media.cleanupSweep(db, { graceMs: 0 });
  assert(sweptAfterGrace.reaped >= 1, 'sweep reaps once grace window has elapsed');
  assert(!db.prepare('SELECT 1 FROM media_uploads WHERE id = ?').get(up6.json.id), 'row gone after grace-window sweep');
  assert(!fs.existsSync(path.join(tmpDataDir, delRow.path)), 'file unlinked after grace-window sweep');

  await new Promise((resolve) => server.close(resolve));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
