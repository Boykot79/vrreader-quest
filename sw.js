/* VRReader service worker — caches the app shell for offline use.
   Bump CACHE_VERSION on every change to the app shell so clients refresh. */
const CACHE_VERSION = 'vrreader-v3';
const APP_SHELL = [
  './',
  './vr-reader.html',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

/* The reader libraries load from CDN via <script> tags, which the browser
   fetches during initial parse — BEFORE this worker controls the page. If we
   waited for the fetch handler to cache them, a later offline launch would
   fail to load epub.js/JSZip. So we PRECACHE them on install (CORS fetch;
   jsdelivr & cdnjs both send Access-Control-Allow-Origin). These URLs must
   match the ones in vr-reader.html exactly. */
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // tolerate individual misses (e.g. opened via file://) so install never fails
      Promise.allSettled([
        ...APP_SHELL.map((url) => cache.add(url)),
        ...CDN_ASSETS.map((url) => cache.add(new Request(url, { mode: 'cors' })))
      ])
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // The HTML document is NETWORK-FIRST: always fetch the freshest app when
    // online (so new features/fixes appear immediately), and fall back to the
    // cached copy only when offline. This prevents a stale cached app shell
    // from hiding deployed updates.
    const isDoc = req.mode === 'navigate' ||
      url.pathname.endsWith('.html') || url.pathname.endsWith('/');
    if (isDoc) {
      event.respondWith(
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() =>
          caches.match(req).then((c) => c || caches.match('./vr-reader.html'))
        )
      );
      return;
    }
    // Other same-origin assets (icons, manifest): cache-first for speed.
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Cross-origin (fonts / CDN libs): stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
