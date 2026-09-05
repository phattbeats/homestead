// Homestead — media storage primitive (PHA-2149 / PHA-2147.1) +
// media-comprehension package (PHA-2644).
//
// General-purpose content-addressed media store. Walls (PHA-2147.2),
// entity-graph covers, list-item photos, and Popcorn Vote (PHA-2052)
// all build on this rather than rolling their own upload handling.
//
// PHA-2644 adds the comprehension package: `getMediaContext(id)` returns
// the same shape regardless of kind:
//   * image  → { kind: 'image',  file, thumb,  caption }
//   * video  → { kind: 'video',  frames[8-12], firstFrame, lastFrame,
//                          audioTranscript, audioTranscriptStatus, caption }
// The video frame set is ffmpeg-driven (keyframe extraction at
// scene-change boundaries, capped at 12; first + last always included).
// The audio track is whisper-class ASR via the OpenAI /v1/audio/transcriptions
// endpoint, using the requesting agent's BYOK key by default, with a
// server-staged OPENAI_API_KEY fallback. Results are cached per
// (media_id, source_mtime) so re-extraction only happens when the
// underlying file changes (a re-upload via the same content-addressed
// store will share mtime → cache hit).
//
// Storage layout: DATA_DIR/media/{yyyy-mm}/{sha256-prefix}/{sha256}.{ext},
// thumbs alongside as {sha256}.thumb.jpg. Content-addressed: a byte-
// identical re-upload dedupes to the existing row (same sha256 -> same
// id), even across different owners/months — the path reflects the
// month of the FIRST upload, not each caller's upload time.
//
// Auth: server.js's `auth` middleware runs before every route below;
// `upload`/`fetch`/`remove`/`getMediaContext` trust req.session.user
// is already populated. Phase 1 has no wall/visibility awareness yet
// (that lands in PHA-2147.2) — any authenticated user may fetch any
// media by id, which is fine because ids are random UUIDs, not
// enumerable. Ownership only gates DELETE.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const multer = require('multer');
const sharp = require('sharp');

const analytics = require('./analytics');

const execFileP = promisify(execFile);

