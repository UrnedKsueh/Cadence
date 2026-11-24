// Cadence service worker: lets the app open offline.
// Network first: online you always get the newest files; offline you get the last saved copy.
// Bump CACHE when you want old saved copies thrown away.
const CACHE = "cadence-v62";
const FILES = [
  "./", "index.html", "style.css", "manifest.webmanifest",
  "theme.js", "shareview.js", "gate.js", "storage.js", "script.js", "tabs.js", "tools.js",
  "cloud.js", "share.js", "avatars.js", "social.js", "feed.js", "resources.js", "sharedprojects.js", "calendar.js", "pwa.js",
  "logo.png", "favicon.png", "icon-192.png", "icon-512.png"
];

self.addEventListener("install", function (event) {
  // No skipWaiting here: the app shows "A new version is ready" and asks first.
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(FILES.map(function (f) { return cache.add(f).catch(function () {}); }));
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Leave Firebase, Google sign-in and any other site alone
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === "navigate" ? caches.match("index.html") : undefined);
      });
    })
  );
});
