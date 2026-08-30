#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2644 end-to-end smoke: boot server.js from a clean DATA_DIR,
// log in as brandon, upload an image (with caption) + a synthetic
// video, hit /api/media/:id/context on both, capture the JSON
// responses into verify-out/. Curl transcript is the durable
// evidence the issue's DoD requires (alongside the unit tests
// and the ffmpeg-avi keyframe extraction).
//
// Usage: node scripts/smoke-2644-media-context.js
// Output: verify-out/smoke-2644-{image,video}-context.json plus
//         verify-out/smoke-2644-frame-001.jpg

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const REPO = path.resolve(__dirname, '..');
const VERIFY_OUT = path.join(REPO, 'verify-out');
fs.mkdirSync(VERIFY_OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-2644-smoke-'));
process.env.DATA_DIR = TMP;
process.env.PORT = process.env.PORT || '3080';
// Force a no-key path so the smoke is hermetic and doesn't need
// an OpenAI key to demonstrate the comprehension package.
delete process.env.OPENAI_API_KEY;

function log(label, val) { console.log(`[smoke] ${label}: ${val}`); }
function fatal(msg) { console.error(`[smoke] FATAL: ${msg}`); process.exit(1); }

// ---- prepare brandon user (server.js's migrate() seeds the DB) ----
const userModel = require(path.join(REPO, 'lib/user-model'));
const media = require(path.join(REPO, 'lib/media'));
const analytics = require(path.join(REPO, 'lib/analytics'));
const db = new Database(path.join(TMP, 'life.db'));
userModel.migrate(db);
media.migrate(db);
analytics.migrate(db);
const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
if (!brandon) fatal('brandon user not seeded by userModel.migrate');
log('brandon id', brandon.id);

// ---- build a small valid PNG (8x8 red) ----
async function makePng() {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).png().toBuffer();
}

// ---- build a 3-second MP4 with two scenes (no audio) ----
function makeVideo() {
  return new Promise((resolve, reject) => {
    const out = path.join(TMP, `smoke-${crypto.randomUUID()}.mp4`);
    execFile('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=green:s=160x120:r=10:d=1.5',
      '-f', 'lavfi', '-i', 'color=c=yellow:s=160x120:r=10:d=1.5',
      '-filter_complex', '[0:v]format=yuv420p[v0];[1:v]format=yuv420p[v1];[v0][v1]concat=n=2:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      '-movflags', '+faststart',
      '-f', 'mp4',
      out,
    ], (err) => {
      if (err) return reject(err);
      resolve(fs.readFileSync(out));
    });
  });
}

