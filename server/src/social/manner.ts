// README 6.4~6.5: 매너 점수 / 클린 체크 / 사회인 감옥.
// 위반 감지 자체는 Phase 1의 detectViolation + jail.ts recordViolation(3단계 위반→감옥)을
// context='social'로 그대로 재사용한다. 이 모듈은 그 위에 매너 점수(-1) 적립만 얹는다.
import { db } from "../db.js";
import { detectViolation } from "../util/moderation.js";
import { recordViolation, type ViolationResult } from "../school/jail.js";

const DEFAULT_SCORE = 100;
export const CLEAN_CHECK_THRESHOLD = 90;
export const MANNER_RESET_COST = 50_000_000; // 5,000만 게임머니

export interface MannerRow {
  user_id: number;
  score: number;
  clean_check: number;
}

export function ensureManner(userId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO manner_scores (user_id, score, clean_check) VALUES (?, ?, 0)"
  ).run(userId, DEFAULT_SCORE);
}

export function getManner(userId: number): MannerRow {
  ensureManner(userId);
  return db
    .prepare("SELECT * FROM manner_scores WHERE user_id = ?")
    .get(userId) as unknown as MannerRow;
}

export function setCleanCheck(userId: number, enabled: boolean): void {
  ensureManner(userId);
  db.prepare("UPDATE manner_scores SET clean_check = ? WHERE user_id = ?").run(
    enabled ? 1 : 0,
    userId
  );
}

/** 매너 초기화 결제 이후 호출: 점수를 100으로 되돌리고 미소진 위반 누적을 0으로 만든다. */
export function resetManner(userId: number): void {
  ensureManner(userId);
  db.prepare("UPDATE manner_scores SET score = ? WHERE user_id = ?").run(DEFAULT_SCORE, userId);
  db.prepare(
    "UPDATE violations SET consumed_at = datetime('now') WHERE user_id = ? AND context = 'social' AND consumed_at IS NULL"
  ).run(userId);
}

export interface SocialContentCheckResult {
  violated: boolean;
  badWord?: string;
  mannerScore?: number;
  violation?: ViolationResult;
}

/**
 * 사회 콘텐츠(직장 대화, 사회인 채팅 등)에서 자유 텍스트가 들어올 때 재사용할 공용 훅.
 * 금지어가 감지되면 매너 점수 -1 + 4.6과 동일한 3단계 위반 규칙(context='social')을 적용한다.
 */
export function checkSocialContent(userId: number, content: string): SocialContentCheckResult {
  const badWord = detectViolation(content);
  if (!badWord) return { violated: false };

  ensureManner(userId);
  db.prepare("UPDATE manner_scores SET score = MAX(0, score - 1) WHERE user_id = ?").run(userId);
  db.prepare(
    "INSERT INTO manner_violations (user_id, reason, delta) VALUES (?, ?, -1)"
  ).run(userId, `금지어 감지: ${badWord}`);

  const violation = recordViolation(userId, "social", `금지어 감지: ${badWord}`);
  const mannerScore = getManner(userId).score;
  return { violated: true, badWord, mannerScore, violation };
}

/** "클린 체크" 필터: 켜져 있으면 상대 매너 점수가 90점 이하일 때 목록/채팅 요청에서 제외한다. */
export function isVisibleUnderCleanCheck(viewerId: number, targetId: number): boolean {
  const viewer = getManner(viewerId);
  if (!viewer.clean_check) return true;
  return getManner(targetId).score > CLEAN_CHECK_THRESHOLD;
}
