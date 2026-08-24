// Homestead service worker.
//
// Responsibilities:
//  1. Minimal offline-friendly app shell for the installed PWA (network-first).
//  2. Web push handler: receive a push, show a Notification with the payload.
//  3. notificationclick: focus an existing client or open a new tab to payload.url.
//  4. PHA-2205 (PHA-2200.4): precache the new modules.html / modules.js / modules.css
//     so the Add-a-room sheet works on a cold install without an extra round-trip.
//
// Push payload shape (sent by server.js notify()):
//   { title, body, url, tag, icon, badge, category }

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/modules.html',
  '/modules.js',
  '/modules.css',
  '/welcome.html',
  '/icon.svg',
  '/manifest.json',
];

self.addEventListener('install', e => {
  // PHA-2205: precache the v0.3.0 SPA shell assets. cacheFirst only for
  // the static asset list — JSON / API traffic still hits the network
  // unconditionally so we don't serve a stale layout.
  e.waitUntil((async () => {
    const cache = await caches.open('homestead-static-v1');
    try { await cache.addAll(STATIC_ASSETS); } catch (_) { /* individual add failures are non-fatal */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  // Drop any older homestead-static-* caches on activate so a stale
  // modules.js doesn't shadow a freshly deployed bundle.
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('homestead-static-') && k !== 'homestead-static-v1')
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Network-first for everything; fall back to the static cache only
  // for navigation / same-origin GETs that we precached.
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!STATIC_ASSETS.includes(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open('homestead-static-v1');
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw _;
    }
  })());
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
