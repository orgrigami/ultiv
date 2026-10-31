/*
 * Spreissen service worker: a minimal offline shell plus Web Push.
 *
 * Caching rule: only the static offline page and the app icon are ever
 * cached (at install). Nothing fetched at runtime is stored: no API
 * response, no WebSocket, no page HTML, no authenticated data. Navigations
 * go to the network and fall back to the offline page only when it fails.
 */
// Renamed with the product; activate deletes every other cache, including
// the old "ultiv-shell-v2".
const SHELL_CACHE = "spreissen-shell-v1";
const SHELL_FILES = ["/offline.html", "/icons/icon-192.png"];
const NEVER = ["/api/", "/chord", "/hooks/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((prefix) => url.pathname.startsWith(prefix))) return;
  // The offline page's own icon: network first, the install-time copy offline.
  if (request.mode !== "navigate") {
    if (!SHELL_FILES.includes(url.pathname)) return;
    event.respondWith(
      fetch(request).catch(() => caches.match(url.pathname).then((hit) => hit ?? Response.error())),
    );
    return;
  }
  event.respondWith(
    fetch(request).catch(() =>
      caches.match("/offline.html").then((page) => page ?? Response.error()),
    ),
  );
});

/** Only in-app paths open from a notification; anything else opens home. */
const inAppUrl = (raw) => {
  const path = typeof raw === "string" && /^\/[A-Za-z0-9/_\-.%]*$/.test(raw) ? raw : "/";
  return new URL(path, self.location.origin).href;
};

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title : "Spreissen";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: inAppUrl(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = inAppUrl(
    event.notification.data && typeof event.notification.data.url === "string"
      ? new URL(event.notification.data.url).pathname
      : "/",
  );
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open !== undefined) {
        const focused = await open.focus();
        if ("navigate" in focused) return focused.navigate(target);
        return focused;
      }
      return self.clients.openWindow(target);
    }),
  );
});
