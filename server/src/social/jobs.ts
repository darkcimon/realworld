// README 6.1~6.2: 직업 배정 & 근무(5문제 단위 출제 → 잔업/퇴근 선택 → 자정 정산 지급).
import { db } from "../db.js";
import { aiProvider } from "../ai/index.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { educationOf, isSTier } from "./education.js";
import { buildChoices } from "../ai/choices.js";
import type { ExamQuestion } from "../ai/AIProvider.js";
import { drawWorkBatch } from "./workQuestions.js";
import { notify } from "./notifications.js";
import { rankPayMultiplier } from "./npcBoss.js";
import { payCutMultiplier, rehireBannedUntil, suspendedUntil } from "./workplaceDiscipline.js";
import { VITALS, WORK_PAY } from "../economy.js";
import { assertCanWork, spendWorkStamina } from "./vitals.js";

const BATCH_SIZE = 5;

export interface JobRow {
  id: number;
  name: string;
  tier: "S" | "all";
  pay_min: number;
  pay_max: number;
}

export function listJobsFor(userId: number): JobRow[] {
  const jobs = db.prepare("SELECT * FROM jobs").all() as unknown as JobRow[];
  const eligibleForS = isSTier(userId);
  return jobs.filter((j) => j.tier === "all" || eligibleForS);
}

export function assignJob(userId: number, jobId: number): JobRow {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as unknown as
    | JobRow
    | undefined;
  if (!job) throw { status: 404, message: "존재하지 않는 직업입니다." };
  if (job.tier === "S" && !isSTier(userId)) {
    throw { status: 403, message: "S등급 졸업생만 배정받을 수 있는 직업입니다." };
  }
  const bannedUntil = rehireBannedUntil(userId, jobId);
  if (bannedUntil) {
    throw { status: 403, message: `해고된 회사라 ${bannedUntil}까지는 다시 입사할 수 없습니다.` };
  }
  db.prepare("UPDATE job_assignments SET active = 0 WHERE user_id = ? AND active = 1").run(
    userId
  );
  db.prepare("INSERT INTO job_assignments (user_id, job_id) VALUES (?, ?)").run(userId, jobId);
  return job;
}

function activeAssignment(userId: number): { job_id: number } | undefined {
  return db
    .prepare(
      "SELECT * FROM job_assignments WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1"
    )
    .get(userId) as { job_id: number } | undefined;
}