// ---- boot the actual server.js ----
console.log('[smoke] booting server.js...');
const serverProc = require('child_process').spawn('node', [path.join(REPO, 'server.js')], {
  env: { ...process.env, DATA_DIR: TMP, PORT: '3080' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let booted = null;
const bootTimeout = setTimeout(() => fatal('server did not log "Homestead on" within 15s'), 15000);
serverProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  if (s.includes('Homestead on')) {
    const m = s.match(/Homestead on :(\d+)/);
    if (m) {
      booted = parseInt(m[1], 10);
      clearTimeout(bootTimeout);
      runSmoke();
    }
  }
});
serverProc.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
process.on('exit', () => { try { serverProc.kill('SIGKILL'); } catch (_) {} });

function port() {
  if (!booted) fatal('server did not announce a port');
  return booted;
}

function req(method, p, { body, headers, cookies } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: port(), method, path: p,
      headers: {
        ...(data ? { 'Content-Length': data.length } : {}),
        ...(headers || {}),
        ...(cookies ? { Cookie: cookies } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const setCookie = (res.headers['set-cookie'] || []).join('; ');
        resolve({ status: res.statusCode, headers: res.headers, body: buf, setCookie });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function loginAsBrandon() {
  const r = await req('POST', '/api/login', {
    body: JSON.stringify({ username: 'brandon', password: 'changeme' }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200 && r.status !== 302) fatal(`login status ${r.status}: ${r.body.toString()}`);
  return r.setCookie;
}

function multipart(fields) {
  const boundary = '----smoke-2644-boundary';
  const parts = [];
  for (const f of fields) {
    const head = f.filename
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`
      : `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n`;
    parts.push(Buffer.from(head));
    parts.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(String(f.value)));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

async function runSmoke() {
  try {
    const cookie = await loginAsBrandon();
    log('logged in', 'brandon');

    // ---- image upload + context ----
    const png = await makePng();
    const imgUp = multipart([
      { name: 'file', filename: 'smoke.png', mime: 'image/png', value: png },
      { name: 'caption', value: 'smoke test: red 8x8 PNG' },
    ]);
    const up1 = await req('POST', '/api/media', {
      body: imgUp.body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${imgUp.boundary}` },
      cookies: cookie,
    });
    if (up1.status !== 200) fatal(`image upload ${up1.status}: ${up1.body.toString()}`);
    const imgRow = JSON.parse(up1.body.toString());
    log('image upload id', imgRow.id);

    const imgCtx = await req('GET', `/api/media/${imgRow.id}/context`, { cookies: cookie });
    if (imgCtx.status !== 200) fatal(`image context ${imgCtx.status}: ${imgCtx.body.toString()}`);
    const imgPkg = JSON.parse(imgCtx.body.toString());
    fs.writeFileSync(path.join(VERIFY_OUT, 'smoke-2644-image-context.json'), imgCtx.body);
    log('image context kind', imgPkg.kind);
    log('image context caption', imgPkg.caption);

    // ---- video upload + context ----
    const video = await makeVideo();
    const vidUp = multipart([
      { name: 'file', filename: 'smoke.mp4', mime: 'video/mp4', value: video },
      { name: 'caption', value: 'smoke test: green→yellow 3s clip' },
    ]);
    const up2 = await req('POST', '/api/media', {
      body: vidUp.body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${vidUp.boundary}` },
      cookies: cookie,
    });
    if (up2.status !== 200) fatal(`video upload ${up2.status}: ${up2.body.toString()}`);
    const vidRow = JSON.parse(up2.body.toString());
    log('video upload id', vidRow.id);
    log('video durationMs', vidRow.durationMs);

    const vidCtx = await req('GET', `/api/media/${vidRow.id}/context`, { cookies: cookie });
    if (vidCtx.status !== 200) fatal(`video context ${vidCtx.status}: ${vidCtx.body.toString()}`);
    const vidPkg = JSON.parse(vidCtx.body.toString());
    fs.writeFileSync(path.join(VERIFY_OUT, 'smoke-2644-video-context.json'), vidCtx.body);
    log('video context kind', vidPkg.kind);
    log('video frame count', vidPkg.frames.length);
    log('video firstFrame', vidPkg.firstFrame);
    log('video lastFrame', vidPkg.lastFrame);
    log('audio status', vidPkg.audioTranscriptStatus);

    // ---- pull one keyframe to disk as JPG artifact ----
    if (vidPkg.frames.length > 0) {
      const f = await req('GET', vidPkg.frames[0].url, { cookies: cookie });
      if (f.status === 200) {
        fs.writeFileSync(path.join(VERIFY_OUT, 'smoke-2644-frame-001.jpg'), f.body);
        log('frame 0 saved', `${f.body.length} bytes`);
      } else {
        log('frame 0 fetch status', f.status);
      }
    }

    // ---- second hit (cache) ----
    const vidCtx2 = await req('GET', `/api/media/${vidRow.id}/context`, { cookies: cookie });
    const vidPkg2 = JSON.parse(vidCtx2.body.toString());
    log('cache hit on second call', vidPkg2.cacheHit);

    console.log('\n[smoke] all assertions passed; output:');
    console.log(`  - ${path.join(VERIFY_OUT, 'smoke-2644-image-context.json')}`);
    console.log(`  - ${path.join(VERIFY_OUT, 'smoke-2644-video-context.json')}`);
    if (vidPkg.frames.length > 0) {
      console.log(`  - ${path.join(VERIFY_OUT, 'smoke-2644-frame-001.jpg')}`);
    }
    serverProc.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    console.error('[smoke] error:', e);
    serverProc.kill('SIGTERM');
    setTimeout(() => process.exit(1), 500);
  }
}
