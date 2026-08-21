// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — donation surface (PHA-2223).
//
// Standing rules (from Brandon's policy, recorded on PHA-2223):
//   - Money stays potential. Nothing is collected as a condition of access.
//   - One quiet, findable link. No notification, no agent solicitation, no
//     interruption. Not on the wall, not in the meadow, not in the Gazette,
//     not in onboarding. Only the avatar-menu About sheet and the repo
//     README, by design.
//   - No payment handling in Homestead. No card data, no webhooks, no
//     financial records in life.db. Homestead links out and knows nothing.
//   - No analytics on donation clicks beyond a plain count, and never
//     attributed to a user. We don't build the ability to know who gave.
//
// Implementation choices that make those rules enforceable in code:
//
//   1. The link itself is a config value, not a hardcoded constant.
//      `process.env.DONATION_URL` (must be a fully-qualified https:// URL,
//      validated at boot so a typo can't become a phishing redirect). When
//      the env var is unset, the API returns 404 and the UI surfaces a
//      "donation surface not configured" message — the surface exists,
//      the link doesn't, and Homestead keeps its hands entirely clean.
//      `process.env.DONATION_LABEL` (optional, defaults to
//      "Support Homestead") controls the visible link text.
//
//   2. The click counter does NOT have a user_id, IP, user-agent, or
//      referer column. We literally cannot answer "who clicked?" from
//      this table — by schema, not by promises. The only column is
//      `day` (UTC date, YYYY-MM-DD) so we can answer "how many clicks
//      today / this month?" without ever identifying any human.
//
//   3. The click endpoint is unauthenticated public, like /api/health
//      and /api/version. We don't need to know who's clicking to count
//      clicks. There's no auth context to log, even by accident.
//
//   4. The link opens in `window.open(url, '_blank', 'noopener,noreferrer')`
//      from the client. The provider site (Ko-fi, GitHub Sponsors, etc.)
//      is a separate origin; Homestead can't read its cookies and the
//      reverse-link can't read Homestead's. The two surfaces are
//      intentionally decoupled.

'use strict';

const DEFAULT_LABEL = 'Support Homestead';

// https://, http://, or mailto: — anything else is rejected so a
// misconfigured env var can't become a phishing redirect. We don't
// allow javascript: or data: URLs.
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

let _db = null;
let _cachedLink = null; // memoized { url, label } or null

function migrate(db) {
  _db = db;
  // donation_clicks: a single integer counter is enough. We store one
  // row per day the link was clicked so /api/donation-clicks (operators
  // only) can answer "how many clicks today / this month?" without
  // any way to identify who clicked. There's no user_id, no IP, no
  // user-agent, no referer, no timestamp-precision column — by schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS donation_clicks (
      id INTEGER PRIMARY KEY,
      day TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_donation_clicks_day ON donation_clicks(day);
  `);
}

function _validateUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  // For http(s), require a hostname so `https:` alone can't pass.
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    if (!parsed.hostname) return null;
  }
  return trimmed;
}

function _envLink() {
  if (_cachedLink !== null) return _cachedLink;
  const url = _validateUrl(process.env.DONATION_URL);
  if (!url) {
    _cachedLink = null;
    return null;
  }
  const labelRaw = (process.env.DONATION_LABEL || DEFAULT_LABEL).trim();
  // Visible label is short on purpose — it's a single quiet link, not a
  // promotional banner. Cap at 80 chars so a wonky env var can't blow
  // up the avatar-menu sheet layout.
  const label = (labelRaw || DEFAULT_LABEL).slice(0, 80);
  _cachedLink = { url, label };
  return _cachedLink;
}

// For tests: drop the memoized cache so a server boot with new env
// re-reads. Not exported in the production path.
function _resetCache() {
  _cachedLink = null;
}

function getLink() {
  return _envLink();
}

function getStatus() {
  const link = _envLink();
  return {
    configured: !!link,
    url: link ? link.url : null,
    label: link ? link.label : null,
  };
}

function _utcDay() {
  // Date-only stamp, no time, no timezone precision. Stored as TEXT
  // so it sorts lexically and reads well in `psql`-style inspection.
  return new Date().toISOString().slice(0, 10);
}

function recordClick() {
  if (!_db) return { ok: false, error: 'no_db' };
  // Error-path doesn't bubble: this is a fire-and-forget counter. If
  // the table is misconfigured we don't want to 500 the click handler.
  try {
    _db.prepare('INSERT INTO donation_clicks (day) VALUES (?)').run(_utcDay());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'insert_failed' };
  }
}

function getStats() {
  if (!_db) return { ok: false, error: 'no_db' };
  try {
    const rows = _db.prepare(
      `SELECT day, COUNT(*) AS n FROM donation_clicks GROUP BY day ORDER BY day DESC`
    ).all();
    const total = _db.prepare(`SELECT COUNT(*) AS n FROM donation_clicks`).get().n;
    return { ok: true, total, byDay: rows };
  } catch (e) {
    return { ok: false, error: 'query_failed' };
  }
}

module.exports = {
  migrate,
  getLink,
  getStatus,
  recordClick,
  getStats,
  // exported for tests only
  _validateUrl,
  _resetCache,
  DEFAULT_LABEL,
};
