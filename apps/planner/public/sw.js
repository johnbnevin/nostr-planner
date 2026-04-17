/**
 * Service Worker for Planner.
 *
 * Features:
 * 1. Push notifications from the daemon
 * 2. Offline-first caching (app shell + assets)
 *
 * Base path is derived at runtime from the service worker's own URL,
 * so it works regardless of deployment path (e.g. "/planner/", "/", or any nsite path).
 */

// Derive base path from the SW's own location (e.g. "/planner/sw.js" → "/planner/")
const SW_PATH = self.location.pathname;
const BASE_PATH = SW_PATH.substring(0, SW_PATH.lastIndexOf("/") + 1);

const CACHE_NAME = "planner-v4";
const APP_SHELL = [
  BASE_PATH,
  BASE_PATH + "index.html",
  BASE_PATH + "calendar.svg",
];

// ── Install: pre-cache app shell ─────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn("[sw] failed to cache", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ───────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API/relay, cache-first for assets ───────

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests to prevent caching cross-origin responses
  if (url.origin !== self.location.origin) return;

  // Skip non-GET requests and WebSocket upgrades
  if (event.request.method !== "GET") return;
  if (url.protocol === "wss:" || url.protocol === "ws:") return;

  // Network-first for HTML (always try to get fresh app)
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match(BASE_PATH + "index.html");
        return cached || new Response("Offline — please check your connection.", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      })
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images, fonts)
  if (url.pathname.match(/\.(js|css|png|svg|ico|woff2?)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }
});

// ── Push notifications ───────────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Planner", body: event.data.text() };
  }

  const title = data.title || "Planner";
  const options = {
    body: data.body || "",
    icon: BASE_PATH + "calendar.svg",
    badge: BASE_PATH + "calendar.svg",
    tag: data.tag || "planner-notification",
    data: { url: data.url },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Validate notification URL: only allow same-origin or root fallback
  // to prevent open-redirect via crafted push payloads.
  let targetUrl = BASE_PATH;
  if (event.notification.data?.url) {
    try {
      const parsed = new URL(event.notification.data.url, self.location.origin);
      if (parsed.origin === self.location.origin) {
        targetUrl = parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {
      // Invalid URL, use base path
    }
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
