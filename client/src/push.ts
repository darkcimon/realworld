// 휴대폰 알림(웹 푸시). 서비스 워커(public/sw.js)가 알림을 띄우고, 서버(/api/notifications/push)가 보낸다.
// Play 스토어 앱(TWA)에서는 Chrome이 알림 권한을 앱에 위임해서 안드로이드 앱 알림으로 뜬다.
import { api } from "./api";

export type PushState = "unsupported" | "denied" | "on" | "off";

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** 앱 시작 때 한 번: 서비스 워커 등록(알림을 받으려면 먼저 있어야 한다). */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // http(로컬 IP 등)에서는 등록이 안 된다 — 휴대폰 알림만 빠진다.
  });
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** 이 기기의 구독을 만들거나(서버 키가 바뀌었으면 새로) 가져와 지금 계정에 붙인다. */
async function subscribeAndLink(reg: ServiceWorkerRegistration): Promise<void> {
  const { publicKey } = await api.get<{ publicKey: string }>("/notifications/push/key");
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.post("/notifications/push/subscribe", { subscription: sub.toJSON() });
}

/** 알림 켜기(버튼을 눌렀을 때만 — 권한 요청은 사용자 동작 안에서 해야 한다). */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  if (!reg) return "unsupported";
  await subscribeAndLink(reg);
  return "on";
}

/** 알림 끄기: 서버에서 떼고 이 기기 구독도 지운다. */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.post("/notifications/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  return getPushState();
}

/** 로그인·접속 때: 이미 알림을 켠 기기면 지금 계정에 다시 붙인다(다른 계정으로 바꿔 로그인한 경우 등). */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const reg = await registration();
  if (!reg || !(await reg.pushManager.getSubscription())) return;
  await subscribeAndLink(reg).catch(() => {});
}

/** 로그아웃 직전: 이 기기를 지금 계정에서 뗀다(로그아웃한 계정의 알림이 계속 오지 않게). 구독 자체는 남겨 다음 로그인 때 다시 붙인다. */
export async function detachPush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await api.post("/notifications/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
}

export interface NotifClick {
  type: string | null;
  actorId: number | null;
}

/** 휴대폰 알림을 눌러 들어온 경우: 처음 열릴 때는 주소(?notif=&actor=), 이미 열려 있으면 서비스 워커 메시지로 받는다. */
export function onNotificationClick(fn: (c: NotifClick) => void): () => void {
  const params = new URLSearchParams(window.location.search);
  if (params.has("notif")) {
    const actor = params.get("actor");
    fn({ type: params.get("notif"), actorId: actor ? Number(actor) : null });
    params.delete("notif");
    params.delete("actor");
    const rest = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
  }
  if (!("serviceWorker" in navigator)) return () => {};
  const onMsg = (e: MessageEvent) => {
    if (e.data?.kind === "notif-click") fn({ type: e.data.type ?? null, actorId: e.data.actorId ?? null });
  };
  navigator.serviceWorker.addEventListener("message", onMsg);
  return () => navigator.serviceWorker.removeEventListener("message", onMsg);
}
