// README 6.1~6.2: 직업 배정 & 근무(5문제 단위 출제 → 잔업/퇴근 선택 → 자정 정산 지급).
import { db } from "../db.js";
import { aiProvider } from "../ai/index.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { isSTier } from "../middleware/socialGate.js";
import { buildChoices } from "../ai/choices.js";
import { notify } from "./notifications.js";
import { rankPayMultiplier } from "./npcBoss.js";

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

export function startWork(userId: number): {
  sessionId: number;
  questionNo: number;
  batchNo: number;
  question: string;
  choices: string[];
} {
  const assignment = activeAssignment(userId);
  if (!assignment) throw { status: 400, message: "먼저 직업을 배정받아야 합니다." };

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
    // 배치 도중 재접속(서버 재시작 등으로 pendingBatches 캐시가 비었을 때):
    // 남은 문제를 새로 뽑아 캐시에 채워 넣고, submitWorkAnswer가 동일한 문제를 채점하게 한다.
    const last = attempts[attempts.length - 1];
    const batchNo = last.batch_no;
    const batch = aiProvider.getWorkQuestions();
    pendingBatches.set(session.id, batch);
    const indexInBatch = attempts.length % BATCH_SIZE;
    return {
      sessionId: session.id,
      questionNo: indexInBatch + 1,
      batchNo,
      question: batch[indexInBatch].question,
      choices: buildChoices(batch[indexInBatch], batch),
    };
  }

  // 새 배치를 뽑는다. work_attempts에는 answer 제출 시점에 기록하고, 그 전까지는
  // 다음 submitWorkAnswer 호출이 참조할 수 있도록 pendingBatches에 임시로 들고 있는다.
  const batchNo = Math.floor(attempts.length / BATCH_SIZE) + 1;
  const questions = aiProvider.getWorkQuestions();
  pendingBatches.set(session.id, questions);
  return {
    sessionId: session.id,
    questionNo: 1,
    batchNo,
    question: questions[0].question,
    choices: buildChoices(questions[0], questions),
  };
}

// 진행 중인 배치의 문제 목록(질문+정답)을 세션 단위로 잠깐 들고 있는다.
// work_sessions/work_attempts는 "정답 텍스트"까지 영구 보관하므로, 서버 재시작 시에는
// 이 캐시가 비어도 마지막 저장된 문제로 이어갈 수 있게 startWork에서 재구성한다.
const pendingBatches = new Map<number, ReturnType<typeof aiProvider.getWorkQuestions>>();

export function submitWorkAnswer(
  userId: number,
  sessionId: number,
  answer: string
): {
  correct: boolean;
  questionNo: number;
  batchNo: number;
  batchComplete: boolean;
  nextQuestion?: string;
  nextChoices?: string[];
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

  let batch = pendingBatches.get(sessionId);
  if (!batch) {
    // 서버 재시작 등으로 캐시가 비어 있으면 새 배치를 뽑아 이어간다(첫 문제인 경우에 한함).
    batch = aiProvider.getWorkQuestions();
    pendingBatches.set(sessionId, batch);
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

  const batchComplete = indexInBatch + 1 === BATCH_SIZE;
  if (batchComplete) {
    pendingBatches.delete(sessionId);
    db.prepare("UPDATE work_sessions SET awaiting_decision = 1 WHERE id = ?").run(sessionId);
    return { correct, questionNo: indexInBatch + 1, batchNo, batchComplete: true };
  }

  return {
    correct,
    questionNo: indexInBatch + 1,
    batchNo,
    batchComplete: false,
    nextQuestion: batch[indexInBatch + 1].question,
    nextChoices: buildChoices(batch[indexInBatch + 1], batch),
  };
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
 * 지급액은 job.pay_min ~ pay_max 사이를 정답률에 비례해 산정한다.
 */
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
  for (const session of sessions) {
    const attempts = attemptsFor(session.id);
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(session.job_id) as unknown as JobRow;
    let pay = 0;
    if (attempts.length > 0) {
      // 실제 근무를 수행한 경우에만 지급
      const ratio = session.correct_count / attempts.length;
      // 직급(직장 상사 승진)에 따른 일급 배수를 곱한다. 직급은 직업별로 따로 쌓인다.
      const rankMult = rankPayMultiplier(userId, session.job_id);
      if (rankMult !== 1) hadRankBonus = true;
      pay = Math.round((job.pay_min + (job.pay_max - job.pay_min) * ratio) * rankMult);
      applyLedgerEntry(userId, "일급", pay, session.id);
    }
    db.prepare("UPDATE work_sessions SET paid = 1 WHERE id = ?").run(session.id);
    totalPaid += pay;
    settledSessions += 1;
  }
  if (totalPaid > 0) {
    notify(userId, "salary", `💰 월급 ${totalPaid.toLocaleString()}원이 지급되었어요! (${settledSessions}건 정산${hadRankBonus ? ", 직급 배수 반영" : ""})`);
  }
  return { settledSessions, totalPaid };
}