function openSession(userId: number): any {
  return db
    .prepare(
      "SELECT * FROM work_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .get(userId);
}

function attemptsFor(sessionId: number): any[] {
  return db
    .prepare("SELECT * FROM work_attempts WHERE session_id = ? ORDER BY id")
    .all(sessionId) as any[];
}

// 진행 중인 배치: 메모리 캐시 + DB(work_sessions.pending_batch). 재시작 후에도 같은 문제로 채점한다.
const pendingBatches = new Map<number, ExamQuestion[]>();

function saveBatch(sessionId: number, batch: ExamQuestion[] | null): void {
  if (batch) pendingBatches.set(sessionId, batch);
  else pendingBatches.delete(sessionId);
  db.prepare("UPDATE work_sessions SET pending_batch = ? WHERE id = ?").run(batch ? JSON.stringify(batch) : null, sessionId);
}

function loadBatch(sessionId: number): ExamQuestion[] | null {
  const cached = pendingBatches.get(sessionId);
  if (cached) return cached;
  const row = db.prepare("SELECT pending_batch FROM work_sessions WHERE id = ?").get(sessionId) as
    | { pending_batch: string | null }
    | undefined;
  if (!row?.pending_batch) return null;
  const batch = JSON.parse(row.pending_batch) as ExamQuestion[];
  pendingBatches.set(sessionId, batch);
  return batch;
}

function view(q: ExamQuestion, batch: ExamQuestion[]) {
  return { question: q.question, choices: buildChoices(q, batch), choiceOnly: !!q.choiceOnly };
}

export function startWork(userId: number): {
  sessionId: number;
  questionNo: number;
  batchNo: number;
  question: string;
  choices: string[];
  choiceOnly: boolean;
} {
  const assignment = activeAssignment(userId);
  if (!assignment) throw { status: 400, message: "먼저 직업을 배정받아야 합니다." };
  const suspended = suspendedUntil(userId, assignment.job_id);
  if (suspended) throw { status: 403, message: `정직 중입니다. ${suspended}까지는 출근할 수 없어요.` };

  let session = openSession(userId);
  if (session && session.awaiting_decision) {
    throw {
      status: 409,
      message: "잔업/퇴근을 먼저 선택해야 다음 근무를 시작할 수 있습니다.",
    };
  }
  if (!session) {
    const result = db
      .prepare("INSERT INTO work_sessions (user_id, job_id) VALUES (?, ?)")
      .run(userId, assignment.job_id);
    session = { id: Number(result.lastInsertRowid) };
  }

  const attempts = attemptsFor(session.id);
  if (attempts.length % BATCH_SIZE !== 0) {
    // 배치 도중 재접속: 저장해 둔 배치에서 이어서 낸다(없으면 예전 데이터이므로 새로 뽑는다).
    const last = attempts[attempts.length - 1];
    const batchNo = last.batch_no;
    let batch = loadBatch(session.id);
    if (!batch) {
      batch = drawWorkBatch(assignment.job_id);
      saveBatch(session.id, batch);
    }
    const indexInBatch = attempts.length % BATCH_SIZE;
    return { sessionId: session.id, questionNo: indexInBatch + 1, batchNo, ...view(batch[indexInBatch], batch) };
  }

  // 새 배치는 체력이 있어야 시작할 수 있다(배치 도중 재접속은 위에서 이어서 풀게 한다).
  assertCanWork(userId);

  // 새 배치: 직업별 계산형 문제 + 검증된 상황 판단 문제(workQuestions.ts). 답을 낼 때까지 세션에 저장해 둔다.
  const batchNo = Math.floor(attempts.length / BATCH_SIZE) + 1;
  const questions = drawWorkBatch(assignment.job_id);
  saveBatch(session.id, questions);
  return { sessionId: session.id, questionNo: 1, batchNo, ...view(questions[0], questions) };
}

export function submitWorkAnswer(
  userId: number,
  sessionId: number,
  answer: string
): {
  correct: boolean;
  questionNo: number;
  batchNo: number;
  batchComplete: boolean;
  correctAnswer: string;
  explanation: string;
  nextQuestion?: string;
  nextChoices?: string[];
  nextChoiceOnly?: boolean;
} {
  const session = db
    .prepare("SELECT * FROM work_sessions WHERE id = ? AND user_id = ?")
    .get(sessionId, userId) as any;
  if (!session || session.ended_at) throw { status: 400, message: "진행 중인 근무가 없습니다." };
  if (session.awaiting_decision) {
    throw { status: 409, message: "잔업/퇴근을 먼저 선택해야 합니다." };
  }

  const attempts = attemptsFor(sessionId);
  const indexInBatch = attempts.length % BATCH_SIZE;
  const batchNo = Math.floor(attempts.length / BATCH_SIZE) + 1;

  let batch = loadBatch(sessionId);
  if (!batch) {
    // 저장된 배치가 없는 예전 세션이면 새 배치를 뽑아 이어간다.
    batch = drawWorkBatch(session.job_id);
    saveBatch(sessionId, batch);
  }
  const question = batch[indexInBatch];

  const correct = aiProvider.gradeAnswer(question, answer);
  db.prepare(
    "INSERT INTO work_attempts (session_id, batch_no, question_no, question, answer, correct) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(sessionId, batchNo, indexInBatch + 1, question.question, answer, correct ? 1 : 0);

  if (correct) {
    db.prepare("UPDATE work_sessions SET correct_count = correct_count + 1 WHERE id = ?").run(
      sessionId
    );
  }
  // 근무 시간(문제 1개 = workMinutes.jobQuestion분)만큼 체력이 준다.
  spendWorkStamina(userId, VITALS.workMinutes.jobQuestion);

  // 틀려도 바로 정답과 이유를 보여준다(상황 판단 문제는 특히 "왜"를 알아야 다음에 맞힌다).
  const feedback = {
    correct,
    questionNo: indexInBatch + 1,
    batchNo,
    correctAnswer: question.answer,
    explanation: question.explanation,
  };
  const batchComplete = indexInBatch + 1 === BATCH_SIZE;
  if (batchComplete) {
    saveBatch(sessionId, null);
    db.prepare("UPDATE work_sessions SET awaiting_decision = 1 WHERE id = ?").run(sessionId);
    return { ...feedback, batchComplete: true };
  }

  const next = view(batch[indexInBatch + 1], batch);
  return {
    ...feedback,
    batchComplete: false,
    nextQuestion: next.question,
    nextChoices: next.choices,
    nextChoiceOnly: next.choiceOnly,
  };
}

/** 새로고침 후에도 화면이 잔업/퇴근 선택 대기 상태를 복원할 수 있게 현재 근무 상태를 알려준다. */
export function workStatus(userId: number): { sessionId: number | null; awaitingDecision: boolean } {
  const session = openSession(userId);
  return { sessionId: session?.id ?? null, awaitingDecision: !!session?.awaiting_decision };
}

export function continueOrLeaveWork(
  userId: number,
  sessionId: number,
  wantsContinue: boolean
): { ok: true; ended: boolean } {
  const session = db
    .prepare("SELECT * FROM work_sessions WHERE id = ? AND user_id = ?")
    .get(sessionId, userId) as any;
  if (!session || session.ended_at) throw { status: 400, message: "진행 중인 근무가 없습니다." };
  if (!session.awaiting_decision) {
    throw { status: 400, message: "아직 잔업/퇴근을 선택할 시점이 아닙니다." };
  }

  if (wantsContinue) {
    db.prepare("UPDATE work_sessions SET awaiting_decision = 0 WHERE id = ?").run(sessionId);
    return { ok: true, ended: false };
  }

  db.prepare(
    "UPDATE work_sessions SET awaiting_decision = 0, ended_at = datetime('now') WHERE id = ?"
  ).run(sessionId);
  return { ok: true, ended: true };
}

/**
 * 자정 배치(cron)가 호출하는 정산 함수. "실제 근무 수행 여부"(문제를 실제로 풀었는지,
 * work_attempts가 1건 이상 있는지)를 확인한 뒤에만 일급을 지급한다.
 * 5문제 배치마다 job.pay_min ~ pay_max 사이를 그 배치 정답률에 비례해 산정하고,
 * 첫 배치(기본 근무) 뒤의 배치는 잔업이라 WORK_PAY.overtimeMultiplier를 곱해 더한다.
 * 5문제를 모두 맞힌 배치마다 pay_min을 보너스로 따로 지급한다.
 */
function sessionPay(attempts: any[], job: JobRow): { base: number; overtime: number; bonus: number; overtimeBatches: number; perfectBatches: number } {
  const byBatch = new Map<number, { total: number; correct: number }>();
  for (const a of attempts) {
    const b = byBatch.get(a.batch_no) ?? { total: 0, correct: 0 };
    b.total += 1;
    if (a.correct) b.correct += 1;
    byBatch.set(a.batch_no, b);
  }
  let base = 0;
  let overtime = 0;
  let bonus = 0;
  let overtimeBatches = 0;
  let perfectBatches = 0;
  const firstBatch = Math.min(...byBatch.keys());
  for (const [batchNo, b] of byBatch) {
    const wage = job.pay_min + (job.pay_max - job.pay_min) * (b.correct / b.total);
    if (batchNo === firstBatch) {
      base += wage;
    } else {
      overtime += wage * WORK_PAY.overtimeMultiplier;
      overtimeBatches += 1;
    }
    if (WORK_PAY.perfectBonus && b.total === BATCH_SIZE && b.correct === BATCH_SIZE) {
      bonus += job.pay_min;
      perfectBatches += 1;
    }
  }
  return { base, overtime, bonus, overtimeBatches, perfectBatches };
}

export function settleUnpaidWork(userId: number): {
  settledSessions: number;
  totalPaid: number;
} {
  const sessions = db
    .prepare(
      "SELECT * FROM work_sessions WHERE user_id = ? AND ended_at IS NOT NULL AND paid = 0"
    )
    .all(userId) as any[];

  let totalPaid = 0;
  let settledSessions = 0;
  let hadRankBonus = false;
  let hadPayCut = false;
  let overtimeBatches = 0;
  // 학력(학교 졸업장)에 따른 일급 배수 — 정산 시점의 최종 학력 기준. 직급 배수처럼 만점 보너스에도 곱한다.
  const eduMult = educationOf(userId).payMultiplier;
  let perfectBatches = 0;
  for (const session of sessions) {
    const attempts = attemptsFor(session.id);
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(session.job_id) as unknown as JobRow;
    let pay = 0;
    if (attempts.length > 0) {
      // 실제 근무를 수행한 경우에만 지급
      const p = sessionPay(attempts, job);
      overtimeBatches += p.overtimeBatches;
      perfectBatches += p.perfectBatches;
      // 직급(직장 상사 승진)에 따른 일급 배수를 곱한다. 직급은 직업별로 따로 쌓인다.
      const rankMult = rankPayMultiplier(userId, session.job_id);
      if (rankMult !== 1) hadRankBonus = true;
      // 징계 "감봉" 기간이면 일급을 깎는다(정산 시점 기준).
      // 만점 보너스에는 직급 배수만 곱하고 감봉은 적용하지 않는다.
      const cutMult = payCutMultiplier(userId, session.job_id);
      if (cutMult !== 1) hadPayCut = true;
      pay = Math.round(((p.base + p.overtime) * rankMult * cutMult + p.bonus * rankMult) * eduMult);
      applyLedgerEntry(userId, "일급", pay, session.id);
    }
    db.prepare("UPDATE work_sessions SET paid = 1 WHERE id = ?").run(session.id);
    totalPaid += pay;
    settledSessions += 1;
  }
  if (totalPaid > 0) {
    notify(userId, "salary", `💰 월급 ${totalPaid.toLocaleString()}원이 지급되었어요! (${settledSessions}건 정산${overtimeBatches > 0 ? `, 잔업 ${overtimeBatches}회 ×${WORK_PAY.overtimeMultiplier}` : ""}${perfectBatches > 0 ? `, 만점 보너스 ${perfectBatches}회` : ""}${hadRankBonus ? ", 직급 배수 반영" : ""}${eduMult !== 1 ? `, 학력 ×${eduMult}` : ""}${hadPayCut ? ", 감봉 반영" : ""})`);
  }
  return { settledSessions, totalPaid };
}
