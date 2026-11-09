// Coffee Please service worker: shows alerts when the app is closed and opens the app when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "Coffee Please", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Coffee Please";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    data: { url: data.url || "./" },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    try { if (typeof data.badge === "number" && self.navigator.setAppBadge) await self.navigator.setAppBadge(data.badge); } catch (e) {}
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        try { await w.focus(); } catch (e) {}
        w.postMessage({ type: "open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
