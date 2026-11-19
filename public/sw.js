// Jimeng Video Downloader — service worker.
//
// App-shell caching only: the document and the built assets (JS/CSS,
// icons, manifest) are cached so the home page opens offline after the
// first visit. The action API and prepared downloads are NEVER cached
// and always go to the network:
//   - /actions  — server actions (login, downloads, tickets, …)
//   - /blobs/ and /files/ — prepared video files (must always be fresh)
// If the network is down and a navigation has no cached copy, the cached
// home page is served instead of an error page.
const CACHE_NAME = "jimeng-dl-shell-v1";
const SHELL_URLS = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return (
    url.pathname === "/actions" ||
    url.pathname.startsWith("/blobs/") ||
    url.pathname.startsWith("/files/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only handle same-origin requests; cross-origin (Jimeng CDN, fonts)
  // is left to the network.
  if (url.origin !== self.location.origin) return;
  // API and prepared files: network only, never cached, never stale.
  if (isApiRequest(url)) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => undefined);
      // Navigation: serve the cached shell immediately when offline.
      if (req.mode === "navigate") {
        return cached || network.then((res) => res || caches.match("./index.html"));
      }
      // Assets: cached copy first, network fills the cache behind it.
      return cached || network;
    }),
  );
});
