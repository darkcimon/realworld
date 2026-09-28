// NPC들이 서로의 상태를 참고하는 얇은 조회 함수 + 이벤트 하루 1회 판정.
// npcManager ↔ npcBoss가 서로를 import하면 순환이 되므로, 상대 NPC의 상태는 여기서 SQL로 직접 읽는다.
import { db } from "../db.js";
import { todayKstDate } from "./lottery.js";

/** 점장 신뢰도(0~100). 아직 만난 적 없으면 기본값 50. */
export function managerTrust(userId: number): number {
  const row = db
    .prepare("SELECT trust FROM npc_state WHERE user_id = ? AND npc = 'manager'")
    .get(userId) as { trust: number } | undefined;
  return row?.trust ?? 50;
}

/** 이 유저가 직장에서 도달한 가장 높은 직급(1=사원). */
export function bestBossRank(userId: number): number {
  const row = db.prepare("SELECT MAX(rank) AS r FROM boss_state WHERE user_id = ?").get(userId) as {
    r: number | null;
  };
  return row.r ?? 1;
}

/**
 * NPC별 하루 1회 이벤트 판정권을 얻는다. 오늘 이미 판정했으면 false — 패널을 여러 번 열어도
 * 확률 판정을 반복해서 이벤트가 사실상 확정으로 뜨는 일이 없게 한다.
 */
export function claimDailyRoll(userId: number, npc: "manager" | "boss"): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO npc_event_rolls (user_id, npc, date) VALUES (?, ?, ?)")
    .run(userId, npc, todayKstDate());
  return Number(res.changes) === 1;
}

export function pickRandom<T>(items: T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
