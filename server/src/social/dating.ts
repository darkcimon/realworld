// README 11.2~11.5: 프로필 열람권, 채팅 개시 게이트, 선물/하트/맞하트, 차단.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { listDisplayedItems } from "./catalog.js";
import { checkSocialContent } from "./manner.js";
import { nicknameOf, notify } from "./notifications.js";
import { chatLengthError } from "../util/chatLimit.js";

export const GIFT_COST = 1_000_000;
// 하트 50만원 / 프로필 열람(=채팅 개시 조건) 300만원: 일급 상한(S등급 최대 30만원)을 받은 상태에서도
// 하루에 채팅을 걸 수 있는 상대가 2~5명 정도로 제한되도록 일부러 하트/열람권 비용을 높게 잡았다.
export const HEART_COST = 500_000;
export const PROFILE_VIEW_COST = 3_000_000;
export const PROFILE_VIEW_DURATION_MS = 60 * 60 * 1000; // 1시간

export function isBlocked(a: number, b: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)"
    )
    .get(a, b, b, a);
  return !!row;
}

function assertNotBlocked(a: number, b: number): void {
  if (isBlocked(a, b)) throw { status: 403, message: "차단 관계로 상호작용할 수 없습니다." };
}

/** README: 차단 시 "매칭 해제 + 대화 비활성화"로 최소 구현(세부 정책은 오픈 이슈). */
export function block(blockerId: number, blockedId: number): void {
  db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)").run(
    blockerId,
    blockedId
  );
  db.prepare(
    "UPDATE matches SET active = 0 WHERE active = 1 AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))"
  ).run(blockerId, blockedId, blockedId, blockerId);
}

export function unblock(blockerId: number, blockedId: number): void {
  db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(
    blockerId,
    blockedId
  );
}

export function isMatched(a: number, b: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM matches WHERE active = 1 AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))"
    )
    .get(a, b, b, a);
  return !!row;
}

function grantViewPass(viewerId: number, targetId: number): string {
  const expiresAt = new Date(Date.now() + PROFILE_VIEW_DURATION_MS)
    .toISOString()
    .replace("Z", "");
  db.prepare(
    "INSERT INTO profile_view_passes (viewer_id, target_id, expires_at) VALUES (?, ?, ?)"
  ).run(viewerId, targetId, expiresAt);
  return expiresAt;
}

export function hasValidPass(viewerId: number, targetId: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM profile_view_passes WHERE viewer_id = ? AND target_id = ? AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"
    )
    .get(viewerId, targetId);
  return !!row;
}

export function purchaseProfileView(
  viewerId: number,
  targetId: number
): { balance: number; expiresAt: string } {
  if (viewerId === targetId) throw { status: 400, message: "본인 프로필입니다." };
  assertNotBlocked(viewerId, targetId);
  const { balance } = applyLedgerEntry(viewerId, "프로필열람권", -PROFILE_VIEW_COST);
  const expiresAt = grantViewPass(viewerId, targetId);
  return { balance, expiresAt };
}

export function getProfileDetail(viewerId: number, targetId: number) {
  assertNotBlocked(viewerId, targetId);
  if (viewerId !== targetId && !hasValidPass(viewerId, targetId) && !isMatched(viewerId, targetId)) {
    throw { status: 403, message: "열람권이 없거나 만료되었습니다." };
  }
  const user = db.prepare("SELECT id, nickname, avatar_url FROM users WHERE id = ?").get(
    targetId
  ) as any;
  const photos = db
    .prepare("SELECT url, sort_order FROM profile_photos WHERE user_id = ? ORDER BY sort_order")
    .all(targetId);
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    photos,
    displayedItems: listDisplayedItems(targetId),
  };
}

function assertCanChat(userId: number, targetId: number): void {
  assertNotBlocked(userId, targetId);
  if (!isMatched(userId, targetId) && !hasValidPass(userId, targetId)) {
    throw { status: 403, message: "열람권이 유효하지 않아 채팅을 시작할 수 없습니다." };
  }
}

/** dm 소켓 룸 join처럼 "예외 없이 가부만" 필요한 곳에서 쓰는 버전. */
export function canChat(userId: number, targetId: number): boolean {
  try {
    assertCanChat(userId, targetId);
    return true;
  } catch {
    return false;
  }
}

export function requestChat(requesterId: number, targetId: number): { ok: true } {
  assertCanChat(requesterId, targetId);
  return { ok: true };
}

export interface SocialMessage {
  id: number;
  from_id: number;
  to_id: number;
  content: string;
  created_at: string;
  nickname?: string;
  avatarUrl?: string | null;
}

/** 채팅 개시 조건(맞하트 또는 유효한 열람권)을 만족해야 실제 메시지도 보낼 수 있다. */
export function sendSocialMessage(
  fromId: number,
  toId: number,
  content: string
): { message: SocialMessage; violation: ReturnType<typeof checkSocialContent> } {
  if (fromId === toId) throw { status: 400, message: "자기 자신에게 메시지를 보낼 수 없습니다." };
  assertCanChat(fromId, toId);
  const text = String(content ?? "").trim();
  if (!text) throw { status: 400, message: "내용을 입력해주세요." };
  const tooLong = chatLengthError(text);
  if (tooLong) throw { status: 400, message: tooLong };

  const result = db
    .prepare("INSERT INTO social_messages (from_id, to_id, content) VALUES (?, ?, ?)")
    .run(fromId, toId, text);
  const row = db
    .prepare(
      "SELECT sm.*, u.nickname, u.avatar_url AS avatarUrl FROM social_messages sm JOIN users u ON u.id = sm.from_id WHERE sm.id = ?"
    )
    .get(Number(result.lastInsertRowid)) as unknown as SocialMessage;

  // README 6.4(매너)/manner.ts의 "사회인 채팅 등"에서 재사용하기로 되어 있던 훅을 여기서 실제로 건다.
  const violation = checkSocialContent(fromId, text);
  return { message: row, violation };
}

