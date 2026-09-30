// Service worker של הלוח של hob: רק התראות. דחיפה מגיעה בלי תוכן; מושכים את ההתראה
// האחרונה מהשרת (עם ה-cookie של הלוח) ומציגים אותה. iOS מחייב להציג התראה על
// כל דחיפה, לכן יש תמיד נוסח ברירת מחדל.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let note = { title: "hob", body: "יש משהו חדש אצל הובי", url: "/?tab=hobi" };
      try {
        const res = await fetch("/api/push?latest=1", { credentials: "same-origin" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.title) note = data;
        }
      } catch (e) {
        // נשארים עם ברירת המחדל
      }
      await self.registration.showNotification(note.title, {
        body: note.body,
        icon: "/assets/apple-touch-icon.png",
        badge: "/assets/favicon.png",
        dir: "rtl",
        lang: "he",
        data: { url: note.url || "/?tab=hobi" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/?tab=hobi";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          if ("navigate" in c) await c.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
