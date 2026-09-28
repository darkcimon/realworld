// 단체 수업(학년 채팅방) 대화가 길어질수록 AI 선생님 프롬프트에 매번 실어보내는 컨텍스트도
// 계속 커진다. 그래서 "요약 이후 최근 N개는 원문 그대로, 그보다 오래된 건 하나의 요약
// 문자열로 압축"하는 구조를 둔다 — rooms.conversation_summary / summary_through_id(db.ts)가
// 그 상태를 들고 있고, 이 파일은 그 값을 읽고(loadSummary/loadRecentHistory) 필요할 때
// 갱신(maybeCompactRoomMemory)한다.
import { db } from "../db.js";
import { aiProvider } from "../ai/index.js";
import type { ConversationTurn } from "../ai/AIProvider.js";
import { detectViolation } from "../util/moderation.js";

// 요약 이후 원문 그대로 유지할 최근 메시지 수. 너무 작으면(예: 5) 몇 턴 만에 바로바로 요약이
// 돌아가 비용/지연이 늘고, 너무 크면(예: 100) 압축 효과가 없다 — 몇 번의 채팅 배치를 아우를
// 정도(대략 4~6턴)로 넉넉히 잡는다.
const RECENT_WINDOW = 24;
// 요약 이후 쌓인 원문이 RECENT_WINDOW + COMPACT_TRIGGER_EXTRA를 넘어야 압축을 실행한다.
// 여유분 없이 RECENT_WINDOW를 넘는 즉시 압축하면 메시지 하나 올 때마다 압축이 반복 실행될 수
// 있어, 일정량 더 쌓이고 나서 한 번에 압축하도록 여유를 둔다.
const COMPACT_TRIGGER_EXTRA = 12;

interface RoomMemoryRow {
  conversation_summary: string | null;
  summary_through_id: number;
}

function getRoomMemoryRow(roomId: number): RoomMemoryRow {
  return db
    .prepare("SELECT conversation_summary, summary_through_id FROM rooms WHERE id = ?")
    .get(roomId) as unknown as RoomMemoryRow;
}

interface RawMessageRow {
  id: number;
  sender_type: string;
  content: string;
  nickname: string | null;
}

/**
 * afterId(제외) ~ beforeId(제외, 없으면 끝까지) 구간의 user/ai_teacher 메시지를
 * 시간순 ConversationTurn[]으로 변환한다. 금지어 위반 발화는 socket.ts의 기존 필터링과
 * 동일하게 여기서도 걸러 요약/컨텍스트에 남지 않게 한다.
 */
function loadTurns(
  roomId: number,
  afterId: number,
  beforeId?: number
): { turns: ConversationTurn[]; lastId: number } {
  const rows = (
    beforeId != null
      ? db
          .prepare(
            `SELECT cm.id, cm.sender_type, cm.content, u.nickname FROM chat_messages cm
             LEFT JOIN users u ON u.id = cm.user_id
             WHERE cm.room_id = ? AND cm.id > ? AND cm.id < ? AND cm.sender_type IN ('user', 'ai_teacher')
             ORDER BY cm.id`
          )
          .all(roomId, afterId, beforeId)
      : db
          .prepare(
            `SELECT cm.id, cm.sender_type, cm.content, u.nickname FROM chat_messages cm
             LEFT JOIN users u ON u.id = cm.user_id
             WHERE cm.room_id = ? AND cm.id > ? AND cm.sender_type IN ('user', 'ai_teacher')
             ORDER BY cm.id`
          )
          .all(roomId, afterId)
  ) as unknown as RawMessageRow[];

  const turns: ConversationTurn[] = [];
  let lastId = afterId;
  for (const r of rows) {
    lastId = r.id;
    if (r.sender_type === "ai_teacher") {
      turns.push({ speaker: "teacher", content: r.content });
    } else if (!detectViolation(r.content)) {
      turns.push({ speaker: "student", nickname: r.nickname ?? "학생", content: r.content });
    }
  }
  return { turns, lastId };
}

/** 현재 보관 중인 요약(없으면 null). */
export function loadSummary(roomId: number): string | null {
  return getRoomMemoryRow(roomId).conversation_summary;
}

/** 요약 이후 ~ uptoMessageId(포함)까지의 최근 원문 대화. uptoMessageId가 없으면 빈 배열. */
export function loadRecentHistory(roomId: number, uptoMessageId: number | null): ConversationTurn[] {
  if (uptoMessageId == null) return [];
  const { summary_through_id } = getRoomMemoryRow(roomId);
  if (uptoMessageId <= summary_through_id) return [];
  return loadTurns(roomId, summary_through_id, uptoMessageId + 1).turns;
}

/**
 * 요약 이후 쌓인 원문이 임계치를 넘으면, 가장 최근 RECENT_WINDOW개만 원문으로 남기고
 * 그 이전 것들을 기존 요약과 합쳐 새 요약으로 압축한다. AI 선생님이 답변을 보낸 직후
 * (socket.ts fireTeacherReply)에 호출해서, 다음 응답부터 더 짧아진 컨텍스트를 쓰게 한다.
 * LLM 호출이 섞여 있어 시간이 걸릴 수 있으므로 호출부에서 await하지 않고 백그라운드로 돌린다.
 */
export async function maybeCompactRoomMemory(
  roomId: number,
  schoolLevel: string,
  grade: number,
  topic: string
): Promise<void> {
  const { conversation_summary, summary_through_id } = getRoomMemoryRow(roomId);
  const countRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM chat_messages WHERE room_id = ? AND id > ? AND sender_type IN ('user', 'ai_teacher')"
    )
    .get(roomId, summary_through_id) as { c: number };
  if (countRow.c <= RECENT_WINDOW + COMPACT_TRIGGER_EXTRA) return;

  // 가장 최근 RECENT_WINDOW개 메시지의 시작 id를 찾는다 — 그 id부터는 원문으로 남기고,
  // 그 이전(summary_through_id, cutoffId) 구간만 압축 대상으로 삼는다.
  const cutoffRow = db
    .prepare(
      `SELECT id FROM chat_messages WHERE room_id = ? AND id > ? AND sender_type IN ('user', 'ai_teacher')
       ORDER BY id DESC LIMIT 1 OFFSET ?`
    )
    .get(roomId, summary_through_id, RECENT_WINDOW - 1) as { id: number } | undefined;
  if (!cutoffRow) return;

  const { turns, lastId } = loadTurns(roomId, summary_through_id, cutoffRow.id);
  if (turns.length === 0) {
    // 압축 대상 구간이 전부 위반 발화 등으로 걸러진 경우 — 요약 내용은 그대로 두고
    // 커서만 앞당겨서 다음 호출까지 같은 구간을 계속 다시 스캔하지 않게 한다.
    db.prepare("UPDATE rooms SET summary_through_id = ? WHERE id = ?").run(lastId, roomId);
    return;
  }

  const newSummary = await aiProvider.summarizeConversation(
    schoolLevel,
    grade,
    topic,
    conversation_summary,
    turns
  );
  db.prepare("UPDATE rooms SET conversation_summary = ?, summary_through_id = ? WHERE id = ?").run(
    newSummary,
    lastId,
    roomId
  );
}