// ---- constants (Phase 1: hardcoded here; env override is a later ask) ----
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_DIMENSION = 2048; // downscale images wider/taller than this
const THUMB_WIDTH = 320;
const FRAME_THUMB_WIDTH = 480; // PHA-2644 keyframe width — enough text to read, small enough to cache
const MAX_KEYFRAMES = 12;
const MIN_KEYFRAMES = 3;
const SCENE_CHANGE_THRESHOLD = 0.4; // ffmpeg select=gt(scene,0.4) — tuned for ambient content
const SOFT_DELETE_GRACE_MS = 24 * 60 * 60 * 1000; // 24h before sweep reaps the row
const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h; PHA-2644 cache invalidation rule

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
const CONTEXT_DIR = path.join(DATA_DIR, 'media-context');
const FRAMES_DIR = path.join(DATA_DIR, 'media-frames');

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
      caption         TEXT,
      expires_at      TEXT,
      deleted_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_media_uploads_owner ON media_uploads(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_media_uploads_expires ON media_uploads(expires_at) WHERE expires_at IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_uploads_sha256 ON media_uploads(sha256);
  `);
  // PHA-2644: caption (alt text) is set on the upload and surfaced
  // verbatim by the comprehension package. Added via column-add
  // pattern (lib/user-model.js does the same) so re-running migrate()
  // against an existing v0.4.x DB upgrades in place without a separate
  // version table.
  const cols = db.prepare('PRAGMA table_info(media_uploads)').all().map((c) => c.name);
  if (!cols.includes('caption')) {
    db.exec('ALTER TABLE media_uploads ADD COLUMN caption TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_context_cache (
      media_id        TEXT PRIMARY KEY REFERENCES media_uploads(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      source_mtime    INTEGER NOT NULL,
      built_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
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
    caption: row.caption || null,
    url: toUrl(row.id, false),
    thumbUrl: row.thumb_path || row.kind === 'video' ? toUrl(row.id, true) : null,
    createdAt: row.created_at,
  };
}

// Route handler: POST /api/media (auth already applied by server.js).
//
// PHA-2644: optional multipart text field `caption` (alt text /
// spoken-line transcript fallback / user-supplied description). Stored
// verbatim on the row; surfaced by the comprehension package and
// publicView. No length cap yet — uploads are owner-gated, and an
// editor flow is a future issue.
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

    // multer's `uploadMw.single('file')` doesn't parse non-file fields
    // by default; the `caption` text field comes through on req.body.
    // Trim + cap at 4KB to keep DB rows bounded; longer descriptions
    // belong in a separate caption-edit endpoint (future issue).
    const caption = typeof req.body.caption === 'string'
      ? req.body.caption.trim().slice(0, 4096) || null
      : null;

    try {
      const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

      const existing = _db.prepare('SELECT * FROM media_uploads WHERE sha256 = ? AND deleted_at IS NULL').get(sha256);
      if (existing) {
        // PHA-2644: a re-upload of byte-identical content returns the
        // existing row. If a caption was supplied this time and the
        // existing row has none, persist the new caption. Never
        // overwrite a non-empty existing caption — that would be a
        // silent data loss on a duplicate upload from a different
        // owner (e.g. a friend re-sharing the same image with their
        // own alt text).
        if (caption && !existing.caption) {
          _db.prepare('UPDATE media_uploads SET caption = ? WHERE id = ?').run(caption, existing.id);
          existing.caption = caption;
        }
        return res.json(publicView(existing));
      }

      const ext = MIME_EXT[mime];
      const yyyymm = new Date().toISOString().slice(0, 7);
      const { relDir, rel, relThumb } = shaPaths(sha256, ext, yyyymm);
      fs.mkdirSync(path.join(DATA_DIR, relDir), { recursive: true });

      let width = null, height = null, thumbRel = null, durationMs = null;
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
        // PHA-2644: probe duration + dimensions for video at upload
        // time so the comprehension package can label first/last frame
        // timestamps without re-running ffprobe. Failure here is
        // non-fatal — a missing duration_ms just means the keyframe
        // timestamps can't be displayed; the comprehension package
        // still works.
        try {
          const probed = await probeVideo(path.join(DATA_DIR, rel));
          width = probed.width || null;
          height = probed.height || null;
          durationMs = probed.durationMs || null;
        } catch (probeErr) {
          // ffprobe missing or unreadable input — keep going, the
          // extraction step will re-probe and surface the same error
          // (or succeed) at comprehension time.
          console.warn(`[media] ffprobe failed for ${sha256}: ${probeErr.message}`);
        }
      }

      const id = crypto.randomUUID();
      _db.prepare(`
        INSERT INTO media_uploads (id, owner_user_id, kind, mime, bytes, original_name, width, height, duration_ms, sha256, path, thumb_path, caption)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, owner.id, kind, mime, req.file.size, req.file.originalname || null, width, height, durationMs, sha256, rel, thumbRel, caption);

      const row = _db.prepare('SELECT * FROM media_uploads WHERE id = ?').get(id);

      // PHA-2210: capture media_uploaded with the bytes promoted into a
      // real column (per the schema review). Best-effort, fires after
      // the upload response is built so a failed analytics INSERT never
      // affects the caller.
      analytics.logEvent(_db, {
        userId: owner.id,
        kind: 'media_uploaded',
        subjectType: 'media_upload',
        subjectId: id,
        bytes: req.file.size,
        meta: { kind, mime },
      });

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
  // PHA-2644: drop the comprehension cache + extracted frames so a
  // re-upload (which would create a NEW media_id thanks to the
  // content-addressed store) can't accidentally serve a cached
  // package from the deleted row. Belt-and-suspenders: the cache
  // row's ON DELETE CASCADE also fires.
  _db.prepare('DELETE FROM media_context_cache WHERE media_id = ?').run(id);
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

// =====================================================================
// PHA-2644 — media-comprehension package
// =====================================================================

