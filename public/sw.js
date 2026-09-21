// Service worker: instalacja appki (PWA) i powiadomienia push.
// Celowo bez cache'owania plików — appka zawsze pobiera aktualną wersję.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Powiadomienie z serwera (Web Push). Treść jest w formacie JSON: { title, body, tag, url }.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Podsumowanie dnia";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "./" },
    })
  );
});

// Dotknięcie powiadomienia otwiera appkę (albo wraca do już otwartej).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
