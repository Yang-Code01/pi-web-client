/* Service worker: Web Push only (DECISIONS D24 — WeChat is the primary channel). */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "pi", body: "", url: "/" };
  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch {
    payload.body = event.data ? event.data.text() : "";
  }
  event.waitUntil(
    // D91: the page is right in front of the user (visible tab in a focused window) — no Windows
    // notification; the page already shows the question. Chromium does not demand a notification
    // for a push while a focused client exists.
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      if (list.some((c) => c.focused && c.visibilityState === "visible")) return;
      return self.registration.showNotification(payload.title || "pi", {
        body: payload.body || "",
        data: { url: payload.url || "/" },
        tag: payload.url || "pi",
        renotify: true,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
