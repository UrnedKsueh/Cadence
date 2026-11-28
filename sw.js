const VERSION = "cadence-v4";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "favicon.png",
  "logo.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "tags/tag1.png",
  "tags/tag2.png",
  "tags/tag3.png",
  "tags/tag4.png",
  "tags/tag5.png",
  "theme.js",
  "shareview.js",
  "icons.js",
  "gate.js",
  "storage.js",
  "script.js",
  "tabs.js",
  "tools.js",
  "profilecard.js",
  "search.js",
  "calendar.js",
  "pwa.js",
  "homesheet.js",
  "cloud.js",
  "share.js",
  "avatars.js",
  "social.js",
  "hub.js",
  "feed.js",
  "resources.js",
  "sharedprojects.js",
  "chat.js"
];
const FIREBASE_CDN = "https://www.gstatic.com/firebasejs/";

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return Promise.all(SHELL.map(function (u) { return cache.add(u).catch(function () {}); }));
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

function remember(req, res) {
  if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
    const copy = res.clone();
    caches.open(VERSION).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const firebaseSdk = url.href.indexOf(FIREBASE_CDN) === 0;
  if (!sameOrigin && !firebaseSdk) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) { return remember(req, res); }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match("index.html"); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) { return remember(req, res); });
    })
  );
});
