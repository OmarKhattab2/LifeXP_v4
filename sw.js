// sw.js
// NOTE: the service worker only manages the *app-shell cache*. It never reads, writes or clears
// localStorage / IndexedDB, so user progress is untouched by service-worker updates.
const CACHE_PREFIX = 'lifexp-pwa-';
const CACHE_NAME = CACHE_PREFIX + 'v3';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.webmanifest',
    './assets/logo.svg',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/icon-maskable.png',
    './assets/apple-touch-icon.png',
    './assets/avatar.jpg'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // add each file on its own so one failing file cannot prevent the rest from being cached
            return Promise.all(ASSETS_TO_CACHE.map((url) =>
                cache.add(url).catch(err => console.warn('Cache skipped:', url, err))
            ));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                // only remove OLD caches of this app, never caches that belong to something else on the same origin
                if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) return caches.delete(key);
            }));
        })
    );
    e.waitUntil(clients.claim());
});

// Cache-first for speed/offline, with a background refresh so updates reach the next launch.
self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;

    e.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res && res.ok && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => { });
                }
                return res;
            });
            if (cached) {
                network.catch(() => { }); // background refresh; ignore failures while offline
                return cached;
            }
            return network;
        }).catch(() => {
            // offline and not cached: only fall back to the app shell for page navigations
            if (req.mode === 'navigate') return caches.match('./index.html');
            return Response.error();
        })
    );
});
