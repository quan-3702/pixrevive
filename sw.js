const CACHE = 'pixrevive-v1';
const ASSETS = ['./', 'index.html', 'help.html', 'style.css', 'app.js', 'worker.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith('pixrevive-models') && !k.startsWith('pixrevive-lib')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// the app files come from the app cache; the AI runtime from the CDN is kept too so the app works offline
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) {
    e.respondWith(caches.open('pixrevive-lib-v1').then(async (c) => { const hit = await c.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
