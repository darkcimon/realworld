// 직장 동료 NPC 응답(JSON) 파싱. 형식이 어긋나면 예외를 던지고, 호출부(Provider)가
// MockAIProvider의 규칙 기반 응답으로 대체한다. 값의 "상한"은 여기서가 아니라 서버
// (social/workplace.ts)가 권한/횟수와 함께 최종적으로 자른다 — 여기서는 모양만 검증한다.
import type { ColleagueAction, ColleagueTurn } from "./AIProvider.js";
import { extractJsonObject } from "./lessonJson.js";

function parseAction(raw: unknown): ColleagueAction {
  if (!raw || typeof raw !== "object") return { type: "none" };
  const o = raw as Record<string, unknown>;
  const reason = String(o.reason ?? "").trim().slice(0, 80);
  switch (o.type) {
    case "praise":
    case "warning":
      return reason ? { type: o.type, reason } : { type: "none" };
    case "eval_adjust":
    case "bonus":
    case "report": {
      const value = Math.trunc(Number(o.value));
      return reason && Number.isFinite(value) && value !== 0 ? { type: o.type, value, reason } : { type: "none" };
    }
    default:
      return { type: "none" };
  }
}

export function parseColleagueTurn(raw: string): ColleagueTurn {
  const parsed = extractJsonObject(raw);
  const reply = String(parsed.reply ?? "").trim();
  if (!reply) throw new Error("reply가 비어 있습니다.");
  const trustDelta = Math.trunc(Number(parsed.trustDelta ?? 0));
  return {
    reply: reply.slice(0, 300),
    action: parseAction(parsed.action),
    trustDelta: Number.isFinite(trustDelta) ? trustDelta : 0,
  };
}
