/* Pi Companion — service worker.
   - Network-first for HTML/JS/CSS (fresh app code when online).
   - Push notifications: show only meaningful events, tap → open session. */

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {}
  const kind = data.kind || "completed";
  const title = data.title || "Pi Companion";
  const body = data.body || "";
  // Only surface meaningful events (server already filters, double-check here).
  if (!["needs-input", "completed", "failed"].includes(kind)) return;
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: `pi-session-${data.sessionId}-${kind}`,
      data: { sessionId: data.sessionId },
      sound: kind === "needs-input" ? "default" : undefined,
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const sessionId = e.notification.data?.sessionId;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.postMessage({ type: "open-session", sessionId });
          return c.focus();
        }
      }
      return self.clients.openWindow(sessionId ? `/#/session/${sessionId}` : "/");
    })
  );
});