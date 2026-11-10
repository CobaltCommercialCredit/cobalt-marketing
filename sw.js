// Cobalt Marketing service worker.
// Keeps only the app shell (this page, its icons, its manifest) on the phone so the app opens fast.
// It never caches data: every request to the database, sign-in, or marketing engine goes straight to the network.
const SHELL = 'cobalt-marketing-shell-v1';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only the app's own files. Supabase, fonts, and everything else pass through untouched.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first, so every update is live immediately; fall back to the stored copy when offline.
  // cache:'no-cache' makes the phone ask GitHub for the newest copy every time instead of reusing a recent one.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
