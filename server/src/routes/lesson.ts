// 학생 개인별 1:1 수업 — 방 접근 권한은 school.ts의 assertRoomAccessible을 그대로 재사용한다.
// 여기서는 개인 주제 선정 + 칠판 + 강의 진행만 다룬다. 승급 시험은 언제든 별도로 응시할 수
// 있고 이 수업 참여 여부/시간과는 무관하다(routes/school.ts의 exam/start 참고).
import { Router } from "express";
import { db, logLessonTopic, recentLessonTopics } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { aiProvider } from "../ai/index.js";
import type { BoardCommand, ConversationMemory, ConversationTurn } from "../ai/AIProvider.js";
import { assertRoomAccessible } from "./school.js";
import { chatLengthError } from "../util/chatLimit.js";

export const lessonRouter = Router();
lessonRouter.use(requireAuth);
lessonRouter.use(requireNotJailed);

// 세션을 열어둔 채 오래 방치(브라우저를 닫고 몇 시간 뒤 같은 방에 재입장 등)하면, 몇 시간 전
// 대화를 이어서 보여주는 게 오히려 어색하다 — 이 시간을 넘기면 자동으로 종료 처리하고 새로 시작한다.
const STALE_SESSION_SECONDS = 60 * 60;

interface LessonSessionRow {
  id: number;
  user_id: number;
  room_id: number;
  topic: string;
  started_at: string;
  ended_at: string | null;
  last_board: string | null;
}

interface LessonMessageRow {
  id: number;
  sender_type: "student" | "ai_teacher";
  content: string;
  board: string | null;
}

function secondsSince(isoTs: string): number {
  return Math.floor((Date.now() - new Date(isoTs + "Z").getTime()) / 1000);
}

function loadMessages(sessionId: number) {
  const rows = db
    .prepare(
      "SELECT id, sender_type, content, board FROM lesson_messages WHERE session_id = ? ORDER BY id"
    )
    .all(sessionId) as unknown as LessonMessageRow[];
  return rows.map((r) => ({
    id: r.id,
    senderType: r.sender_type,
    content: r.content,
    board: r.board ? (JSON.parse(r.board) as BoardCommand[]) : undefined,
  }));
}

/** 최근 limit개 발화를 ConversationTurn[]으로 변환 — 개인 수업은 한 사이클이 짧아 별도의
 * 요약 압축 없이 최근 원문만 넘겨도 충분하다(대화가 그만큼 길어지지 않는다). */
