// Офлайн-кэш своих файлов. Чужие запросы (Google) не трогаем: они идут в сеть как есть.
// При любом изменении файлов из FILES поднимай VERSION, иначе телефон останется на старом кэше.

const VERSION = 'v1';
const CACHE = `day-planer-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'src/app.js',
  'src/dom.js',
  'src/plan.js',
  'src/schedule.js',
  'src/schema.js',
  'src/store.js',
  'src/time.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('day-planer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache-first: все файлы одной версии, без смеси старых и новых модулей.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./');
      return fetch(req);
    }),
  );
});