// ffprobe helper: returns { width, height, durationMs } for a video
// file. Throws on ffprobe missing or unreadable input. Used both at
// upload time (best-effort) and during keyframe extraction (hard
// requirement).
async function probeVideo(absPath) {
  let stdout;
  try {
    ({ stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      absPath,
    ]));
  } catch (e) {
    throw new Error(`ffprobe failed: ${e.message}`);
  }
  const j = JSON.parse(stdout);
  const stream = (j.streams && j.streams[0]) || {};
  const dur = stream.duration || (j.format && j.format.duration) || null;
  return {
    width: stream.width || null,
    height: stream.height || null,
    durationMs: dur ? Math.round(parseFloat(dur) * 1000) : null,
  };
}

// ffmpeg keyframe extraction. Selects frames at scene-change
// boundaries (`select=gt(scene,THR)`) plus the first and last frame,
// caps at MAX_KEYFRAMES, scales to FRAME_THUMB_WIDTH preserving aspect
// ratio. Returns the ordered list of frame metadata:
//   [{ url, index, timestampMs }, ...]
//
// Frames are written under DATA_DIR/media-frames/{media_id}/{idx}.jpg
// and served via GET /api/media-frames/:mediaId/:idx.
async function extractKeyframes(absPath, mediaId) {
  const dir = path.join(FRAMES_DIR, mediaId);
  fs.mkdirSync(dir, { recursive: true });

  // First extract scene-change frames (no scale, raw keyframes; we
  // resize in a second pass so the count is bounded before
  // transcoding). -vsync vfr avoids duplicating timestamps.
  const tmpPattern = path.join(dir, 'scene-%04d.png');
  await execFileP('ffmpeg', [
    '-y',
    '-i', absPath,
    '-vf', `select='gt(scene,${SCENE_CHANGE_THRESHOLD})',showinfo`,
    '-vsync', 'vfr',
    '-frame_pts', '1',
    tmpPattern,
  ], { maxBuffer: 16 * 1024 * 1024 });

  // Read the directory, sort, then take up to MAX_KEYFRAMES.
  let sceneFrames = fs.readdirSync(dir)
    .filter((f) => f.startsWith('scene-') && f.endsWith('.png'))
    .sort();
  if (sceneFrames.length > MAX_KEYFRAMES) {
    // Keep first, last, and an even spread of the rest. The
    // comprehension package consumers care about coverage, not
    // chronological perfection.
    const keep = new Set();
    keep.add(sceneFrames[0]);
    keep.add(sceneFrames[sceneFrames.length - 1]);
    const step = (sceneFrames.length - 1) / (MAX_KEYFRAMES - 1);
    for (let i = 0; i < MAX_KEYFRAMES; i++) {
      keep.add(sceneFrames[Math.round(i * step)]);
    }
    for (const f of sceneFrames) {
      if (!keep.has(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* gone */ }
      }
    }
    sceneFrames = Array.from(keep).sort();
  }
  if (sceneFrames.length < MIN_KEYFRAMES) {
    // Fallback: scene detection didn't find enough cuts. Use uniform
    // sampling across the whole video at 1 fps (1 frame per second)
    // to give the comprehension package a sense of the temporal
    // shape. A 5s video → 5 sample frames; an 8-min video would hit
    // the MAX_KEYFRAMES cap and we'd under-sample the late
    // half, which is acceptable for "vibe" comprehension.
    for (const f of sceneFrames) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* gone */ }
    }
    await execFileP('ffmpeg', [
      '-y',
      '-i', absPath,
      '-vf', `fps=1,scale=${FRAME_THUMB_WIDTH}:-1`,
      '-frames:v', String(MAX_KEYFRAMES),
      path.join(dir, 'sample-%04d.jpg'),
    ], { maxBuffer: 16 * 1024 * 1024 });
    sceneFrames = fs.readdirSync(dir)
      .filter((f) => f.startsWith('sample-') && f.endsWith('.jpg'))
      .sort();
  }

  // Always synthesize first + last if not present.
  const haveFirst = sceneFrames.length > 0;
  const haveLast = sceneFrames.length > 1;
  if (!haveFirst) {
    // Truly empty video — synthesize a single blank frame.
    await execFileP('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180',
      '-frames:v', '1',
      path.join(dir, 'sample-0001.jpg'),
    ]);
    sceneFrames = ['sample-0001.jpg'];
  }

  // Resize all kept frames to FRAME_THUMB_WIDTH as JPGs with stable
  // names. We also probe each frame's presentation timestamp via
  // ffprobe so the comprehension package can label "frame 3 @ 00:42".
  const out = [];
  for (let i = 0; i < sceneFrames.length; i++) {
    const srcName = sceneFrames[i];
    const outName = `frame-${String(i + 1).padStart(3, '0')}.jpg`;
    const srcAbs = path.join(dir, srcName);
    const outAbs = path.join(dir, outName);
    try {
      await execFileP('ffmpeg', [
        '-y',
        '-i', srcAbs,
        '-vf', `scale=${FRAME_THUMB_WIDTH}:-1`,
        outAbs,
      ], { maxBuffer: 8 * 1024 * 1024 });
      if (srcAbs !== outAbs) {
        try { fs.unlinkSync(srcAbs); } catch (_) { /* gone */ }
      }
      let timestampMs = null;
      try {
        const { stdout } = await execFileP('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'frame=best_effort_timestamp_time',
          '-of', 'csv=p=0',
          outAbs,
        ]);
        const t = parseFloat((stdout || '').trim());
        if (Number.isFinite(t)) timestampMs = Math.round(t * 1000);
      } catch (_) { /* leave null */ }
      out.push({
        url: `/api/media-frames/${mediaId}/${outName}`,
        index: i + 1,
        timestampMs,
      });
    } catch (e) {
      // If a single frame fails, skip it rather than failing the
      // whole comprehension — the rest of the package is still
      // useful, and a missing frame is a clearer signal than a 500.
      console.warn(`[media] keyframe ${srcName} for ${mediaId} failed: ${e.message}`);
    }
  }

  // First + last are always referenced by name in the response so
  // the consumer doesn't have to know the array index.
  const firstFrame = out.length > 0 ? out[0].url : null;
  const lastFrame = out.length > 0 ? out[out.length - 1].url : null;
  return { frames: out, firstFrame, lastFrame };
}

