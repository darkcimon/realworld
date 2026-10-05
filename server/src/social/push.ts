// 휴대폰 알림(웹 푸시). Play 스토어 앱(TWA)은 Chrome으로 게임을 띄우므로, 표준 웹 푸시로 보낸 알림이
// 안드로이드 앱 알림으로 뜬다(TWA의 알림 위임). notify()가 게임 안 알림을 쌓을 때 함께 보낸다.
//
// VAPID 키: 환경변수(VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)가 있으면 그것을, 없으면 처음 한 번 만들어 DB에 저장해 둔다.
// 키가 바뀌면 이미 받은 구독이 모두 무효가 되므로, DB를 새로 만들 일이 있으면 키를 환경변수로 고정해 두는 게 안전하다.
import webpush from "web-push";
import { db } from "../db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
`);

function vapidKeys(): { publicKey: string; privateKey: string } {
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv };
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get() as { value: string } | undefined;
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}

const VAPID = vapidKeys();
// 푸시 서비스가 문제 있을 때 연락할 주소(필수 형식: mailto: 또는 https:).
webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", VAPID.publicKey, VAPID.privateKey);

export function pushPublicKey(): string {
  return VAPID.publicKey;
}

interface SubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

/** 이 기기의 구독을 이 유저에게 붙인다. 같은 기기에서 다른 계정으로 로그인하면 새 계정으로 옮겨진다. */
export function saveSubscription(userId: number, sub: SubscriptionInput): void {
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || typeof p256dh !== "string" || typeof auth !== "string") {
    throw { status: 400, message: "알림 구독 정보가 올바르지 않아요." };
  }
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(userId, endpoint, p256dh, auth);
}

/** 로그아웃·알림 끄기: 이 기기 구독을 지운다(내 것만). */
export function removeSubscription(userId: number, endpoint: unknown): void {
  if (typeof endpoint !== "string") return;
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string; // 같은 tag 알림은 새 것으로 바뀐다(같은 사람의 메시지가 쌓이지 않게)
  type?: string;
  actorId?: number | null;
}

/** 이 유저의 모든 기기에 알림을 보낸다. 실패해도 게임 동작은 막지 않고, 만료된 구독은 지운다. */
export function sendPush(userId: number, payload: PushPayload): void {
  const subs = db
    .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
    .all(userId) as { id: number; endpoint: string; p256dh: string; auth: string }[];
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  for (const s of subs) {
    webpush
      .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60 * 24 })
      .catch((e: { statusCode?: number }) => {
        // 404/410: 앱 삭제·권한 해제 등으로 사라진 구독
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
        } else {
          console.warn("push 전송 실패", e?.statusCode ?? e);
        }
      });
  }
}
