const CACHE_NAME = 'neelaxmi-proctor-models-v1';

const CACHEABLE_HOSTS = ['cdn.jsdelivr.net'];
const CACHEABLE_PATH_PREFIXES = ['/vendor/'];

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    let url;
    try {
        url = new URL(event.request.url);
    } catch (err) {
        return; 
    }

    const isCacheableHost = CACHEABLE_HOSTS.includes(url.hostname);
    const isCacheablePath = CACHEABLE_PATH_PREFIXES.some((p) => url.pathname.startsWith(p));

    if (event.request.method !== 'GET' || (!isCacheableHost && !isCacheablePath)) {
        return;
            }

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request);
            if (cached) return cached; 
            
            try {
                const response = await fetch(event.request);
                if (response && response.status === 200) {
                    cache.put(event.request, response.clone());
                }
                return response;
            } catch (err) {
                throw err;
            }
        })
    );
});


(function () {
    const IMG_DB = 'neelaxmi-local-quiz-images', IMG_STORE = 'images';
    const idbOpen = () => new Promise((res, rej) => {
        const r = indexedDB.open(IMG_DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(IMG_STORE, { keyPath: 'key' });
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const idbGet = (db, key) => new Promise((res, rej) => { const q = db.transaction(IMG_STORE).objectStore(IMG_STORE).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const idbDel = (db, key) => new Promise((res) => { const t = db.transaction(IMG_STORE, 'readwrite'); t.objectStore(IMG_STORE).delete(key); t.oncomplete = t.onerror = () => res(); });

    self.addEventListener('fetch', (event) => {
        if (event.request.method !== 'GET') return;
        const m = new URL(event.request.url).pathname.match(/\/local-img\/([^/]+)(?:\/(\d+)\.jpg)?$/);
        if (!m) return;
        event.respondWith((async () => {
            if (m[1] === '_ping') return new Response(null, { status: 204 });   // lets the setup page confirm this worker is live
            try {
                const db = await idbOpen(), key = m[1] + '/' + m[2], rec = await idbGet(db, key);
                if (rec && rec.expiresAt < Date.now()) { await idbDel(db, key); db.close(); return new Response('Expired', { status: 410 }); }
                db.close();
                if (rec) return new Response(rec.blob, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
            } catch (e) { /* fall through */ }
            return new Response('Not stored on this device', { status: 404 });
        })());
    });
})();
