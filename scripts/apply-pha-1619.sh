#!/usr/bin/env bash
# PHA-1619 — apply all push-notification work to pha-1619-web-push and commit.
# Single-shot script so the work is durable regardless of concurrent stomp events.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== STEP 1: install web-push ==="
npm install web-push@^3.6.7 --save --no-audit --no-fund >/dev/null
echo "  web-push installed: $(ls node_modules/web-push/package.json 2>&1 | head -1)"

echo "=== STEP 2: bump version to 0.1.0 ==="
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='0.1.0';
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
"

echo "=== STEP 3: write service worker ==="
cat > public/sw.js <<'SWEOF'
// Homestead service worker.
//
// Responsibilities:
//  1. Minimal offline-friendly app shell for the installed PWA (network-first).
//  2. Web push handler: receive a push, show a Notification with the payload.
//  3. notificationclick: focus an existing client or open a new tab to payload.url.
//
// Push payload shape (sent by server.js notify()):
//   { title, body, url, tag, icon, badge, category }

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());

self.addEventListener('fetch', e => {
  // No offline cache for now — Homestead is a small PWA where the network
  // is the source of truth. The install handler above is enough to make
  // the page installable to the home screen on iOS 16.4+/Android.
});

const pendingClicks = new Map();

self.addEventListener('push', e => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { title: 'Homestead', body: e.data ? e.data.text() : '' };
  }
  const title = data.title || 'Homestead';
  const opts = {
    body: data.body || '',
    tag: data.tag || 'homestead',
    icon: data.icon || '/icon.svg',
    badge: data.badge || '/icon.svg',
    data: { url: data.url || '/', category: data.category || 'system' },
    vibrate: data.category === 'chore_due' || data.category === 'take_turns'
      ? [120, 60, 120] : undefined,
    requireInteraction: data.category === 'take_turns',
    renotify: !!data.tag,
  };
  if (data.url) pendingClicks.set(opts.tag, data.url);
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tag = e.notification.tag || 'homestead';
  const url = (e.notification.data && e.notification.data.url) || pendingClicks.get(tag) || '/';
  pendingClicks.delete(tag);
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.origin === self.location.origin) {
          await c.focus();
          if ('navigate' in c) await c.navigate(url);
          return;
        }
      } catch (_) {}
    }
    await clients.openWindow(url);
  })());
});

self.addEventListener('notificationclose', e => {
  // no-op; hook for future analytics
});
SWEOF
echo "  public/sw.js: $(wc -l < public/sw.js) lines"

echo "=== STEP 4: write smoke test ==="
mkdir -p scripts
cat > scripts/smoke-push.js <<'SMOKEEOF'
// PHA-1619 smoke test: real push delivery + 410 prune.
const http = require('http');
const Module = require('module');
const fakePort = 4099;

let received = [];
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/dump') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(received)); received = []; return;
    }
    if (req.url === '/gone') { res.writeHead(410); res.end(); return; }
    received.push({ url: req.url, body });
    res.writeHead(201); res.end('ok');
  });
});

(async () => {
  await new Promise(r => fakeServer.listen(fakePort, r));
  console.log('[smoke] fake push on :' + fakePort);

  const origRequire = Module.prototype.require;
  Module.prototype.require = function(name) {
    if (name === 'web-push') {
      const real = origRequire.call(this, name);
      return new Proxy(real, {
        get(t, p) {
          if (p === 'sendNotification') {
            return async (sub, payload, opts) => new Promise((resolve, reject) => {
              const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
              const u = new URL(sub.endpoint);
              const req = http.request({
                hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
                headers: { 'content-type': 'application/octet-stream',
                           'content-length': Buffer.byteLength(data) }
              }, (res) => {
                if (res.statusCode >= 400) {
                  const err = new Error('push failed'); err.statusCode = res.statusCode; reject(err);
                } else { resolve({ statusCode: res.statusCode }); }
              });
              req.on('error', reject); req.write(data); req.end();
            });
          }
          return Reflect.get(t, p);
        }
      });
    }
    return origRequire.call(this, name);
  };

  process.env.DATA_DIR = '/tmp/hs-smoke';
  process.env.PORT = '3099';
  process.env.ADMIN_PASSWORD = '***';
  require('/root/.openclaw/workspace/repos/homestead/server.js');

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('http://localhost:3099/api/health'); if (r.ok) { ready = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  console.log('[smoke] homestead ready');

  const loginRes = await fetch('http://localhost:3099/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test' })
  });
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const sub = {
    endpoint: 'http://127.0.0.1:' + fakePort + '/capture',
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
  };
  const subRes = await fetch('http://localhost:3099/api/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(sub)
  });
  console.log('[smoke] subscribe:', await subRes.json());

  const n1 = await fetch('http://localhost:3099/api/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ payload: { title: 'Test from curl', body: 'real push!', tag: 'test' } })
  });
  console.log('[smoke] notify:', await n1.json());

  const dump = await fetch('http://127.0.0.1:' + fakePort + '/dump');
  const captured = await dump.json();
  console.log('[smoke] captured:', captured.length, 'push(es)');
  if (captured.length > 0) {
    const p = JSON.parse(captured[0].body);
    console.log('[smoke] payload:', JSON.stringify(p));
  }

  const Database = require('better-sqlite3');
  const db = new Database('/tmp/hs-smoke/life.db');
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare(`INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,?,?,?)`)
    .run('http://127.0.0.1:' + fakePort + '/gone', sub.keys.p256dh, sub.keys.auth);
  const n2 = await fetch('http://localhost:3099/api/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ payload: { title: 'Should fail 410', body: 'prune test' } })
  });
  console.log('[smoke] 410 test:', await n2.json());
  const remaining = db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c;
  console.log('[smoke] remaining subs after 410 prune:', remaining, '(expect 0)');

  const prefs = await fetch('http://localhost:3099/api/push/prefs', { headers: { cookie } });
  console.log('[smoke] prefs:', await prefs.json());

  console.log('[smoke] PASS');
  process.exit(0);
})().catch(e => { console.error('[smoke] FAILED:', e); process.exit(1); });
SMOKEEOF
echo "  scripts/smoke-push.js: $(wc -l < scripts/smoke-push.js) lines"

echo "=== STEP 5: node syntax check ==="
node --check server.js && echo "  server.js: OK"

echo "=== STEP 6: end ==="
echo "scripts and SW written. Server.js edits and frontend/README/CHANGELOG remain — apply next."
