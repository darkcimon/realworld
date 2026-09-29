// 근무 문제 배치 만들기: 직업별 계산형 템플릿(정답은 서버 계산) + LLM이 만든 상황 판단 문제.
//
// 상황 판단 문제는 정답이 틀리면 일급/인사평가가 억울하게 깎이므로 두 번 거른다:
//  1) generateWorkScenarios가 문제·정답을 만들고
//  2) solveWorkScenarios가 정답을 모른 채 따로 풀어서, 둘의 답이 같은 문제만 풀에 넣는다.
// 풀은 직업별로 DB에 쌓아 두고 꺼내 쓰며, 모자라면 백그라운드로 채운다 — 근무 시작은 LLM을 기다리지 않는다.
// 키 없음/월 예산 초과면 풀이 비어 있을 뿐이고, 배치는 계산형 문제로만 채워진다.
import { db } from "../db.js";
import { aiProvider } from "../ai/index.js";
import type { ExamQuestion } from "../ai/AIProvider.js";
import { WORK_QUESTIONS } from "../economy.js";
import { orgChartFor } from "./orgChart.js";
import { templateQuestions } from "./workTemplates.js";

interface PoolRow {
  id: number;
  question: string;
  choices: string;
  answer: string;
  explanation: string;
}

const refilling = new Set<number>();
const lastFailure = new Map<number, number>();

function freshCount(jobId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM work_question_pool WHERE job_id = ? AND uses < ?")
    .get(jobId, WORK_QUESTIONS.maxUses) as { c: number };
  return row.c;
}

/** 풀이 모자라면 백그라운드로 채운다(직업당 동시에 하나, 실패하면 잠시 쉼). */
function maybeRefill(jobId: number, jobName: string): void {
  if (refilling.has(jobId)) return;
  if (Date.now() - (lastFailure.get(jobId) ?? 0) < WORK_QUESTIONS.refillCooldownMs) return;
  if (freshCount(jobId) >= WORK_QUESTIONS.refillBelow) return;
  refilling.add(jobId);
  void refill(jobId, jobName).finally(() => refilling.delete(jobId));
}

export async function refill(jobId: number, jobName: string): Promise<number> {
  const context = { jobName, company: orgChartFor(jobName)?.company ?? jobName };
  try {
    const avoid = (
      db.prepare("SELECT question FROM work_question_pool WHERE job_id = ? ORDER BY id DESC LIMIT 15").all(jobId) as {
        question: string;
      }[]
    ).map((r) => r.question.slice(0, 40));
    const generated = await aiProvider.generateWorkScenarios(context, WORK_QUESTIONS.generateCount, avoid);
    if (generated.length === 0) {
      lastFailure.set(jobId, Date.now());
      return 0;
    }
    const solved = await aiProvider.solveWorkScenarios(
      context,
      generated.map((g) => ({ question: g.question, choices: g.choices }))
    );
    const insert = db.prepare(
      "INSERT INTO work_question_pool (job_id, question, choices, answer, explanation) VALUES (?, ?, ?, ?, ?)"
    );
    let added = 0;
    generated.forEach((g, i) => {
      if (solved[i] !== g.answerIndex) return; // 따로 푼 답이 다르거나 확신이 없으면 버린다
      insert.run(jobId, g.question, JSON.stringify(g.choices), g.choices[g.answerIndex], g.explanation);
      added += 1;
    });
    if (added === 0) lastFailure.set(jobId, Date.now());
    return added;
  } catch (err) {
    lastFailure.set(jobId, Date.now());
    console.warn("[work] 상황 판단 문제 채우기 실패:", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** 풀에서 덜 쓰인 문제를 꺼내고 사용 횟수를 올린다(많이 쓰인 문제는 지운다). */
function drawScenarios(jobId: number, n: number): Omit<ExamQuestion, "questionNo">[] {
  const rows = db
    .prepare(
      "SELECT id, question, choices, answer, explanation FROM work_question_pool WHERE job_id = ? AND uses < ? ORDER BY uses, RANDOM() LIMIT ?"
    )
    .all(jobId, WORK_QUESTIONS.maxUses, n) as unknown as PoolRow[];
  const bump = db.prepare("UPDATE work_question_pool SET uses = uses + 1 WHERE id = ?");
  for (const r of rows) bump.run(r.id);
  db.prepare("DELETE FROM work_question_pool WHERE job_id = ? AND uses >= ?").run(jobId, WORK_QUESTIONS.maxUses);
  return rows.map((r) => ({
    question: `[상황] ${r.question}`,
    answer: r.answer,
    choices: JSON.parse(r.choices) as string[],
    choiceOnly: true,
    explanation: r.explanation,
  }));
}

/** 이 직업의 근무 문제 한 배치(5문제). 상황 판단 문제가 모자라면 계산형으로 채운다. */
export function drawWorkBatch(jobId: number): ExamQuestion[] {
  const job = db.prepare("SELECT name FROM jobs WHERE id = ?").get(jobId) as { name: string } | undefined;
  const size = WORK_QUESTIONS.batchSize;
  if (!job) return aiProvider.getWorkQuestions();

  maybeRefill(jobId, job.name);
  const scenarios = drawScenarios(jobId, WORK_QUESTIONS.scenariosPerBatch);
  const calc = templateQuestions(job.name, size - scenarios.length);
  if (!calc) return aiProvider.getWorkQuestions(); // 템플릿이 없는 직업은 예전 공용 문제
  const mixed = [...calc, ...scenarios].sort(() => Math.random() - 0.5);
  return mixed.map((q, i) => ({ ...q, questionNo: i + 1 }));
}
