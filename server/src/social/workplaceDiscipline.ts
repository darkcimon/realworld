// 직장 징계 사다리: 경고 → 감봉 → 정직 → 강등 → 해고.
//
// AI는 기분에 따라 징계할 수 없다. 동료(LLM)가 남길 수 있는 건 하루 몇 번의 "경고 기록"뿐이고,
// 여기서 규칙으로만 단계를 올린다:
//  - 마지막 징계 이후 순경고(경고 - 칭찬/praiseOffset)가 warningsPerStep에 도달하면 한 단계 위로
//  - 하루에 한 단계까지만(몇 분 만에 해고까지 가는 일이 없게)
//  - decayDays 동안 새 경고가 없으면 한 단계 아래로(회복 가능)
// 통보는 그 단계를 내릴 수 있는 서열(차장급/이사·사장)의 동료가 채팅으로 직접 한다.
import { db } from "../db.js";
import { WORKPLACE } from "../economy.js";
import { todayKstDate } from "./lottery.js";
import { demoteForDiscipline, resetBossState } from "./npcBoss.js";
import type { ColleagueDef, OrgChart } from "./orgChart.js";
import { addDays, npcSays, type JobInfo } from "./workplaceStore.js";

const D = WORKPLACE.discipline;
export const STAGE_LABEL: Record<number, string> = { 0: "정상", 1: "감봉", 2: "정직", 3: "강등", 4: "해고" };
const MAX_STAGE = 4;

interface StateRow {
  discipline_level: number;
  discipline_through_id: number;
  last_discipline_date: string | null;
  pay_cut_until: string | null;
  suspended_until: string | null;
}

function getState(userId: number, jobId: number): StateRow {
  db.prepare("INSERT OR IGNORE INTO workplace_state (user_id, job_id) VALUES (?, ?)").run(userId, jobId);
  return db
    .prepare(
      "SELECT discipline_level, discipline_through_id, last_discipline_date, pay_cut_until, suspended_until FROM workplace_state WHERE user_id = ? AND job_id = ?"
    )
    .get(userId, jobId) as unknown as StateRow;
}

function pending(userId: number, jobId: number, throughId: number) {
  const rows = db
    .prepare(
      `SELECT id, kind, reason FROM colleague_actions
       WHERE user_id = ? AND job_id = ? AND id > ? AND kind IN ('praise', 'warning') ORDER BY id`
    )
    .all(userId, jobId, throughId) as { id: number; kind: string; reason: string }[];
  const warnings = rows.filter((r) => r.kind === "warning");
  const praises = rows.length - warnings.length;
  return {
    warnings: warnings.length,
    praises,
    net: Math.max(0, warnings.length - Math.floor(praises / D.praiseOffset)),
    reasons: [...new Set(warnings.slice(-3).map((w) => w.reason))],
    lastId: rows.length ? rows[rows.length - 1].id : throughId,
  };
}

// ── 다른 모듈이 쓰는 조회 ─────────────────────────────────────────────
/** 정직 중이면 정직 마지막 날(KST)을, 아니면 null. */
export function suspendedUntil(userId: number, jobId: number, today = todayKstDate()): string | null {
  const row = db.prepare("SELECT suspended_until FROM workplace_state WHERE user_id = ? AND job_id = ?").get(userId, jobId) as
    | { suspended_until: string | null }
    | undefined;
  return row?.suspended_until && row.suspended_until >= today ? row.suspended_until : null;
}

/** 정산 시 곱할 감봉 배수(감봉 중이 아니면 1). */
export function payCutMultiplier(userId: number, jobId: number, today = todayKstDate()): number {
  const row = db.prepare("SELECT pay_cut_until FROM workplace_state WHERE user_id = ? AND job_id = ?").get(userId, jobId) as
    | { pay_cut_until: string | null }
    | undefined;
  return row?.pay_cut_until && row.pay_cut_until >= today ? D.payCutMultiplier : 1;
}

