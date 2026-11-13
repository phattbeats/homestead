// Arcade delete/export hooks (PHA-4102).
//
// The arcade service (arcade.phatt.vip) erases a member by calling every
// registered surface: GET /hooks/export?sub=<uuid> and POST /hooks/forget
// {sub}. Requests carry X-Arcade-Kid / X-Arcade-Ts / X-Arcade-Sig where
//   Sig = base64url(HMAC-SHA256(secret[kid], ts + "." + data))
// and data is the raw body (POST) or the query string `sub=<uuid>` (GET).
// `sub` is the Authentik user uuid, the same subject Link PHATT ID writes
// into identity_links (provider 'authentik').
//
// Forget semantics (Homestead is a shared household app, so a member's
// tasks/posts stay with the household):
//   * every identity_links row for the subject is removed, and
//     users.auth_provider/provider_subject are cleared where they name it;
//   * a password-less PHATT ID stand-in user (auth_provider 'phatt_id', no
//     local credential, no remaining link) is anonymised: username
//     `former-<id>`, display "Former member", no avatar, no preferences,
//     and its push subscriptions are dropped. It can no longer sign in;
//   * a real Homestead account (has a password or another link) is only
//     unlinked: the household account is not the arcade's to delete.
// Unknown subjects succeed (idempotent).
//
// Config: ARCADE_HOOK_SECRETS='{"k1":"<secret>"}'. Unset -> routes answer 503.

'use strict';

const crypto = require('crypto');
const express = require('express');

const UUIDish = /^[A-Za-z0-9-]{8,64}$/;

function secrets(env = process.env) {
  try { const s = JSON.parse(env.ARCADE_HOOK_SECRETS || '{}'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}

function sign(secret, ts, data) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${data}`).digest('base64url');
}

function verify(req, data, env = process.env, now = Date.now()) {
  const all = secrets(env);
  if (!Object.keys(all).length) return 'unconfigured';
  const kid = req.get('x-arcade-kid'), ts = req.get('x-arcade-ts'), sig = req.get('x-arcade-sig');
  const secret = kid && Object.prototype.hasOwnProperty.call(all, kid) ? all[kid] : null;
  if (!secret || !ts || !sig) return 'bad_signature';
  if (!(Math.abs(now - Number(ts) * 1000) <= 5 * 60_000)) return 'stale_timestamp';
  const want = Buffer.from(sign(secret, ts, data)), got = Buffer.from(String(sig));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return 'bad_signature';
  return null;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function usersFor(db, sub) {
  const ids = new Set();
  for (const r of db.prepare("SELECT DISTINCT user_id FROM identity_links WHERE provider='authentik' AND provider_subject=?").all(sub)) ids.add(r.user_id);
  for (const r of db.prepare("SELECT id FROM users WHERE provider_subject=? AND auth_provider IN ('authentik','phatt_id')").all(sub)) ids.add(r.id);
  return [...ids];
}

function exportSubject(db, sub) {
  const users = usersFor(db, sub).map((id) => {
    const u = db.prepare('SELECT id, username, display, avatar_url, auth_provider, created_at, last_seen_at FROM users WHERE id=?').get(id);
    if (!u) return null;
    u.links = db.prepare('SELECT provider, issuer, provider_subject, linked_at, last_used_at FROM identity_links WHERE user_id=?').all(id);
    return u;
  }).filter(Boolean);
  return { surface: 'homestead', sub, users };
}

function forgetSubject(db, sub) {
  const out = { unlinked: 0, anonymised: 0 };
  db.transaction(() => {
    for (const id of usersFor(db, sub)) {
      out.unlinked += db.prepare("DELETE FROM identity_links WHERE user_id=? AND provider='authentik' AND provider_subject=?").run(id, sub).changes;
      const u = db.prepare('SELECT auth_provider, pass_hash FROM users WHERE id=?').get(id);
      if (!u) continue;
      db.prepare("UPDATE users SET auth_provider=NULL, provider_subject=NULL, updated_at=datetime('now') WHERE id=? AND provider_subject=?").run(id, sub);
      const links = db.prepare('SELECT COUNT(*) c FROM identity_links WHERE user_id=?').get(id).c;
      const cred = hasTable(db, 'local_credentials') && db.prepare('SELECT 1 FROM local_credentials WHERE user_id=? AND password_hash IS NOT NULL').get(id);
      if (u.auth_provider === 'phatt_id' && !u.pass_hash && !cred && !links) {
        db.prepare("UPDATE users SET username=?, display='Former member', avatar_url=NULL, preferences='{}', updated_at=datetime('now') WHERE id=?").run(`former-${id}`, id);
        if (hasTable(db, 'push_subscriptions')) db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(id);
        out.anonymised++;
      }
    }
  })();
  return out;
}

function router({ db, env = process.env }) {
  const r = express.Router();
  const deny = (res, why) => res.status(why === 'unconfigured' ? 503 : 401).json({ error: why });
  r.get('/export', (req, res) => {
    const sub = String(req.query.sub || '');
    const why = verify(req, `sub=${sub}`, env); if (why) return deny(res, why);
    if (!UUIDish.test(sub)) return res.status(400).json({ error: 'bad_sub' });
    res.json(exportSubject(db, sub));
  });
  r.post('/forget', (req, res) => {
    const why = verify(req, req.rawBody || '', env); if (why) return deny(res, why);
    const sub = String((req.body && req.body.sub) || '');
    if (!UUIDish.test(sub)) return res.status(400).json({ error: 'bad_sub' });
    const out = forgetSubject(db, sub);
    console.log(`[arcade-hooks] forget: unlinked ${out.unlinked}, anonymised ${out.anonymised}`);
    res.json({ ok: true, ...out });
  });
  return r;
}

module.exports = { router, sign, verify, exportSubject, forgetSubject };
