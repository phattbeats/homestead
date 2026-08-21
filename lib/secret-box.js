// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — at-rest encryption for calendar provider credentials.
//
// PHA-1620: "No provider credentials ever reach the browser."
// CalDAV app-passwords and Graph/Google OAuth refresh tokens are stored
// as AES-256-GCM ciphertexts keyed on process.env.CALENDAR_CRED_KEY
// (32 bytes, hex). The same key is required for decrypt, so rotating
// it requires a re-encryption pass over the calendar_sources table —
// that's a known operational footgun, documented in the issue.
//
// Format on disk: <iv_b64>:<tag_b64>:<ciphertext_b64>, all standard
// base64, separated by ':'. We keep the format trivially parseable so
// a future rotation helper can re-encrypt in place without changing
// the on-disk layout.
//
// Fail-closed: if CALENDAR_CRED_KEY is missing or the wrong length, any
// encrypt/decrypt call throws. There is no "auto-generate and persist"
// path on purpose — we'd rather refuse to start than silently ship
// unencrypted credentials.

'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;       // GCM standard
const TAG_BYTES = 16;
const KEY_BYTES = 32;      // AES-256

function loadKey() {
  const hex = process.env.CALENDAR_CRED_KEY;
  if (!hex) {
    throw new Error(
      'CALENDAR_CRED_KEY is not set. Homestead refuses to encrypt or ' +
      'decrypt calendar credentials without a 32-byte hex key. Generate one ' +
      'with: `openssl rand -hex 32` and inject it via your secret manager.'
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `CALENDAR_CRED_KEY must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes). ` +
      `Got ${hex.length} characters.`
    );
  }
  return Buffer.from(hex, 'hex');
}

// encryptString(plaintext) -> string in <iv>:<tag>:<ciphertext> base64 form.
function encryptString(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptString expects a string');
  }
  const key = loadKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error('unexpected GCM tag length: ' + tag.length);
  }
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

// decryptString(stored) -> plaintext string.
// Throws on any tampering (GCM auth tag mismatch) or malformed input.
function decryptString(stored) {
  // Fail-closed: check the key BEFORE we look at the stored value so
  // a missing env var surfaces as the actual cause, not a "bad IV
  // length" downstream noise.
  const key = loadKey();
  if (typeof stored !== 'string' || !stored.includes(':')) {
    throw new Error('decryptString: stored value is not in <iv>:<tag>:<ciphertext> form');
  }
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptString: expected exactly 3 colon-separated parts');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('decryptString: bad IV length');
  if (tag.length !== TAG_BYTES) throw new Error('decryptString: bad tag length');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// keyReady() is a startup-time probe so server boot can fail loudly if
// the env var is missing. Called from server.js before opening the
// calendar-sources routes — those routes are useless without a key.
function keyReady() {
  try { loadKey(); return true; } catch (_) { return false; }
}

module.exports = { encryptString, decryptString, keyReady, KEY_BYTES, IV_BYTES, TAG_BYTES };