/** 해고 후 재입사 금지 중이면 금지 마지막 날을, 아니면 null. */
export function rehireBannedUntil(userId: number, jobId: number, today = todayKstDate()): string | null {
  const row = db.prepare("SELECT until FROM job_bans WHERE user_id = ? AND job_id = ?").get(userId, jobId) as
    | { until: string }
    | undefined;
  return row && row.until >= today ? row.until : null;
}

export function activeBans(userId: number, today = todayKstDate()): { jobName: string; until: string }[] {
  return db
    .prepare("SELECT j.name AS jobName, b.until FROM job_bans b JOIN jobs j ON j.id = b.job_id WHERE b.user_id = ? AND b.until >= ?")
    .all(userId, today) as { jobName: string; until: string }[];
}

export function disciplineStatus(userId: number, jobId: number, today = todayKstDate()) {
  const state = getState(userId, jobId);
  const p = pending(userId, jobId, state.discipline_through_id);
  const next = Math.min(MAX_STAGE, state.discipline_level + 1);
  return {
    level: state.discipline_level,
    label: STAGE_LABEL[state.discipline_level],
    netWarnings: p.net,
    warningsPerStep: D.warningsPerStep,
    nextLabel: STAGE_LABEL[next],
    payCutUntil: state.pay_cut_until && state.pay_cut_until >= today ? state.pay_cut_until : null,
    suspendedUntil: state.suspended_until && state.suspended_until >= today ? state.suspended_until : null,
  };
}

/** 프롬프트용 한 줄 요약(동료가 징계 현황을 알고 말하게). */
export function disciplineSummary(userId: number, jobId: number): string {
  const s = disciplineStatus(userId, jobId);
  const parts = [`징계 단계 ${s.label}`, `누적 경고 ${s.netWarnings}/${s.warningsPerStep}(다 차면 ${s.nextLabel})`];
  if (s.payCutUntil) parts.push(`${s.payCutUntil}까지 감봉 중`);
  if (s.suspendedUntil) parts.push(`${s.suspendedUntil}까지 정직 중`);
  return parts.join(", ");
}

export function disciplineRules(): string[] {
  return [
    `경고가 ${D.warningsPerStep}회 쌓일 때마다 징계가 한 단계씩 올라가요: 감봉(${D.payCutDays}일간 일급 ×${D.payCutMultiplier}) → 정직(${D.suspensionDays}일 근무 불가) → 강등(한 직급) → 해고(${D.rehireBanDays}일 재입사 불가)`,
    `칭찬 ${D.praiseOffset}회가 경고 1회를 상쇄하고, 징계는 하루에 한 단계까지만 올라가요`,
    `${D.decayDays}일 동안 새 경고가 없으면 징계 단계가 하나 내려가요`,
    "감봉·정직은 차장급 이상, 강등·해고는 이사/사장이 통보해요(작은 회사는 사장이 모두 결정)",
    "업무 지시를 기한 안에 못 끝내면 지시한 사람이 경고를 남겨요",
  ];
}

// ── 판정 ────────────────────────────────────────────────────────────
/** 이 단계를 통보할 사람: 필요한 서열 이상 중 가장 낮은 사람, 없으면 조직에서 가장 높은 사람. */
function authorityFor(org: OrgChart, stage: number): ColleagueDef {
  const need = D.authority[stage] ?? 4;
  const eligible = org.colleagues.filter((c) => c.level >= need).sort((a, b) => a.level - b.level);
  return eligible[0] ?? [...org.colleagues].sort((a, b) => b.level - a.level)[0];
}

export interface DisciplineResult {
  stage: number;
  label: string;
  by: string; // "이름 직함"
  fired: boolean;
}

/**
 * 누적 경고로 징계 단계를 올리거나(하루 1단계), 오래 깨끗했으면 내린다. 이번 호출로 새 징계가 내려졌으면
 * 그 결과를, 아니면 null을 돌려준다. 근무 패널을 열 때와 동료가 경고를 남긴 직후에 부른다.
 */