// Check whether a video file has an audio stream. Returns true/false.
// Used to short-circuit the audio-extract step for silent videos
// (e.g. a screen recording with no mic) so we don't waste an
// ffmpeg invocation + an OpenAI call.
async function hasAudioStream(absPath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      absPath,
    ]);
    return (stdout || '').trim().length > 0;
  } catch (_) {
    // ffprobe missing or unreadable input — assume audio exists so
    // the extraction step has a chance to surface the real error.
    return true;
  }
}

// Extract the audio track from a video and write it to a temp
// 16-bit mono 16-kHz WAV (whisper's preferred input). Returns the
// absolute path; caller unlinks. Throws on ffmpeg failure.
async function extractAudio(absPath) {
  const tmp = path.join(os.tmpdir(), `media-audio-${crypto.randomUUID()}.wav`);
  await execFileP('ffmpeg', [
    '-y',
    '-i', absPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-acodec', 'pcm_s16le',
    tmp,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return tmp;
}

// Whisper transcription. Accepts the request-scoped BYOK key, falls
// back to OPENAI_API_KEY env. Returns { text, status } where status
// is one of: 'ok' | 'no_key' | 'error' | 'skipped'.
//
//   * 'no_key' — neither BYOK nor env had a key. The comprehension
//     package surfaces audioTranscript: null with this status so the
//     caller can decide whether to retry with a key.
//   * 'error' — the key was set but the API returned non-2xx, or
//     ffmpeg audio extraction failed. Status detail is in the log.
//   * 'skipped' — short silent audio (RMS below threshold) or
//     near-zero duration. Cheap optimization so a still-life video
//     doesn't waste an OpenAI call.
//   * 'ok' — text is the ASR result.
async function transcribeAudio(absAudioPath, { byokKey } = {}) {
  const apiKey = byokKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { text: null, status: 'no_key', detail: 'no whisper key (BYOK or OPENAI_API_KEY)' };
  }

  // Cheap skip: if the audio file is under 2 KB, it's almost
  // certainly silence — ffmpeg's silent-input still produces a
  // header but no PCM data.
  let stat;
  try { stat = fs.statSync(absAudioPath); } catch (e) {
    return { text: null, status: 'error', detail: `audio stat failed: ${e.message}` };
  }
  if (stat.size < 2048) {
    return { text: null, status: 'skipped', detail: 'audio too short, likely silence' };
  }

  // Use Node 22's built-in fetch + FormData. Whisper expects
  // multipart/form-data with the file as `file` and the model as
  // `model`. Default to whisper-1; gpt-4o-transcribe is a future
  // issue (PHA-2644 deliberately keeps whisper-1 for stability).
  const form = new FormData();
  const buf = fs.readFileSync(absAudioPath);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');

  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    return { text: null, status: 'error', detail: `whisper fetch failed: ${e.message}` };
  }
  if (!resp.ok) {
    let detail;
    try { detail = (await resp.text()).slice(0, 200); } catch (_) { detail = ''; }
    return { text: null, status: 'error', detail: `whisper ${resp.status}: ${detail}` };
  }
  let body;
  try { body = await resp.json(); } catch (e) {
    return { text: null, status: 'error', detail: `whisper json parse failed: ${e.message}` };
  }
  return { text: (body && typeof body.text === 'string') ? body.text : '', status: 'ok' };
}

