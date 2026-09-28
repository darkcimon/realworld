// ClaudeAIProvider/GeminiAIProvider가 LLM에게 JSON 형식으로만 응답하도록 프롬프트를 짜더라도,
// 실제로는 형식을 어기거나 이상한 값을 섞어 보낼 수 있다. 이 파일은 그 응답을 안전하게
// 파싱하고, board 배열의 각 항목을 검증/보정(clamp)해서 클라이언트 canvas가 절대 깨지지 않게
// 한다 — 파싱에 실패해도 예외를 던지지 않고(answerLessonQuestion 쪽은), 원문을 그대로 채팅
// 메시지로 보여주는 선에서 부드럽게 대체한다.
import type { BoardCommand, LessonReply, LessonStart } from "./AIProvider.js";

function clamp01to100(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v;
}

/** LLM이 준 board 원본(형식이 안 맞을 수 있음)을 검증된 BoardCommand[]로 정리한다. */
export function sanitizeBoard(raw: unknown): BoardCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardCommand[] = [];
  for (const item of raw.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    switch (o.type) {
      case "clear":
        out.push({ type: "clear" });
        break;
      case "text": {
        const text = str(o.text);
        if (!text?.trim()) break;
        out.push({
          type: "text",
          x: clamp01to100(o.x),
          y: clamp01to100(o.y),
          text: text.slice(0, 60),
          size: Number.isFinite(Number(o.size)) ? Number(o.size) : undefined,
          color: str(o.color),
        });
        break;
      }
      case "line":
        out.push({
          type: "line",
          x1: clamp01to100(o.x1),
          y1: clamp01to100(o.y1),
          x2: clamp01to100(o.x2),
          y2: clamp01to100(o.y2),
          color: str(o.color),
          width: Number.isFinite(Number(o.width)) ? Number(o.width) : undefined,
        });
        break;
      case "rect":
        out.push({
          type: "rect",
          x: clamp01to100(o.x),
          y: clamp01to100(o.y),
          w: clamp01to100(o.w),
          h: clamp01to100(o.h),
          color: str(o.color),
          fill: !!o.fill,
        });
        break;
      case "circle":
        out.push({
          type: "circle",
          x: clamp01to100(o.x),
          y: clamp01to100(o.y),
          r: clamp01to100(o.r),
          color: str(o.color),
          fill: !!o.fill,
        });
        break;
      case "arrow":
        out.push({
          type: "arrow",
          x1: clamp01to100(o.x1),
          y1: clamp01to100(o.y1),
          x2: clamp01to100(o.x2),
          y2: clamp01to100(o.y2),
          color: str(o.color),
        });
        break;
      default:
        break; // 알 수 없는 type은 조용히 무시
    }
  }
  return out;
}

function extractJsonObject(raw: string): Record<string, unknown> {
  // LLM이 JSON만 출력하라는 지시를 어기고 앞뒤에 설명이나 코드블록 표시(```json)를 붙일 수 있어
  // 텍스트 중 가장 바깥쪽 {...} 블록만 골라 파싱한다.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("응답에서 JSON 블록을 찾지 못했습니다.");
  const parsed = JSON.parse(match[0]);
  if (!parsed || typeof parsed !== "object") throw new Error("JSON이 객체가 아닙니다.");
  return parsed as Record<string, unknown>;
}

/** startLesson 응답 파싱. 실패하면 예외를 던진다 — 호출부(Provider)가 MockAIProvider로 폴백한다. */
export function parseLessonStartJson(raw: string): LessonStart {
  const parsed = extractJsonObject(raw);
  const topic = String(parsed.topic ?? "").trim();
  const message = String(parsed.message ?? "").trim();
  if (!topic || !message) throw new Error("topic/message가 비어 있습니다.");
  return { topic: topic.slice(0, 60), message: message.slice(0, 600), board: sanitizeBoard(parsed.board) };
}

/**
 * answerLessonQuestion 응답 파싱. JSON 파싱에 실패해도 예외를 던지지 않고, 응답 원문 전체를
 * 메시지로 보여주는 선에서 대체한다 — 칠판 갱신 실패가 채팅 자체를 끊지 않게 하기 위함이다.
 */
export function parseLessonReplyJson(raw: string): LessonReply {
  try {
    const parsed = extractJsonObject(raw);
    const message = String(parsed.message ?? "").trim();
    if (!message) throw new Error("message가 비어 있습니다.");
    const board = Array.isArray(parsed.board) ? sanitizeBoard(parsed.board) : undefined;
    return { message: message.slice(0, 600), board: board && board.length ? board : undefined };
  } catch {
    return { message: raw.trim().slice(0, 600) };
  }
}
