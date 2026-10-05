// 서비스 워커: 휴대폰 알림(웹 푸시)을 받아 띄우고, 알림을 누르면 게임을 연다.
// Play 스토어 앱(TWA)에서는 이 알림이 안드로이드 앱 알림으로 뜬다.
// 화면 파일은 캐시하지 않는다(배포하면 바로 새 버전이 보이게) — 이 워커는 알림 전용이다.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "인생 시뮬레이션";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag,
      renotify: !!data.tag, // 같은 사람의 새 메시지면 바꿔치기하면서도 다시 울린다
      data: { type: data.type || null, actorId: data.actorId ?? null },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { type, actorId } = event.notification.data || {};
  const params = new URLSearchParams();
  if (type) params.set("notif", type);
  if (actorId != null) params.set("actor", String(actorId));
  const url = "/" + (params.toString() ? `?${params}` : "");
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        // 이미 열려 있으면 그 화면으로 가져와서, 어떤 알림을 눌렀는지만 알려준다(진행 중인 화면을 새로 고치지 않게).
        await open.focus();
        open.postMessage({ kind: "notif-click", type, actorId });
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
