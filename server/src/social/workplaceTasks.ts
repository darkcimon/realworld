// 업무 지시와 마감: 상사가 먼저 말을 걸어 측정 가능한 업무를 기한과 함께 맡긴다.
//  - 하루 1회 판정(WORKPLACE.taskChance), 진행 중인 지시가 없고 정직 중이 아닐 때만 새로 내려온다.
//  - 목표(문제 수 / 정답률 / 잔업)는 지시 시각 이후의 근무 기록으로 서버가 직접 잰다.
//  - 완료: 칭찬 기록 + 신뢰↑ (+ 과장급 이상이 지시했으면 보너스) / 기한 초과: 경고 기록 + 신뢰↓
// 근무 패널을 열 때 "그때 한 번" 판정한다(별도 스케줄러 없음 — npcBoss와 같은 방식).
import { db } from "../db.js";
import { WORKPLACE } from "../economy.js";
import { todayKstDate } from "./lottery.js";
import { claimDailyRoll, pickRandom } from "./npcShared.js";
import type { ColleagueDef, OrgChart } from "./orgChart.js";
import { suspendedUntil } from "./workplaceDiscipline.js";
import { addDays, adjustTrust, npcSays, payBonus, recordAction, type JobInfo } from "./workplaceStore.js";

type TaskKind = "attempts" | "accuracy" | "overtime";

interface TaskRow {
  id: number;
  job_id: number;
  colleague_key: string;
  kind: TaskKind;
  goal: number;
  accuracy: number;
  issued_at: string;
  due_date: string;
  status: "open" | "done" | "failed" | "cancelled";
}

function describe(t: Pick<TaskRow, "kind" | "goal" | "accuracy">): string {
  if (t.kind === "attempts") return `문제 ${t.goal}개 처리`;
  if (t.kind === "accuracy") return `문제 ${t.goal}개 이상, 정답률 ${Math.round(t.accuracy * 100)}% 이상`;
  return `잔업 ${t.goal}회`;
}

