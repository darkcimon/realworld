// NPC 대사 말투 입히기(LLM). 판단·금액·수치는 npcManager/npcBoss가 규칙으로 이미 정했고, 여기서는
// 그 결과 문장의 "표현"만 바꾼다. LLM 출력은 서버가 검증해서 통과 못 하면 원문을 그대로 쓴다:
//  - 원문에 있던 숫자가 하나라도 빠지거나 바뀌면 폐기(약속/금액 왜곡 방지)
//  - 원문 숫자 외의 새 숫자가 생기면 폐기
//  - 길이 초과, 금지어 포함이면 폐기
// 유저당 하루 호출 상한과 하루 1회 인사 캐시로 호출량(=비용)도 묶는다. 월 예산/키 없음/오류는
// Provider가 원문을 돌려주므로 이 함수는 항상 안전하게 문자열을 반환한다.
import { aiProvider } from "../ai/index.js";
import { detectViolation } from "../util/moderation.js";
import { NPC_VOICE } from "../economy.js";
import { todayKstDate } from "./lottery.js";

type Npc = "manager" | "boss";

const dailyCalls = new Map<string, number>(); // `${date}:${userId}` → 호출 수
const greetingCache = new Map<string, string>(); // `${date}:${userId}:${npc}` → 오늘의 인사

function numbersOf(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "")).sort();
}

/** LLM 출력이 원문의 사실(숫자)을 그대로 보존하는지 확인한다. 테스트에서 직접 검증한다. */
export function isFaithful(base: string, candidate: string): boolean {
  if (!candidate || candidate.length > Math.max(NPC_VOICE.minMaxLen, base.length * NPC_VOICE.maxLenRatio)) return false;
  if (detectViolation(candidate)) return false;
  const a = numbersOf(base);
  const b = numbersOf(candidate);
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

function takeBudget(userId: number): boolean {
  const key = `${todayKstDate()}:${userId}`;
  const used = dailyCalls.get(key) ?? 0;
  if (used >= NPC_VOICE.dailyCallsPerUser) return false;
  dailyCalls.set(key, used + 1);
  if (dailyCalls.size > 5000) for (const k of dailyCalls.keys()) if (!k.startsWith(todayKstDate())) dailyCalls.delete(k);
  return true;
}

export async function voiceLine(userId: number, npc: Npc, situation: string, baseLine: string): Promise<string> {
  if (!NPC_VOICE.enabled || !takeBudget(userId)) return baseLine;
  try {
    const out = await aiProvider.npcLine(npc, situation, baseLine);
    return isFaithful(baseLine, out) ? out : baseLine;
  } catch {
    return baseLine;
  }
}

/** 하루에 한 번만 말투를 입힌 인사를 만들고, 이후에는 같은 문장을 재사용한다. */
export async function voiceGreeting(userId: number, npc: Npc, baseGreeting: string): Promise<string> {
  const key = `${todayKstDate()}:${userId}:${npc}`;
  const cached = greetingCache.get(key);
  if (cached) return cached;
  const line = await voiceLine(userId, npc, "근무 시작 인사", baseGreeting);
  greetingCache.set(key, line);
  if (greetingCache.size > 5000) for (const k of greetingCache.keys()) if (!k.startsWith(todayKstDate())) greetingCache.delete(k);
  return line;
}
