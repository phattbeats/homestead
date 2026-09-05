// Homestead service worker.
//
// Responsibilities:
//  1. Minimal offline-friendly app shell for the installed PWA (network-first).
//  2. Web push handler: receive a push, show a Notification with the payload.
//  3. notificationclick: focus an existing client or open a new tab to payload.url.
//
// Push payload shape (sent by server.js notify()):
//   { title, body, url, tag, icon, badge, category }

// PHA-2200.5 / PHA-2206: minimal precache. The feed component file
// is shared between /porch.html and the in-place #page-wall mount
// inside /index.html — both placements need it to render the wall.
// Without precaching, a returning PWA user with intermittent
// connectivity would see an empty Porch. Cache-first for these URLs.
//
// PHA-2846 / v0.5.10: cache bumped to homestead-v6 to ship the
// bottom-nav icon migration (the six emoji tabs now reference the
// matching built-in module SVGs) plus the new /favicon-32.png
// alternate-icon fallback for browsers that ask /favicon.ico before
// /favicon.svg. The old homestead-v5 cache is dropped on activate so
// the emoji tab labels don't persist offline for a returning PWA
// user. PHA-2846 v0.5.9 shipped the v5 cache for the original
// opening-door repair; v0.5.10 layers the bottom-nav onto the same
// canonical asset set without re-shipping the icons themselves (they
// are already in v5). New asset: /favicon-32.png (32x32 PNG).
const PRECACHE_URLS = [
  '/components/feed.js',
  '/porch.css',
  '/brand.css',
  '/fonts/fraunces-italic-400-latin.woff2',
  '/fonts/plus-jakarta-sans-latin.woff2',
  // Canonical opening-door mark (PHA-2846)
  '/icon.svg',
  '/favicon.svg',
  '/favicon-32.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.svg',
  '/icon-maskable-512.png',
  // Six built-in module SVG marks (PHA-2846)
  '/modules/porch.svg',
  '/modules/lists.svg',
  '/modules/calendar.svg',
  '/modules/chores.svg',
  '/modules/apps.svg',
  '/modules/agent.svg',
  // Brand hero / wordmark (unchanged from v4)
  '/brand-hero.png',
  '/wordmark.svg',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open('homestead-v6');
    // Best-effort precache: a 404 here doesn't fail the install — the
    // service worker still activates and network-first falls through.
    try { await cache.addAll(PRECACHE_URLS); } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Drop old caches on activation. PHA-2846 / v0.5.10: homestead-v5
    // is now stale (its /sw.js reference predates the bottom-nav
    // migration; the emoji tab bar would persist offline). v4 (the
    // closed-arch icons) is two-generations stale.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== 'homestead-v6').map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  // Cache-first for the precache list, network-first for everything else.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // ignore cross-origin
  if (PRECACHE_URLS.indexOf(url.pathname) === -1) return;
  e.respondWith((async () => {
    const cache = await caches.open('homestead-v6');
    const hit = await cache.match(url.pathname);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    } catch (_) {
      // Offline + not in cache: return a minimal 503-ish stub so the
      // browser's JS error is informative rather than opaque.
      return new Response('/* offline: component not in cache */', {
        status: 503, headers: { 'Content-Type': 'application/javascript' },
      });
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
  // PHA-2218: a push-tap should clear its own badge — mark this notification's
  // tag seen server-side. Additive to the focus/open-tab flow above; best-effort
  // (a failure here shouldn't block or affect navigation, which already ran via
  // the waitUntil() above).
  e.waitUntil(
    fetch('/api/me/notifications/seen', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
    }).catch(() => {})
  );
});

self.addEventListener('notificationclose', e => {
  // no-op; hook for future analytics
});
