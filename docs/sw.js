self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (e) => {
  // pass-through network fetch - always get fresh status.json
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
