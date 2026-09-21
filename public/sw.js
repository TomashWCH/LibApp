// Na razie minimalny service worker — tylko żeby appka kwalifikowała się jako PWA
// (instalacja na ekranie głównym). Cache/offline można dodać później.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
