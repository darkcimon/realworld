// 알림(리텐션 루프): 로또 결과, 월급 지급, 하트/맞하트처럼 "유저가 자리를 비운 사이 일어난 일"을
// 다음 접속 때 한눈에 보여준다. 이벤트가 일어나는 곳(로또 추첨, 정산, 하트)에서 notify()만 부르면 된다.
import { db } from "../db.js";
import { sendPush } from "./push.js";

export type NotificationType = "lottery" | "salary" | "heart" | "match" | "gift" | "npc" | "message";

// 휴대폰 알림(푸시)으로도 보낼 종류와 그 제목. NPC(상사·점장·동료) 알림은 게임 안에서 행동할 때 생기는 말이라
// 휴대폰까지 울리면 시끄러우므로 게임 안 알림으로만 남긴다.
const PUSH_TITLES: Partial<Record<NotificationType, string>> = {
  lottery: "🎰 로또 결과",
  salary: "💰 월급 지급",
  heart: "💌 하트 도착",
  match: "💘 맞하트 성사",
  gift: "🎁 선물 도착",
  message: "💬 새 메시지",
};

/** actorId: 알림을 일으킨 상대 유저 — 클라이언트가 알림을 눌렀을 때 그 사람과의 대화로 바로 이동하는 데 쓴다. */
export function notify(userId: number, type: NotificationType, message: string, actorId?: number): void {
  db.prepare("INSERT INTO notifications (user_id, type, message, actor_id) VALUES (?, ?, ?, ?)").run(
    userId,
    type,
    message,
    actorId ?? null
  );
  const title = PUSH_TITLES[type];
  if (title) {
    // 같은 사람의 메시지는 휴대폰 알림 하나로 바꿔치기한다(대화 중 알림이 쌓이지 않게).
    const tag = type === "message" && actorId != null ? `message-${actorId}` : undefined;
    sendPush(userId, { title, body: message, tag, type, actorId: actorId ?? null });
  }
}

/**
 * 1:1 메시지 알림. 메시지마다 알림을 쌓으면 대화 한 번에 알림창이 도배되므로, 같은 사람에게서 온
 * 안 읽은 메시지 알림은 하나만 남긴다(이전 것을 지우고 최신 내용으로 다시 넣어 맨 위로 올린다).
 */
export function notifyMessage(toId: number, fromId: number, content: string): void {
  db.prepare("DELETE FROM notifications WHERE user_id = ? AND type = 'message' AND actor_id = ? AND read = 0").run(
    toId,
    fromId
  );
  const preview = content.length > 30 ? `${content.slice(0, 30)}…` : content;
  notify(toId, "message", `💬 ${nicknameOf(fromId)}님이 메시지를 보냈어요: "${preview}"`, fromId);
}

export function listNotifications(userId: number, limit = 30) {
  return db
    .prepare(
      "SELECT id, type, message, read, created_at, actor_id AS actorId FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?"
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
