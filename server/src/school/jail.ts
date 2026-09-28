// README 4.6 / 5장: 금지 행위 감지 → 경고 2회 → 3차 위반 시 감옥행,
// 감옥 내에서 다시 3회 위반하면 독방행. 감옥/독방 중에는 다른 콘텐츠 접근을 막는다.
import { db } from "../db.js";

export type JailType = "jail" | "solitary";

export interface JailSession {
  id: number;
  user_id: number;
  type: JailType;
  started_at: string;
  ends_at: string;
  active: number;
}

const JAIL_DURATION_MS = 3 * 60 * 60 * 1000; // 3시간
const SOLITARY_DURATION_MS = 24 * 60 * 60 * 1000; // 1일

export function getActiveJail(userId: number): JailSession | null {
  const row = db
    .prepare(
      "SELECT * FROM jail_sessions WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1"
    )
    .get(userId) as JailSession | undefined;
  if (!row) return null;
  if (new Date(row.ends_at + "Z").getTime() <= Date.now()) {
    db.prepare("UPDATE jail_sessions SET active = 0 WHERE id = ?").run(row.id);
    return null;
  }
  return row;
}

function unconsumedCount(userId: number, context: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM violations WHERE user_id = ? AND context = ? AND consumed_at IS NULL"
    )
    .get(userId, context) as { c: number };
  return row.c;
}

export interface ViolationResult {
  level: number; // 이번 위반까지의 누적 차수 (1~3)
  jailed: boolean;
  type: JailType | null;
}

/** 위반을 기록하고, 3차 위반이면 감옥(또는 독방)행을 처리한다. */
export function recordViolation(
  userId: number,
  context: "school" | "jail" | "social",
  reason: string
): ViolationResult {
  const level = unconsumedCount(userId, context) + 1;
  db.prepare(
    "INSERT INTO violations (user_id, context, reason, level) VALUES (?, ?, ?, ?)"
  ).run(userId, context, reason, level);

  if (level < 3) {
    return { level, jailed: false, type: null };
  }

  // 3차 위반: 이번 사이클의 위반 기록을 소진 처리하고 감옥/독방행
  db.prepare(
    "UPDATE violations SET consumed_at = datetime('now') WHERE user_id = ? AND context = ? AND consumed_at IS NULL"
  ).run(userId, context);

  // 'jail' 컨텍스트(감옥 안에서의 재위반)만 독방행. 'school'/'social'처럼 감옥 밖에서의
  // 3차 위반은 모두 감옥행이다. (Phase 2에서 'social' 컨텍스트가 추가되며 이 분기를 명시적으로 정리)
  const type: JailType = context === "jail" ? "solitary" : "jail";
  const durationMs = type === "jail" ? JAIL_DURATION_MS : SOLITARY_DURATION_MS;
  const endsAt = new Date(Date.now() + durationMs).toISOString().replace("Z", "");

  // 독방행이면 기존 감옥 세션은 종료 처리하고 독방 세션으로 대체한다.
  if (type === "solitary") {
    db.prepare(
      "UPDATE jail_sessions SET active = 0 WHERE user_id = ? AND type = 'jail' AND active = 1"
    ).run(userId);
  }

  db.prepare(
    "INSERT INTO jail_sessions (user_id, type, ends_at) VALUES (?, ?, ?)"
  ).run(userId, type, endsAt);

  return { level, jailed: true, type };
}
