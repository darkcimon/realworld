// 근무 상황 판단 문제(LLM 응답) 파싱/검증. 모양이 어긋난 문제는 조용히 버린다 — 문제 풀은 모자라면
// 계산형 템플릿으로 채워지므로, 애매한 문제를 억지로 살릴 이유가 없다.
import type { WorkScenario } from "./AIProvider.js";
import { extractJsonObject } from "./lessonJson.js";
import { detectViolation } from "../util/moderation.js";

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

export function parseWorkScenarios(raw: string): WorkScenario[] {
  const parsed = extractJsonObject(raw);
  const list = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
  const out: WorkScenario[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const question = clean(o.question);
    const choices = Array.isArray(o.choices) ? o.choices.map(clean) : [];
    const answer = Math.trunc(Number(o.answer));
    const explanation = clean(o.explanation).slice(0, 160);
    if (question.length < 10 || question.length > 200) continue;
    if (choices.length !== 4 || choices.some((c) => c.length < 2 || c.length > 60)) continue;
    if (new Set(choices).size !== 4) continue; // 같은 보기가 둘이면 채점이 모호하다
    if (!(answer >= 1 && answer <= 4)) continue;
    if ([question, explanation, ...choices].some((t) => detectViolation(t))) continue;
    out.push({ question, choices, answerIndex: answer - 1, explanation });
  }
  return out;
}

/** 풀이 응답 {"answers": [1~4 또는 0]} → 보기 번호(0~3) 또는 null(확신 없음/형식 오류). */
export function parseWorkAnswers(raw: string, count: number): (number | null)[] {
  const parsed = extractJsonObject(raw);
  const list = Array.isArray(parsed.answers) ? parsed.answers : [];
  return Array.from({ length: count }, (_, i) => {
    const n = Math.trunc(Number(list[i]));
    return n >= 1 && n <= 4 ? n - 1 : null;
  });
}
