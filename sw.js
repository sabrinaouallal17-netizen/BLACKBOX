// BLACKBOX offline support: the app's own files are served from the network when online (so updates
// arrive right away) and from the cache when offline. Firebase traffic is never cached here.
const CACHE = "blackbox-v1.7";
const SHELL = ["./", "index.html", "styles.css", "icons.js", "ui.js", "changelog.js", "app.js", "notify.js", "board.js", "updates.js", "chat.js", "bugs.js", "feedback.js", "analytics.js", "search.js", "boot.js", "chat.css", "bugs.css", "feedback.css", "analytics.css", "docs.css", "search.css", "firebase-config.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const shared = /gstatic\.com\/firebasejs|cdn\.jsdelivr\.net\/npm\/idiomorph|fonts\.(googleapis|gstatic)\.com/.test(url.href);
  if (e.request.method !== "GET" || (url.origin !== location.origin && !shared)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
