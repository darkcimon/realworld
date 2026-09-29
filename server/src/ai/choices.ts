// 객관식 버튼용 선택지 생성. 시험/배치고사/근무는 서술형 정답을 채점하지만, 타이핑 마찰을 줄이기
// 위해 같은 문제에 4지선다 버튼을 병행해서 보여준다(README 4.3/6.2). 선택지를 눌러도 결국
// gradeAnswer가 정답 텍스트와 비교하므로 채점 로직은 그대로다.
import type { ExamQuestion } from "./AIProvider.js";

const NUMERIC = /^-?\d+(\.\d+)?$/;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 문제 텍스트로 시드를 고정해 새로고침/재요청해도 같은 순서로 보이게 한다.
function seededShuffle<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = seed || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function numericDistractors(answer: string): string[] {
  const n = Number(answer);
  const decimals = answer.includes(".") ? answer.split(".")[1].length : 0;
  const fmt = (v: number) => v.toFixed(decimals);
  const step = decimals > 0 ? 10 ** -decimals : 1;
  const cands = [n + step, n - step, n + 2 * step, n - 2 * step, n * 2, n + 10 * step];
  return cands.map(fmt).filter((c) => c !== answer && !c.startsWith("-"));
}

/** 정답 + 오답을 섞은 선택지(기본 4개). 문제에 "(A/B)" 형태 보기가 있으면 그 둘을 그대로 쓴다. */
export function buildChoices(question: ExamQuestion, pool: ExamQuestion[], count = 4): string[] {
  const answer = question.answer;

  // 문제에 정해진 보기(상황 판단형, 실수 유형 오답)가 있으면 그대로 섞어서 쓴다.
  if (question.choices && question.choices.length >= 2) return seededShuffle(question.choices, hash(question.question));

  const inline = question.question.match(/\(([^()/]+)\/([^()/]+)\)/);
  if (inline) {
    const opts = [inline[1].trim(), inline[2].trim()];
    if (opts.some((o) => o.replace(/\s+/g, "").toLowerCase() === answer.replace(/\s+/g, "").toLowerCase())) {
      return seededShuffle(opts, hash(question.question));
    }
  }

  const distractors: string[] = [];
  const add = (c: string) => {
    if (c !== answer && !distractors.includes(c)) distractors.push(c);
  };

  if (NUMERIC.test(answer)) {
    numericDistractors(answer).forEach(add);
    // 부족하면 같은 문제은행의 다른 숫자 정답으로 채운다.
    pool.filter((q) => NUMERIC.test(q.answer)).forEach((q) => add(q.answer));
  } else {
    // 같은 종류(숫자가 아닌) 정답을 우선 사용하되, 길이가 비슷한 것을 먼저 고른다.
    pool
      .filter((q) => !NUMERIC.test(q.answer))
      .map((q) => q.answer)
      .sort((a, b) => Math.abs(a.length - answer.length) - Math.abs(b.length - answer.length))
      .forEach(add);
  }
  pool.forEach((q) => add(q.answer));

  const picked = seededShuffle(distractors, hash(question.question + "d")).slice(0, count - 1);
  return seededShuffle([answer, ...picked], hash(question.question));
}