export function evaluateDiscipline(userId: number, job: JobInfo, org: OrgChart, today = todayKstDate()): DisciplineResult | null {
  const state = getState(userId, job.id);
  const p = pending(userId, job.id, state.discipline_through_id);

  if (p.net < D.warningsPerStep) {
    // 회복: 마지막 징계(또는 회복) 후 decayDays 동안 새 경고가 없으면 한 단계 아래로
    if (
      state.discipline_level > 0 &&
      p.warnings === 0 &&
      state.last_discipline_date &&
      addDays(state.last_discipline_date, D.decayDays) <= today
    ) {
      db.prepare("UPDATE workplace_state SET discipline_level = ?, last_discipline_date = ? WHERE user_id = ? AND job_id = ?").run(
        state.discipline_level - 1,
        today,
        userId,
        job.id
      );
    }
    return null;
  }
  if (state.last_discipline_date === today) return null; // 하루 1단계

  const stage = Math.min(MAX_STAGE, state.discipline_level + 1);
  const by = authorityFor(org, stage);
  const why = p.reasons.join(", ") || "근무 태도 문제";
  let text: string;

  if (stage === 4) {
    db.prepare("UPDATE job_assignments SET active = 0 WHERE user_id = ? AND job_id = ? AND active = 1").run(userId, job.id);
    db.prepare("INSERT OR REPLACE INTO job_bans (user_id, job_id, until) VALUES (?, ?, ?)").run(
      userId,
      job.id,
      addDays(today, D.rehireBanDays - 1)
    );
    db.prepare("UPDATE work_tasks SET status = 'cancelled', resolved_at = datetime('now') WHERE user_id = ? AND job_id = ? AND status = 'open'").run(
      userId,
      job.id
    );
    resetBossState(userId, job.id);
    // 재입사하면 새 출발: 단계는 0으로, 지금까지의 경고는 이미 반영된 것으로 둔다(재입사 즉시 징계 방지).
    db.prepare(
      `UPDATE workplace_state SET discipline_level = 0, discipline_through_id = ?, last_discipline_date = NULL,
         pay_cut_until = NULL, suspended_until = NULL WHERE user_id = ? AND job_id = ?`
    ).run(p.lastId, userId, job.id);
    text = `여러 번 기회를 드렸지만(${why}) 더는 함께하기 어렵겠습니다. 오늘부로 해고입니다. ${D.rehireBanDays}일 동안은 우리 회사에 다시 지원할 수 없어요.`;
  } else {
    const upd: Partial<StateRow> = {};
    if (stage === 1) {
      upd.pay_cut_until = addDays(today, D.payCutDays - 1);
      text = `경고가 ${D.warningsPerStep}회 쌓였습니다(${why}). 규정에 따라 ${upd.pay_cut_until}까지 감봉(일급 ×${D.payCutMultiplier}) 처분합니다. 앞으로 조심해 주세요.`;
    } else if (stage === 2) {
      upd.suspended_until = addDays(today, D.suspensionDays - 1);
      text = `감봉 이후에도 경고가 이어졌네요(${why}). ${upd.suspended_until}까지 정직입니다. 그동안은 출근하지 마세요.`;
    } else {
      const r = demoteForDiscipline(userId, job.id);
      text =
        r.from === r.to
          ? `정직 이후에도 개선이 없습니다(${why}). 더 내릴 직급이 없어 이번이 마지막 경고입니다. 한 번 더 이러면 함께할 수 없어요.`
          : `인사 결과를 전합니다. 정직 이후에도 개선이 없어(${why}) ${r.from} → ${r.to} 강등입니다. 다음은 해고예요.`;
    }
    db.prepare(
      `UPDATE workplace_state SET discipline_level = ?, discipline_through_id = ?, last_discipline_date = ?,
         pay_cut_until = COALESCE(?, pay_cut_until), suspended_until = COALESCE(?, suspended_until)
       WHERE user_id = ? AND job_id = ?`
    ).run(stage, p.lastId, today, upd.pay_cut_until ?? null, upd.suspended_until ?? null, userId, job.id);
  }

  db.prepare("INSERT INTO workplace_disciplines (user_id, job_id, colleague_key, stage, reason) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    job.id,
    by.key,
    stage,
    why
  );
  npcSays(userId, job.id, by, text);
  return { stage, label: STAGE_LABEL[stage], by: `${by.name} ${by.title}`, fired: stage === 4 };
}
