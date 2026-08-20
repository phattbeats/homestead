// Homestead — media storage primitive (PHA-2149 / PHA-2147.1).
//
// General-purpose content-addressed media store. Walls (PHA-2147.2),
// entity-graph covers, list-item photos, and Popcorn Vote (PHA-2052)
// all build on this rather than rolling their own upload handling.
//
// Storage layout: DATA_DIR/media/{yyyy-mm}/{sha256-prefix}/{sha256}.{ext},
// thumbs alongside as {sha256}.thumb.jpg. Content-addressed: a byte-
// identical re-upload dedupes to the existing row (same sha256 -> same
// id), even across different owners/months — the path reflects the
// month of the FIRST upload, not each caller's upload time.
//
// Auth: server.js's `auth` middleware runs before every route below;
// `upload`/`fetch`/`remove` trust req.session.user is already populated.
// Phase 1 has no wall/visibility awareness yet (that lands in
// PHA-2147.2) — any authenticated user may fetch any media by id, which
// is fine because ids are random UUIDs, not enumerable. Ownership only
// gates DELETE.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');

// ---- constants (Phase 1: hardcoded here; env override is a later ask) ----
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_DIMENSION = 2048; // downscale images wider/taller than this
const THUMB_WIDTH = 320;
const SOFT_DELETE_GRACE_MS = 24 * 60 * 60 * 1000; // 24h before sweep reaps the row

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

let _db = null;

function migrate(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_uploads (
      id              TEXT PRIMARY KEY,
      owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK(kind IN ('image','video')),
      mime            TEXT NOT NULL,
      bytes           INTEGER NOT NULL,
      original_name   TEXT,
      width           INTEGER,
      height          INTEGER,
      duration_ms     INTEGER,
      sha256          TEXT NOT NULL,
      path            TEXT NOT NULL,
      thumb_path      TEXT,
      poster_path     TEXT,
      expires_at      TEXT,
      deleted_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_media_uploads_owner ON media_uploads(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_media_uploads_expires ON media_uploads(expires_at) WHERE expires_at IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_uploads_sha256 ON media_uploads(sha256);
  `);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
}).single('file');

function kindForMime(mime) {
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (VIDEO_MIMES.has(mime)) return 'video';
  return null;
}

function shaPaths(sha256, ext, yyyymm) {
  const prefix = sha256.slice(0, 2);
  const relDir = path.join('media', yyyymm, prefix);
  const rel = path.join(relDir, `${sha256}.${ext}`);
  const relThumb = path.join(relDir, `${sha256}.thumb.jpg`);
  return { relDir, rel, relThumb };
}

function toUrl(id, thumb) {
  return thumb ? `/api/media/${id}/thumb` : `/api/media/${id}`;
}

function publicView(row) {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    url: toUrl(row.id, false),
    thumbUrl: row.thumb_path || row.kind === 'video' ? toUrl(row.id, true) : null,
    createdAt: row.created_at,
  };
}

// Route handler: POST /api/media (auth already applied by server.js).
function upload(req, res) {
  uploadMw(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large' });
      return res.status(400).json({ error: err.message || 'upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });

    const owner = _db.prepare('SELECT id FROM users WHERE username = ?').get(req.session.user.username);
    if (!owner) return res.status(401).json({ error: 'unknown_user' });

    const mime = req.file.mimetype;
    const kind = kindForMime(mime);
    if (!kind) return res.status(400).json({ error: `unsupported mime: ${mime}` });

    const cap = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (req.file.size > cap) return res.status(413).json({ error: 'file too large' });

    try {
      const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

      const existing = _db.prepare('SELECT * FROM media_uploads WHERE sha256 = ? AND deleted_at IS NULL').get(sha256);
      if (existing) return res.json(publicView(existing));

      const ext = MIME_EXT[mime];
      const yyyymm = new Date().toISOString().slice(0, 7);
      const { relDir, rel, relThumb } = shaPaths(sha256, ext, yyyymm);
      fs.mkdirSync(path.join(DATA_DIR, relDir), { recursive: true });

      let width = null, height = null, thumbRel = null;
      if (kind === 'image') {
        const img = sharp(req.file.buffer, { failOn: 'none' });
        const meta = await img.metadata();
        const resized = img.resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        });
        const { data: outBuf, info } = await resized.toBuffer({ resolveWithObject: true });
        fs.writeFileSync(path.join(DATA_DIR, rel), outBuf);
        width = info.width;
        height = info.height;

        const thumbBuf = await sharp(req.file.buffer, { failOn: 'none' })
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .jpeg()
          .toBuffer();
        fs.writeFileSync(path.join(DATA_DIR, relThumb), thumbBuf);
        thumbRel = relThumb;
        void meta;
      } else {
        fs.writeFileSync(path.join(DATA_DIR, rel), req.file.buffer);
      }

      const id = crypto.randomUUID();
      _db.prepare(`
        INSERT INTO media_uploads (id, owner_user_id, kind, mime, bytes, original_name, width, height, sha256, path, thumb_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, owner.id, kind, mime, req.file.size, req.file.originalname || null, width, height, sha256, rel, thumbRel);

      const row = _db.prepare('SELECT * FROM media_uploads WHERE id = ?').get(id);
      res.json(publicView(row));
    } catch (e) {
      res.status(500).json({ error: 'upload processing failed', detail: e.message });
    }
  });
}

