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
