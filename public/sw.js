// Minimal service worker: network-first, enough for PWA install. No offline caching of API.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => {});
