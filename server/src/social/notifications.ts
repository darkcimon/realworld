// 알림(리텐션 루프): 로또 결과, 월급 지급, 하트/맞하트처럼 "유저가 자리를 비운 사이 일어난 일"을
// 다음 접속 때 한눈에 보여준다. 이벤트가 일어나는 곳(로또 추첨, 정산, 하트)에서 notify()만 부르면 된다.
import { db } from "../db.js";

export type NotificationType = "lottery" | "salary" | "heart" | "match" | "gift" | "npc";

export function notify(userId: number, type: NotificationType, message: string): void {
  db.prepare("INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)").run(
    userId,
    type,
    message
  );
}

export function listNotifications(userId: number, limit = 30) {
  return db
    .prepare(
      "SELECT id, type, message, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(userId, limit);
}

export function unreadCount(userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0")
    .get(userId) as { c: number };
  return row.c;
}

export function markAllRead(userId: number): void {
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0").run(userId);
}

export function nicknameOf(userId: number): string {
  const row = db.prepare("SELECT nickname FROM users WHERE id = ?").get(userId) as
    | { nickname: string }
    | undefined;
  return row?.nickname ?? "누군가";
}
