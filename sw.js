// AI Daily service worker. Network-first for everything (so new editions AND app updates show up right away);
// the cache is only an offline fallback. Bump CACHE when the shell changes.
const CACHE = 'aidaily-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = url.pathname.includes('/editions/');
  // Edition JSON: bypass the HTTP cache entirely; store under the query-less URL for offline use.
  const net = isData ? fetch(url.href, { cache: 'no-store' }) : fetch(e.request);
  const key = isData ? url.origin + url.pathname : e.request;
  e.respondWith(net.then(r => {
    if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key, { ignoreSearch: true }).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined))));
});