// Route handler helper: GET /api/media/:id (thumb=false) and
// GET /api/media/:id/thumb (thumb=true). Both routes carry `auth`;
// Phase 1 has no per-media visibility check beyond "authenticated".
function fetchMedia(id, res, thumb) {
  const row = _db.prepare('SELECT * FROM media_uploads WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  let rel = row.path;
  if (thumb) {
    rel = row.thumb_path || row.path; // video: no separate thumb yet, serve original
  }
  const abs = path.join(DATA_DIR, rel);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });

  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(abs);
}

// remove(id, callerId): owner or admin only. Soft-delete now; sweep
// reaps the file + row after SOFT_DELETE_GRACE_MS so dependents
// (wall posts referencing media_id) don't 404 mid-transition.
function remove(id, callerId) {
  const row = _db.prepare('SELECT * FROM media_uploads WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { error: 'not_found' };

  const caller = _db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(callerId);
  if (!caller) return { error: 'not_found' };
  if (row.owner_user_id !== caller.id && !caller.is_admin) return { error: 'forbidden' };

  _db.prepare("UPDATE media_uploads SET deleted_at = datetime('now') WHERE id = ?").run(id);
  return { ok: true };
}

// cleanupSweep(db, opts): piggybacks on the existing scheduler tick.
// Reaps (a) soft-deleted rows past their grace window and (b) rows
// past `expires_at` retention, unlinking files as it goes.
function cleanupSweep(db, opts = {}) {
  const graceMs = opts.graceMs != null ? opts.graceMs : SOFT_DELETE_GRACE_MS;
  const graceCutoff = new Date(Date.now() - graceMs).toISOString().replace('T', ' ').slice(0, 19);

  const toReap = db.prepare(`
    SELECT * FROM media_uploads
    WHERE (deleted_at IS NOT NULL AND deleted_at <= ?)
       OR (expires_at IS NOT NULL AND expires_at <= datetime('now'))
  `).all(graceCutoff);

  let reaped = 0;
  for (const row of toReap) {
    for (const rel of [row.path, row.thumb_path, row.poster_path]) {
      if (!rel) continue;
      const abs = path.join(DATA_DIR, rel);
      try { fs.unlinkSync(abs); } catch (_) { /* already gone */ }
    }
    db.prepare('DELETE FROM media_uploads WHERE id = ?').run(row.id);
    reaped++;
  }
  return { reaped };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  SOFT_DELETE_GRACE_MS,
  migrate,
  upload,
  fetch: fetchMedia,
  remove,
  cleanupSweep,
  publicView,
};