function progressOf(userId: number, t: TaskRow) {
  const base = db
    .prepare(
      `SELECT COUNT(*) AS attempts, COALESCE(SUM(a.correct), 0) AS correct
       FROM work_attempts a JOIN work_sessions s ON s.id = a.session_id
       WHERE s.user_id = ? AND s.job_id = ? AND a.created_at >= ?`
    )
    .get(userId, t.job_id, t.issued_at) as { attempts: number; correct: number };
  // 잔업: 지시 이후 기록에서, 한 근무(세션)당 첫 배치를 넘겨 더 한 배치 수
  const ot = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN b > 1 THEN b - 1 ELSE 0 END), 0) AS overtime FROM (
         SELECT COUNT(DISTINCT a.batch_no) AS b
         FROM work_sessions s JOIN work_attempts a ON a.session_id = s.id
         WHERE s.user_id = ? AND s.job_id = ? AND a.created_at >= ?
         GROUP BY s.id
       )`
    )
    .get(userId, t.job_id, t.issued_at) as { overtime: number };
  return {
    attempts: base.attempts,
    accuracy: base.attempts ? base.correct / base.attempts : 0,
    overtime: ot.overtime,
  };
}

function isMet(t: TaskRow, p: ReturnType<typeof progressOf>): boolean {
  if (t.kind === "attempts") return p.attempts >= t.goal;
  if (t.kind === "accuracy") return p.attempts >= t.goal && p.accuracy >= t.accuracy;
  return p.overtime >= t.goal;
}

function finish(id: number, status: TaskRow["status"]): void {
  db.prepare("UPDATE work_tasks SET status = ?, resolved_at = datetime('now') WHERE id = ?").run(status, id);
}

/** 진행 중인 지시를 판정한다(달성 → 완료, 기한 초과 → 실패). 다른 회사의 지시는 취소한다. */
export function resolveTasks(userId: number, job: JobInfo, org: OrgChart, today = todayKstDate()): void {
  db.prepare(
    "UPDATE work_tasks SET status = 'cancelled', resolved_at = datetime('now') WHERE user_id = ? AND job_id != ? AND status = 'open'"
  ).run(userId, job.id);

  const open = db
    .prepare("SELECT * FROM work_tasks WHERE user_id = ? AND job_id = ? AND status = 'open'")
    .all(userId, job.id) as unknown as TaskRow[];
  for (const t of open) {
    const issuer = org.colleagues.find((c) => c.key === t.colleague_key);
    if (!issuer) {
      finish(t.id, "cancelled");
      continue;
    }
    const desc = describe(t);
    if (isMet(t, progressOf(userId, t))) {
      finish(t.id, "done");
      recordAction(userId, job.id, issuer.key, { type: "praise", value: 0, reason: `업무 완료: ${desc}` });
      adjustTrust(userId, job.id, issuer.key, WORKPLACE.taskTrust);
      const bonus =
        issuer.level >= WORKPLACE.bonusMinLevel
          ? payBonus(userId, job, issuer, job.pay_max * WORKPLACE.taskBonusRatio, `업무 완료: ${desc}`)
          : 0;
      npcSays(
        userId,
        job.id,
        issuer,
        `부탁한 ${desc}, 확인했어요. 수고했어요.${bonus > 0 ? ` 보너스 ${bonus.toLocaleString()}원 넣어뒀어요.` : ""}`
      );
    } else if (today > t.due_date) {
      finish(t.id, "failed");
      recordAction(userId, job.id, issuer.key, { type: "warning", value: 0, reason: `업무 기한 미준수: ${desc}` });
      adjustTrust(userId, job.id, issuer.key, WORKPLACE.taskFailTrust);
      npcSays(userId, job.id, issuer, `${t.due_date}까지 부탁한 ${desc}, 결국 못 끝냈네요. 경고로 남겨두겠습니다.`);
    }
  }
}

/** 하루 1회 판정으로 새 업무를 지시한다. 지시했으면 true. */
export function maybeIssueTask(
  userId: number,
  job: JobInfo,
  org: OrgChart,
  today = todayKstDate(),
  rng: () => number = Math.random
): boolean {
  const hasOpen = db.prepare("SELECT 1 FROM work_tasks WHERE user_id = ? AND job_id = ? AND status = 'open' LIMIT 1").get(userId, job.id);
  if (hasOpen || suspendedUntil(userId, job.id, today)) return false;
  if (!claimDailyRoll(userId, "workplace")) return false;
  if (rng() >= WORKPLACE.taskChance) return false;

  // 지시하는 사람: 직속 상사가 가장 자주, 대기업이면 차장·이사도 가끔
  const issuers: ColleagueDef[] = org.colleagues.flatMap((c) => (c.directBoss ? [c, c] : c.level >= 2 ? [c] : []));
  const issuer = pickRandom(issuers.length ? issuers : org.colleagues, rng);
  const kind = pickRandom<TaskKind>(["attempts", "accuracy", "overtime"], rng);
  const goal =
    kind === "attempts"
      ? pickRandom(WORKPLACE.taskAttemptGoals, rng)
      : kind === "accuracy"
        ? WORKPLACE.taskAccuracy.attempts
        : WORKPLACE.taskOvertimeGoal;
  const accuracy = kind === "accuracy" ? WORKPLACE.taskAccuracy.accuracy : 0;
  const due = addDays(today, WORKPLACE.taskDueDays);

  db.prepare(
    "INSERT INTO work_tasks (user_id, job_id, colleague_key, kind, goal, accuracy, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, job.id, issuer.key, kind, goal, accuracy, due);

  const desc = describe({ kind, goal, accuracy });
  const line =
    kind === "attempts"
      ? `일이 좀 밀렸어요. ${due}까지 ${desc} 부탁해요.`
      : kind === "accuracy"
        ? `요즘 실수가 보여서요. ${due}까지 ${desc}로 처리해 주세요.`
        : `마감이 코앞이에요. ${due}까지 ${desc} 해줄 수 있죠?`;
  npcSays(userId, job.id, issuer, `[업무 지시] ${line}`);
  return true;
}

export function openTask(userId: number, job: JobInfo, org: OrgChart) {
  const t = db
    .prepare("SELECT * FROM work_tasks WHERE user_id = ? AND job_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .get(userId, job.id) as unknown as TaskRow | undefined;
  if (!t) return null;
  const issuer = org.colleagues.find((c) => c.key === t.colleague_key);
  const p = progressOf(userId, t);
  return {
    id: t.id,
    issuer: issuer ? { key: issuer.key, name: issuer.name, title: issuer.title, avatar: issuer.avatar } : null,
    kind: t.kind,
    description: describe(t),
    goal: t.goal,
    targetAccuracy: Math.round(t.accuracy * 100),
    dueDate: t.due_date,
    progress: { attempts: p.attempts, accuracy: Math.round(p.accuracy * 100), overtime: p.overtime },
  };
}

/** 프롬프트용: 진행 중인 지시 한 줄 요약. */
export function taskSummary(userId: number, job: JobInfo, org: OrgChart): string {
  const t = openTask(userId, job, org);
  if (!t) return "진행 중인 업무 지시 없음";
  const who = t.issuer ? `${t.issuer.name} ${t.issuer.title}` : "상사";
  return `${who}가 지시한 업무 "${t.description}"(기한 ${t.dueDate}) 진행 중: 지금까지 문제 ${t.progress.attempts}개, 정답률 ${t.progress.accuracy}%, 잔업 ${t.progress.overtime}회`;
}
