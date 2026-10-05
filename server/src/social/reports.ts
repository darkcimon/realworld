// 사용자 신고(Play 정책: 사람끼리 소통하는 앱은 신고 기능이 있어야 한다).
// 신고하면 그 사람을 바로 차단하고, 서로 다른 사람에게 받은 신고가 쌓이면 자동으로 제재한다:
//   REPORT.jailAt명 → 감옥 3시간, REPORT.banAt명 이상 → 이용 정지(계정 삭제만 가능).
// 한 사람이 같은 상대를 여러 번 신고해도 1번으로 센다(혼자서 제재를 걸 수 없게).
import { db } from "../db.js";
import { sendToJail } from "../school/jail.js";
import { block } from "./dating.js";
import { notify } from "./notifications.js";

export const REPORT = { jailAt: 3, banAt: 5 };

export const REPORT_REASONS = ["욕설·비하", "성적인 내용", "스팸·광고", "사기·금전 요구", "불쾌한 사진", "기타"] as const;

export interface ReportResult {
  blocked: true;
  alreadyReported: boolean;
}

export function reportUser(reporterId: number, targetId: number, reason: unknown, detail: unknown): ReportResult {
  if (!Number.isInteger(targetId) || targetId === reporterId) throw { status: 400, message: "신고할 수 없는 대상이에요." };
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(targetId)) throw { status: 404, message: "없는 사용자예요." };
  if (typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason)) {
    throw { status: 400, message: "신고 사유를 골라 주세요." };
  }
  const note = typeof detail === "string" ? detail.trim().slice(0, 300) || null : null;

  db.exec("BEGIN");
  try {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO reports (reporter_id, target_id, reason, detail) VALUES (?, ?, ?, ?)")
      .run(reporterId, targetId, reason, note).changes > 0;
    block(reporterId, targetId);
    if (inserted) applySanctions(targetId);
    db.exec("COMMIT");
    return { blocked: true, alreadyReported: !inserted };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 아직 관리자가 처리하지 않은 신고 수(= 서로 다른 신고자 수). */
export function activeReportCount(targetId: number): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM reports WHERE target_id = ? AND cleared_at IS NULL").get(targetId) as { c: number }).c;
}

/** 받은 신고 수(서로 다른 신고자)에 따라 감옥·정지. 문턱을 "넘는 순간" 한 번만 적용한다. */
function applySanctions(targetId: number): void {
  const count = activeReportCount(targetId);
  if (count >= REPORT.banAt) {
    db.prepare("UPDATE users SET banned_at = COALESCE(banned_at, datetime('now')) WHERE id = ?").run(targetId);
  } else if (count === REPORT.jailAt) {
    sendToJail(targetId);
    notify(targetId, "system", `🚨 다른 이용자들의 신고가 ${REPORT.jailAt}건 쌓여 3시간 동안 감옥에 가게 됐어요. 신고가 ${REPORT.banAt}건이 되면 이용이 정지돼요.`);
  }
}
