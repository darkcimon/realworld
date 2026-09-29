// 직장 동료 기능(workplace / workplaceTasks / workplaceDiscipline)이 함께 쓰는 DB 접근 함수.
// 판단 로직은 없고, "기록하고 읽는" 일만 한다.
import { db } from "../db.js";
import { WORKPLACE } from "../economy.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { notify } from "./notifications.js";
import { todayKstDate } from "./lottery.js";
import type { ColleagueDef } from "./orgChart.js";

export type ActionKind = "praise" | "warning" | "eval_adjust" | "bonus";

export interface AppliedAction {
  type: ActionKind;
  value: number; // eval_adjust: 반영된 점수, bonus: 지급액, 그 외 0
  reason: string;
}

export interface RelationRow {
  trust: number;
  memory: string | null;
  summary_through_id: number;
  last_read_id: number;
}

export interface JobInfo {
  id: number;
  name: string;
  pay_max: number;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function activeJob(userId: number): JobInfo | null {
  const row = db
    .prepare(
      `SELECT j.id, j.name, j.pay_max FROM job_assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.user_id = ? AND a.active = 1 ORDER BY a.id DESC LIMIT 1`
    )
    .get(userId) as JobInfo | undefined;
  return row ?? null;
}

export function getRelation(userId: number, jobId: number, key: string): RelationRow {
  db.prepare(
    "INSERT OR IGNORE INTO colleague_relations (user_id, job_id, colleague_key, trust) VALUES (?, ?, ?, ?)"
  ).run(userId, jobId, key, WORKPLACE.initialTrust);
  return db
    .prepare(
      "SELECT trust, memory, summary_through_id, last_read_id FROM colleague_relations WHERE user_id = ? AND job_id = ? AND colleague_key = ?"
    )
    .get(userId, jobId, key) as unknown as RelationRow;
}

export function setTrust(userId: number, jobId: number, key: string, trust: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(trust)));
  db.prepare("UPDATE colleague_relations SET trust = ? WHERE user_id = ? AND job_id = ? AND colleague_key = ?").run(
    clamped,
    userId,
    jobId,
    key
  );
  return clamped;
}

export function adjustTrust(userId: number, jobId: number, key: string, delta: number): number {
  return setTrust(userId, jobId, key, getRelation(userId, jobId, key).trust + delta);
}

export function insertMessage(userId: number, jobId: number, key: string, sender: "player" | "npc", content: string): number {
  const res = db
    .prepare("INSERT INTO colleague_messages (user_id, job_id, colleague_key, sender, content) VALUES (?, ?, ?, ?, ?)")
    .run(userId, jobId, key, sender, content);
  return Number(res.lastInsertRowid);
}

export function recordAction(userId: number, jobId: number, key: string, action: AppliedAction): void {
  db.prepare(
    "INSERT INTO colleague_actions (user_id, job_id, colleague_key, kind, value, reason) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, jobId, key, action.type, action.value, action.reason);
}

/** NPC가 먼저 말을 건다: 채팅 기록에 남기고(다음 대화의 맥락이 된다) 알림도 보낸다. */
export function npcSays(userId: number, jobId: number, c: ColleagueDef, text: string): void {
  insertMessage(userId, jobId, c.key, "npc", text);
  notify(userId, "npc", `${c.avatar} ${c.name} ${c.title}: ${text}`);
}

export function actionsToday(userId: number, jobId: number, key: string, kind: ActionKind): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM colleague_actions
       WHERE user_id = ? AND job_id = ? AND colleague_key = ? AND kind = ? AND date(created_at, '+9 hours') = ?`
    )
    .get(userId, jobId, key, kind, todayKstDate()) as { c: number };
  return row.c;
}

// ── 보너스 ──────────────────────────────────────────────────────────
function bonusPaidToday(userId: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(value), 0) AS s FROM colleague_actions WHERE user_id = ? AND kind = 'bonus' AND date(created_at, '+9 hours') = ?"
    )
    .get(userId, todayKstDate()) as { s: number };
  return row.s;
}

/** 오늘 더 받을 수 있는 보너스(1000원 단위 내림). 직업 일급 상한 × bonusDailyRatio가 하루 총액 상한. */
export function bonusRoomToday(userId: number, job: JobInfo): number {
  const cap = Math.floor((job.pay_max * WORKPLACE.bonusDailyRatio) / 1000) * 1000;
  return Math.max(0, cap - bonusPaidToday(userId));
}

/**
 * 보너스를 상한 안에서 지급하고 기록한다. 실제 지급액(0이면 지급 안 함)을 돌려준다.
 * 권한(서열/신뢰도) 확인은 호출부 책임이고, 여기서는 금액 상한만 다시 자른다.
 */
export function payBonus(userId: number, job: JobInfo, c: ColleagueDef, want: number, reason: string): number {
  const amount = Math.floor(Math.min(want, bonusRoomToday(userId, job)) / 1000) * 1000;
  if (amount <= 0) return 0;
  applyLedgerEntry(userId, "직장보너스", amount);
  recordAction(userId, job.id, c.key, { type: "bonus", value: amount, reason });
  return amount;
}
