/* Offline shell. Bump VERSION on every release so phones pick up new code. */
const VERSION = 'ranch-v13';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest', './icons/icon.svg', './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css', './js/geo.js', './js/mapcore.js', './js/mappick.js', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/version.js', './js/calc.js', './js/db.js', './js/model.js', './js/schema.js', './js/ui.js', './js/photos.js', './js/relay.js', './js/sample.js',
  './js/pages/grazing.js', './js/pages/wildlife.js', './js/pages/land.js', './js/pages/compliance.js', './js/pages/money.js', './js/pages/ops.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

/* Map tiles: cache-first and kept across app versions, so any part of the map
   you've looked at with signal still shows at the ranch without it. */
const TILES = 'ranch-tiles';
const TILE_HOSTS = ['server.arcgisonline.com', 'basemap.nationalmap.gov', 'tile.openstreetmap.org'];
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !TILE_HOSTS.includes(url.hostname)) return;
  e.respondWith(caches.open(TILES).then(async (c) => {
    const hit = await c.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
    return res;
  }));
});
/* Network first when there is signal (so updates land), cache when there isn't.
   'no-cache' makes the browser re-check with GitHub Pages instead of reusing
   its own 10-minute HTTP cache, so a new version shows up on the next open.
   One bar of LTE can hang for a minute, so give the network 4 s then fall back. */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    withTimeout(fetch(req, { cache: 'no-cache' }), 4000).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});