// Core comprehension-package builder. Returns a plain object suitable
// for JSON response. Pulls from the cache when fresh; otherwise
// extracts + transcribes + persists.
//
// `opts.byokKey` — request-scoped OpenAI key for whisper. Pass
// `null` or `''` to force the no-key path. `opts.bustCache` — for
// tests; re-extracts even if the source mtime matches.
async function buildContext(id, opts = {}) {
  const row = _db.prepare('SELECT * FROM media_uploads WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { error: 'not_found', status: 404 };

  const abs = path.join(DATA_DIR, row.path);
  if (!fs.existsSync(abs)) return { error: 'source_missing', status: 410 };

  let sourceMtime;
  try { sourceMtime = Math.round(fs.statSync(abs).mtimeMs); } catch (_) { sourceMtime = 0; }

  // Cache lookup (unless caller asked to bust).
  if (!opts.bustCache) {
    const cached = _db.prepare('SELECT * FROM media_context_cache WHERE media_id = ?').get(id);
    if (cached && Number(cached.source_mtime) === Number(sourceMtime)) {
      try {
        const payload = JSON.parse(cached.payload_json);
        // PHA-2644: refresh `cachedAt` on every serve so consumers can
        // see how stale the cache hit was.
        return { ...payload, cachedAt: cached.built_at, builtAt: cached.built_at, cacheHit: true };
      } catch (_) { /* fall through to rebuild */ }
    }
  }

  let payload;
  if (row.kind === 'image') {
    payload = await buildImageContext(row, abs);
  } else if (row.kind === 'video') {
    payload = await buildVideoContext(row, abs, opts);
  } else {
    return { error: `unsupported_kind:${row.kind}`, status: 400 };
  }

  payload.kind = row.kind;
  payload.mime = row.mime;
  payload.bytes = row.bytes;
  payload.width = row.width;
  payload.height = row.height;
  if (row.kind === 'video' && row.duration_ms != null) payload.durationMs = row.duration_ms;
  payload.caption = row.caption || null;

  // Persist. ON DELETE CASCADE on media_uploads cleans the cache
  // row when the media row is hard-deleted by cleanupSweep.
  _db.prepare(`
    INSERT INTO media_context_cache (media_id, kind, payload_json, source_mtime, built_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_id) DO UPDATE SET
      kind = excluded.kind,
      payload_json = excluded.payload_json,
      source_mtime = excluded.source_mtime,
      built_at = excluded.built_at
  `).run(id, row.kind, JSON.stringify(payload), Math.round(sourceMtime));

  return { ...payload, cachedAt: null, cacheHit: false };
}

async function buildImageContext(row, abs) {
  // No extraction needed — the comprehension package for an image
  // is just the original file + thumbnail + caption. The frame
  // list is empty (an image is one frame).
  return {
    file: `/api/media/${row.id}`,
    thumb: row.thumb_path ? `/api/media/${row.id}/thumb` : `/api/media/${row.id}`,
    frames: [],
  };
}

async function buildVideoContext(row, abs, opts) {
  const extraction = await extractKeyframes(abs, row.id);
  let audioPath = null;
  let transcript = { text: null, status: 'no_key', detail: 'not attempted' };
  try {
    // Short-circuit: if the video has no audio stream at all, skip
    // the extract + whisper call entirely. This is a common case
    // (screen recordings, GIFs-as-MP4, animated thumbnails) and
    // ffmpeg -vn on a no-audio input exits non-zero.
    const hasAudio = await hasAudioStream(abs);
    if (!hasAudio) {
      transcript = { text: null, status: 'skipped', detail: 'video has no audio stream' };
    } else {
      audioPath = await extractAudio(abs);
      transcript = await transcribeAudio(audioPath, { byokKey: opts.byokKey });
    }
  } catch (e) {
    transcript = { text: null, status: 'error', detail: `audio extract failed: ${e.message}` };
  } finally {
    if (audioPath) {
      try { fs.unlinkSync(audioPath); } catch (_) { /* already gone */ }
    }
  }
  return {
    frames: extraction.frames,
    firstFrame: extraction.firstFrame,
    lastFrame: extraction.lastFrame,
    audioTranscript: transcript.text,
    audioTranscriptStatus: transcript.status,
    audioTranscriptDetail: transcript.detail || null,
  };
}

// Route handler: GET /api/media/:id/context (auth already applied by
// server.js). Returns the comprehension package. Per the issue, the
// endpoint honours an explicit BYOK key (header `X-Whisper-Key` or
// query `?byok=...`) for whisper transcription; without a key the
// package is returned with audioTranscript: null and
// audioTranscriptStatus: 'no_key'.
function getMediaContext(req, res) {
  const id = req.params.id;
  // Header takes precedence over query. Both are stripped from logs
  // — never log a BYOK key. The auth middleware has already
  // populated req.session.user; we don't gate on it beyond that.
  const byokKey = (req.get('X-Whisper-Key') || req.query.byok || '').trim() || null;
  buildContext(id, { byokKey }).then((pkg) => {
    if (pkg.error) return res.status(pkg.status || 500).json({ error: pkg.error });
    res.set('Cache-Control', 'private, max-age=60');
    res.json(pkg);
  }).catch((e) => {
    console.error(`[media] getMediaContext ${id} failed:`, e);
    res.status(500).json({ error: 'context_build_failed', detail: e.message });
  });
}

// Cache invalidation: drops a media row's comprehension cache. Used
// by tests + the rare admin "force rebuild" path. Returns the number
// of cache rows dropped (always 0 or 1; cascades don't count).
function bustContextCache(id) {
  const info = _db.prepare('DELETE FROM media_context_cache WHERE media_id = ?').run(id);
  return info.changes;
}

// originalAbsPath(id): absolute path to the source file backing a
// media row, for callers that need raw bytes (PHA-2844's porch
// comprehension vision call) rather than the HTTP-served copy. Null
// for a missing/deleted row — callers should fall back gracefully,
// same tolerance as buildContext's source_missing case.
function originalAbsPath(id) {
  const row = _db.prepare('SELECT path FROM media_uploads WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;
  return path.join(DATA_DIR, row.path);
}

// frameAbsPath(mediaId, frameUrlOrName): absolute path to an extracted
// keyframe file on disk, given either the full `/api/media-frames/...`
// URL a comprehension package hands back or the bare filename.
function frameAbsPath(mediaId, frameUrlOrName) {
  return path.join(FRAMES_DIR, mediaId, path.basename(frameUrlOrName));
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  FRAME_THUMB_WIDTH,
  MAX_KEYFRAMES,
  SCENE_CHANGE_THRESHOLD,
  CONTEXT_CACHE_TTL_MS,
  SOFT_DELETE_GRACE_MS,
  migrate,
  upload,
  fetch: fetchMedia,
  remove,
  cleanupSweep,
  getMediaContext,
  bustContextCache,
  // PHA-2844: the comprehension-package builder, callable directly
  // (not just through the HTTP route) by lib/porch/comprehension.js.
  buildContext,
  originalAbsPath,
  frameAbsPath,
  // Exported for unit tests; not part of the route surface.
  _buildContext: buildContext,
  _probeVideo: probeVideo,
  publicView,
};
