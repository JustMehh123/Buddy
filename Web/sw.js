/**
 * A deliberately tiny service worker.
 *
 * Buddy is useless without the computer he lives with, so there is no offline
 * mode to speak of. What this buys us is an instant home-screen launch: the
 * shell (HTML, CSS, the face) is cached, so tapping his icon shows his face
 * immediately while the socket to the Mac reconnects behind it.
 *
 * Network-first, always: the page itself must never go stale.
 */

const CACHE = 'buddy-shell-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './face.js',
  './live.js',
  './mic-worklet.js',
  './out-worklet.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './fonts/Fredoka.ttf'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // Never touch anything that talks to the computer — especially the event
  // stream, which has to stay a live connection.
  if (url.pathname.startsWith('/api')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && SHELL.some((entry) => url.pathname.endsWith(entry.replace('./', '')))) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
