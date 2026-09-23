/* Offline shell. Bump VERSION on every release so phones pick up new code. */
const VERSION = 'ranch-v2';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/calc.js', './js/db.js', './js/model.js', './js/schema.js', './js/ui.js', './js/photos.js', './js/sample.js',
  './js/pages/grazing.js', './js/pages/wildlife.js', './js/pages/land.js', './js/pages/compliance.js', './js/pages/money.js', './js/pages/ops.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Network first when there is signal (so updates land), cache when there isn't.
   One bar of LTE can hang for a minute, so give the network 4 s then fall back. */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    withTimeout(fetch(req), 4000).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});
