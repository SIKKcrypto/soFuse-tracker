const cachePrefix = 'sofuse-tracker-shell-';
const cacheName = cachePrefix + 'v1';
const shellPaths = ['/', '/style.css', '/dashboard.js', '/pwa.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shellPaths)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName).map(key => caches.delete(key))
  )));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // The only fallback for a wallet-specific URL is the same public app shell.
  const isDashboardPage = request.mode === 'navigate' && url.pathname === '/';
  if (!isDashboardPage && (url.search || !shellPaths.includes(url.pathname))) return;

  event.respondWith(fetch(request).catch(async () =>
    await caches.match(url.pathname, { cacheName }) ?? Response.error()
  ));
});
