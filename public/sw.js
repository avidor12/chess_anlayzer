// Offline support: keep a copy of the app, engine and models after the first visit.
const CACHE = "chess-scanner-v5";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const save = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };
  if (req.mode === "navigate") {
    // Page: try the network first so updates show up, fall back to the cached copy.
    e.respondWith(fetch(req).then(save).catch(() => caches.match(req)));
    return;
  }
  // Hashed assets, engine and models: cache first.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(save)));
});