function loadRecentTurns(sessionId: number, limit: number): ConversationTurn[] {
  const rows = db
    .prepare(
      "SELECT sender_type, content FROM lesson_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(sessionId, limit) as { sender_type: string; content: string }[];
  return rows
    .reverse()
    .map((r): ConversationTurn =>
      r.sender_type === "ai_teacher"
        ? { speaker: "teacher", content: r.content }
        : { speaker: "student", content: r.content }
    );
}

function getOwnedSession(userId: number, sessionId: number): LessonSessionRow | null {
  const session = db
    .prepare("SELECT * FROM lesson_sessions WHERE id = ?")
    .get(sessionId) as LessonSessionRow | undefined;
  if (!session || session.user_id !== userId) return null;
  return session;
}

// ── 개인 수업 시작 ────────────────────────────────────────────────
lessonRouter.post("/rooms/:roomId/start", async (req, res) => {
  try {
    const roomId = Number(req.params.roomId);
    const userId = req.userId!;
    const room = assertRoomAccessible(userId, roomId);

    const existing = db
      .prepare(
        "SELECT * FROM lesson_sessions WHERE user_id = ? AND room_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .get(userId, roomId) as LessonSessionRow | undefined;

    if (existing) {
      const elapsedSeconds = secondsSince(existing.started_at);
      if (elapsedSeconds < STALE_SESSION_SECONDS) {
        res.json({
          sessionId: existing.id,
          topic: existing.topic,
          resumed: true,
          board: existing.last_board ? JSON.parse(existing.last_board) : [],
          messages: loadMessages(existing.id),
        });
        return;
      }
      db.prepare("UPDATE lesson_sessions SET ended_at = datetime('now') WHERE id = ?").run(existing.id);
    }

    const avoid = recentLessonTopics(userId, room.school_level, room.grade);
    const { topic, message, board } = await aiProvider.startLesson(room.school_level, room.grade, avoid);
    logLessonTopic(userId, room.school_level, room.grade, topic);

    const boardJson = JSON.stringify(board);
    const sessionInsert = db
      .prepare("INSERT INTO lesson_sessions (user_id, room_id, topic, last_board) VALUES (?, ?, ?, ?)")
      .run(userId, roomId, topic, boardJson);
    const sessionId = Number(sessionInsert.lastInsertRowid);

    const msgInsert = db
      .prepare(
        "INSERT INTO lesson_messages (session_id, sender_type, content, board) VALUES (?, 'ai_teacher', ?, ?)"
      )
      .run(sessionId, message, boardJson);

    res.json({
      sessionId,
      topic,
      resumed: false,
      board,
      messages: [
        { id: Number(msgInsert.lastInsertRowid), senderType: "ai_teacher", content: message, board },
      ],
    });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// ── 대화 이력 ─────────────────────────────────────────────────────
lessonRouter.get("/sessions/:id/messages", (req, res) => {
  const session = getOwnedSession(req.userId!, Number(req.params.id));
  if (!session) {
    res.status(404).json({ error: "존재하지 않거나 본인의 수업 세션이 아닙니다." });
    return;
  }
  res.json(loadMessages(session.id));
});

// ── 질문/발언에 답하기 ────────────────────────────────────────────
lessonRouter.post("/sessions/:id/ask", async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const session = getOwnedSession(req.userId!, sessionId);
    if (!session) {
      res.status(404).json({ error: "존재하지 않거나 본인의 수업 세션이 아닙니다." });
      return;
    }
    if (session.ended_at) {
      res.status(400).json({ error: "이미 종료된 수업 세션입니다." });
      return;
    }
    const question = String(req.body?.question ?? "").trim();
    if (!question) {
      res.status(400).json({ error: "질문 내용이 비어 있습니다." });
      return;
    }
    const tooLong = chatLengthError(question);
    if (tooLong) {
      res.status(400).json({ error: tooLong });
      return;
    }

    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(session.room_id) as
      | { school_level: string; grade: number }
      | undefined;
    if (!room) {
      res.status(404).json({ error: "존재하지 않는 방입니다." });
      return;
    }

    db.prepare("INSERT INTO lesson_messages (session_id, sender_type, content) VALUES (?, 'student', ?)").run(
      sessionId,
      question
    );

    const currentBoard: BoardCommand[] = session.last_board ? JSON.parse(session.last_board) : [];
    const memory: ConversationMemory = { summary: null, recentHistory: loadRecentTurns(sessionId, 16) };

    const reply = await aiProvider.answerLessonQuestion(
      session.topic,
      room.school_level,
      room.grade,
      question,
      memory,
      currentBoard
    );

    const nextBoard = reply.board && reply.board.length ? reply.board : undefined;
    if (nextBoard) {
      db.prepare("UPDATE lesson_sessions SET last_board = ? WHERE id = ?").run(
        JSON.stringify(nextBoard),
        sessionId
      );
    }
    db.prepare(
      "INSERT INTO lesson_messages (session_id, sender_type, content, board) VALUES (?, 'ai_teacher', ?, ?)"
    ).run(sessionId, reply.message, nextBoard ? JSON.stringify(nextBoard) : null);

    res.json({ reply: reply.message, board: nextBoard });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// ── 종료(나가기) ───────────────────────────────────────────────────
lessonRouter.post("/sessions/:id/end", (req, res) => {
  const session = getOwnedSession(req.userId!, Number(req.params.id));
  if (!session) {
    res.status(404).json({ error: "존재하지 않거나 본인의 수업 세션이 아닙니다." });
    return;
  }
  db.prepare("UPDATE lesson_sessions SET ended_at = datetime('now') WHERE id = ?").run(session.id);
  res.json({ ok: true });
});