export function listSocialMessages(userId: number, otherId: number): SocialMessage[] {
  assertCanChat(userId, otherId);
  return db
    .prepare(
      `SELECT sm.*, u.nickname, u.avatar_url AS avatarUrl FROM social_messages sm JOIN users u ON u.id = sm.from_id
       WHERE (sm.from_id = ? AND sm.to_id = ?) OR (sm.from_id = ? AND sm.to_id = ?)
       ORDER BY sm.id`
    )
    .all(userId, otherId, otherId, userId) as unknown as SocialMessage[];
}

/** 아직 맞하트로 이어지지 않은, 나에게 온 하트 목록 — "맞하트" 버튼을 실제로 쓸 수 있게 해준다. */
export function listIncomingHearts(userId: number) {
  return db
    .prepare(
      `SELECT h.sender_id AS senderId, u.nickname, u.avatar_url AS avatarUrl, h.sent_at AS sentAt
       FROM hearts h JOIN users u ON u.id = h.sender_id
       WHERE h.receiver_id = ? AND NOT EXISTS (
         SELECT 1 FROM matches m WHERE m.active = 1
           AND ((m.user_a = h.sender_id AND m.user_b = h.receiver_id)
             OR (m.user_a = h.receiver_id AND m.user_b = h.sender_id))
       )
       ORDER BY h.id DESC`
    )
    .all(userId);
}

/** 맞하트가 성립된 상대 목록 — 굳이 다시 주변 사람 찾기를 거치지 않아도 채팅 상대를 찾을 수 있게. */
export function listMatches(userId: number) {
  return db
    .prepare(
      `SELECT
         CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END AS userId,
         u.nickname, u.avatar_url AS avatarUrl, m.matched_at AS matchedAt
       FROM matches m
       JOIN users u ON u.id = CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END
       WHERE m.active = 1 AND (m.user_a = ? OR m.user_b = ?)
       ORDER BY m.id DESC`
    )
    .all(userId, userId, userId, userId);
}

export function sendGift(senderId: number, receiverId: number): { balance: number } {
  if (senderId === receiverId) throw { status: 400, message: "자기 자신에게 선물할 수 없습니다." };
  assertNotBlocked(senderId, receiverId);
  const { balance } = applyLedgerEntry(senderId, "선물", -GIFT_COST);
  db.prepare(
    "INSERT INTO gifts (sender_id, receiver_id, item_ref, amount) VALUES (?, ?, NULL, ?)"
  ).run(senderId, receiverId, GIFT_COST);
  return { balance };
}

export function sendHeart(senderId: number, receiverId: number): { balance: number } {
  if (senderId === receiverId) throw { status: 400, message: "자기 자신에게 하트를 보낼 수 없습니다." };
  assertNotBlocked(senderId, receiverId);
  const already = db
    .prepare("SELECT 1 FROM hearts WHERE sender_id = ? AND receiver_id = ?")
    .get(senderId, receiverId);
  if (already) throw { status: 409, message: "이미 하트를 보냈습니다." };

  const { balance } = applyLedgerEntry(senderId, "하트", -HEART_COST);
  db.prepare("INSERT INTO hearts (sender_id, receiver_id) VALUES (?, ?)").run(
    senderId,
    receiverId
  );
  // README 11.3: 수신자는 발신자 프로필을 무료로 열람 가능(자동 view-pass 발급)
  grantViewPass(receiverId, senderId);
  notify(receiverId, "heart", `💌 ${nicknameOf(senderId)}님이 하트를 보냈어요! 프로필을 확인하고 맞하트를 보내보세요.`);
  return { balance };
}

/**
 * 상대(targetId)가 먼저 보낸 하트에 답한다. 아직 내가 하트를 보낸 적 없으면 동일하게
 * 10만 게임머니를 차감하며 하트를 기록하고, matches를 생성해 이후 열람권 없이 채팅을 열어준다.
 */
export function reciprocateHeart(
  userId: number,
  targetId: number
): { ok: true; balance?: number } {
  assertNotBlocked(userId, targetId);
  const incoming = db
    .prepare("SELECT 1 FROM hearts WHERE sender_id = ? AND receiver_id = ?")
    .get(targetId, userId);
  if (!incoming) {
    throw { status: 400, message: "상대가 먼저 하트를 보내야 맞하트할 수 있습니다." };
  }

  let balance: number | undefined;
  const already = db
    .prepare("SELECT 1 FROM hearts WHERE sender_id = ? AND receiver_id = ?")
    .get(userId, targetId);
  if (!already) {
    balance = applyLedgerEntry(userId, "하트", -HEART_COST).balance;
    db.prepare("INSERT INTO hearts (sender_id, receiver_id) VALUES (?, ?)").run(
      userId,
      targetId
    );
    grantViewPass(targetId, userId);
  }

  if (!isMatched(userId, targetId)) {
    db.prepare("INSERT INTO matches (user_a, user_b) VALUES (?, ?)").run(userId, targetId);
    notify(targetId, "match", `💘 ${nicknameOf(userId)}님과 맞하트가 성사되었어요! 이제 자유롭게 대화할 수 있어요.`);
    notify(userId, "match", `💘 ${nicknameOf(targetId)}님과 맞하트가 성사되었어요! 이제 자유롭게 대화할 수 있어요.`);
  }
  return { ok: true, balance };
}
