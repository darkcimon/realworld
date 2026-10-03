// 학년 채팅방(단체 수업) 실시간 통신 + README 11.3~11.5의 맞하트/열람권 1:1 채팅(DM).
// 승급 시험/감옥 판정은 REST(routes/school.ts, routes/jail.ts)와 동일한 로직(school/jail.ts,
// util/moderation.ts)을 그대로 재사용해 두 경로가 어긋나지 않게 한다.
//
// AI 선생님은 메시지마다 즉시 답하지 않는다. 여러 학생이 동시에 채팅하는 상황에서
// 매 메시지에 답하려 하면 과부하가 걸리고 대화 맥락도 끊기기 쉽다. 대신 방이 IDLE_MS(5초)
// 동안 조용해지면, 그 사이 쌓인 학생 발화를 한 번에 읽고 응답한다(디바운스).
// 다만 대화가 끊이지 않는 활발한 방에서는 디바운스가 계속 리셋되어 AI가 영영 응답하지
// 못할 수 있으므로, MAX_WAIT_MS(15초)가 지나면 조용해지지 않았더라도 강제로 한 번 응답한다.
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { db, roomOrderIndex, setRoomTopic } from "./db.js";
import { JWT_SECRET } from "./middleware/auth.js";
import { getActiveJail, recordViolation } from "./school/jail.js";
import { loadRecentHistory, loadSummary, maybeCompactRoomMemory } from "./school/roomMemory.js";
import { detectViolation } from "./util/moderation.js";
import { chatLengthError } from "./util/chatLimit.js";
import { aiProvider } from "./ai/index.js";
import type { StudentUtterance } from "./ai/AIProvider.js";
import { canChat, sendSocialMessage } from "./social/dating.js";

/** 1:1 채팅방 이름은 두 유저 id를 정렬해 항상 같은 방 이름이 나오게 한다. */
function dmRoomName(a: number, b: number): string {
  const [x, y] = [a, b].sort((n, m) => n - m);
  return `dm:${x}-${y}`;
}

const IDLE_MS = 5000;
const MAX_WAIT_MS = 15000;
const VOTE_MS = 20000; // 주제 투표 진행 시간

export function attachSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, { cors: { origin: "*" } });

  const pendingReplies = new Map<
    number,
    { idleTimer: NodeJS.Timeout; maxTimer: NodeJS.Timeout }
  >();

  // ── 실시간 참여 인원(오른쪽 상단 표시용) ────────────────────────────
  // 소켓 연결 단위로 세되, 같은 유저가 여러 탭을 열 수도 있어 "유저 수"가 아니라
  // "지금 이 방에 연결돼 있는 소켓 수"를 보여준다 — 실제 채팅 참여자 체감과 더 가깝다.
  const roomMembers = new Map<number, Set<string>>(); // roomId -> socket.id 목록
  const socketRooms = new Map<string, Set<number>>(); // socket.id -> 그 소켓이 들어간 roomId 목록
  // 같은 유저가 탭을 여러 개 열 수 있어, "입장/퇴장했습니다" 메시지는 소켓 단위가 아니라
  // 유저 단위로 딱 한 번만(마지막 탭이 닫힐 때까지) 남긴다.
  const roomUserSockets = new Map<number, Map<number, number>>(); // roomId -> userId -> 연결된 소켓 수

  function broadcastPresence(roomId: number) {
    const count = roomMembers.get(roomId)?.size ?? 0;
    io.to(`room:${roomId}`).emit("room:presence", { roomId, count });
  }

  function getNickname(userId: number): string {
    const row = db.prepare("SELECT nickname FROM users WHERE id = ?").get(userId) as
      | { nickname: string }
      | undefined;
    return row?.nickname ?? "누군가";
  }

  function postSystemMessage(roomId: number, content: string) {
    const insert = db
      .prepare("INSERT INTO chat_messages (room_id, sender_type, content) VALUES (?, 'system', ?)")
      .run(roomId, content);
    io.to(`room:${roomId}`).emit("room:message", {
      id: Number(insert.lastInsertRowid),
      roomId,
      senderType: "system",
      content,
    });
  }

  // ── 학습 주제 재선정 투표 (README 4.2.4: "참여자들의 투표로 주제 선정") ──────
  // 서로 다른 주제를 원하는 학생이 2명 이상 모이면(=제안이 2가지 이상 겹치면) 바로 투표를
  // 열어서 다수결로 주제를 바꾼다. 방 하나당 한 번에 하나의 제안 묶음/투표만 진행된다.
  const topicProposals = new Map<number, Map<number, string>>(); // roomId -> userId -> 제안한 주제
  const activeVotes = new Map<
    number,
    { candidates: string[]; votes: Map<number, number>; timer: NodeJS.Timeout }
  >();

  function concludeVote(roomId: number) {
    const vote = activeVotes.get(roomId);
    if (!vote) return;
    activeVotes.delete(roomId);
    const tally = vote.candidates.map(
      (_, i) => [...vote.votes.values()].filter((choice) => choice === i).length
    );
    let winnerIdx = 0;
    for (let i = 1; i < tally.length; i++) if (tally[i] > tally[winnerIdx]) winnerIdx = i;
    const topic = vote.candidates[winnerIdx];
    setRoomTopic(roomId, topic, "vote");
    io.to(`room:${roomId}`).emit("topic:vote_result", {
      roomId,
      topic,
      tally,
      candidates: vote.candidates,
    });
    postSystemMessage(roomId, `🗳️ 투표 결과 "${topic}" 주제로 이어갑니다!`);
  }

  // fireTeacherReply는 이제 LLM 호출 때문에 비동기다. setTimeout 콜백은 그 Promise를
  // 기다려주지 않으므로, 혹시 모를 예외가 unhandled rejection으로 새지 않게 직접 잡아준다
  // (ClaudeAIProvider 자체가 실패를 MockAIProvider로 대체하므로 평소엔 여기까지 오지 않는다).
  function runTeacherReply(roomId: number) {
    fireTeacherReply(roomId).catch((err) => {
      console.error(`[ai] AI 선생님 응답 처리 실패(room ${roomId}):`, err);
    });
  }

  function scheduleTeacherReply(roomId: number) {
    const existing = pendingReplies.get(roomId);
    if (existing) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = setTimeout(() => runTeacherReply(roomId), IDLE_MS);
      return;
    }
    pendingReplies.set(roomId, {
      idleTimer: setTimeout(() => runTeacherReply(roomId), IDLE_MS),
      maxTimer: setTimeout(() => runTeacherReply(roomId), MAX_WAIT_MS),
    });
  }

  async function fireTeacherReply(roomId: number) {
    const state = pendingReplies.get(roomId);
    if (state) {
      clearTimeout(state.idleTimer);
      clearTimeout(state.maxTimer);
      pendingReplies.delete(roomId);
    }

    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as any;
    if (!room) return;

    // 마지막 AI 발화 이후 쌓인 학생 발화들을 한 번에 모은다. content도 함께 가져와서
    // "선생님이 방금 뭐라고 했는지"를 아래 teacherReplyToBatch 호출에 그대로 넘겨준다 —
    // 안 그러면 AI가 자신이 방금 낸 문제도 기억 못 한 채(학생 발화만 보고) 엉뚱하게 답한다.
    const lastAi = db
      .prepare(
        "SELECT id, content FROM chat_messages WHERE room_id = ? AND sender_type = 'ai_teacher' ORDER BY id DESC LIMIT 1"
      )
      .get(roomId) as { id: number; content: string } | undefined;

    const rows = (
      lastAi
        ? db
            .prepare(
              "SELECT cm.*, u.nickname FROM chat_messages cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.room_id = ? AND cm.sender_type = 'user' AND cm.id > ? ORDER BY cm.id"
            )
            .all(roomId, lastAi.id)
        : db
            .prepare(
              "SELECT cm.*, u.nickname FROM chat_messages cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.room_id = ? AND cm.sender_type = 'user' ORDER BY cm.id"
            )
            .all(roomId)
    ) as any[];

    // 금지어 위반 발화는 AI가 참고하지 않는다(이미 경고/감옥 처리로 별도 대응됨).
    const utterances: StudentUtterance[] = rows
      .filter((r) => !detectViolation(r.content))
      .map((r) => ({ nickname: r.nickname ?? "학생", content: r.content }));

    if (utterances.length === 0) return; // 반영할 정상 발화가 없으면 굳이 응답하지 않는다.

    // 방마다 학습 주제는 세션 시작 시(school.ts의 join 핸들러) 한 번만 정해서 rooms.current_topic에
    // 저장해둔다 — 답변할 때마다 새로 뽑으면 대화 도중 주제가 계속 바뀌어버리기 때문이다.
    const topic = room.current_topic ?? "자유 주제";
    // 대화가 길어져도 프롬프트 크기가 계속 커지지 않도록, 오래된 대화는 요약(summary)으로만
    // 참고하고 그 이후(=아직 요약 안 된) 구간만 원문(recentHistory)으로 넘긴다(roomMemory.ts).
    const reply = await aiProvider.teacherReplyToBatch(topic, utterances, room.school_level, room.grade, {
      summary: loadSummary(roomId),
      recentHistory: loadRecentHistory(roomId, lastAi?.id ?? null),
    });

    // 응답을 기다리는 동안 방이 이미 사라졌거나(감옥행 등으로 정리) 상황이 바뀌었을 수 있어
    // room을 다시 조회하지는 않지만, 최소한 DB에 여전히 방이 존재하는지는 다시 확인한다.
    const stillExists = db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(roomId);
    if (!stillExists) return;

    const aiInsert = db
      .prepare(
        "INSERT INTO chat_messages (room_id, sender_type, content) VALUES (?, 'ai_teacher', ?)"
      )
      .run(roomId, reply);
    io.to(`room:${roomId}`).emit("room:message", {
      id: Number(aiInsert.lastInsertRowid),
      roomId,
      senderType: "ai_teacher",
      content: reply,
    });

    // 원문이 일정량 넘게 쌓였으면 오래된 부분을 요약으로 압축한다. 학생 응답을 기다리게 하지
    // 않도록 await하지 않고 백그라운드로 돌리되, 실패가 조용히 묻히지 않게 로그는 남긴다.
    maybeCompactRoomMemory(roomId, room.school_level, room.grade, topic).catch((err) => {
      console.error(`[ai] 방 ${roomId} 대화 요약 압축 실패:`, err);
    });
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId: number = socket.data.userId;

    socket.on("room:join", (roomId: number) => {
      const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as any;
      const profile = db
        .prepare("SELECT * FROM student_profile WHERE user_id = ?")
        .get(userId) as any;
      // 졸업생(배치고사로 졸업해 grade가 1로 남은 경우 포함)은 모든 방에 들어갈 수 있다.
      const locked =
        !!room &&
        profile.status !== "graduated" &&
        roomOrderIndex(room.school_level, room.grade) > roomOrderIndex(profile.school_level, profile.grade);
      if (!room || locked) {
        socket.emit("room:error", "입장할 수 없는 방입니다.");
        return;
      }
      if (getActiveJail(userId)) {
        socket.emit("room:error", "구금 중에는 학교에 입장할 수 없습니다.");
        return;
      }
      socket.join(`room:${roomId}`);
      if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
      roomMembers.get(roomId)!.add(socket.id);
      if (!socketRooms.has(socket.id)) socketRooms.set(socket.id, new Set());
      socketRooms.get(socket.id)!.add(roomId);

      if (!roomUserSockets.has(roomId)) roomUserSockets.set(roomId, new Map());
      const userSockets = roomUserSockets.get(roomId)!;
      const prevCount = userSockets.get(userId) ?? 0;
      userSockets.set(userId, prevCount + 1);
      if (prevCount === 0) {
        postSystemMessage(roomId, `${getNickname(userId)}님이 입장하셨습니다.`);
      }

      socket.emit("room:joined", { roomId });
      broadcastPresence(roomId);
    });

    // 학생이 "다른 주제로 이야기하고 싶다"고 제안한다. 서로 다른 주제를 원하는 학생이
    // 2명 이상 모이면(제안이 2가지 이상 겹치면) 바로 투표를 열어 다수결로 주제를 바꾼다.
    socket.on("topic:propose", ({ roomId, topic }: { roomId: number; topic: string }) => {
      const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as any;
      if (!room) {
        socket.emit("topic:error", "존재하지 않는 방입니다.");
        return;
      }
      if (getActiveJail(userId)) {
        socket.emit("topic:error", "구금 중에는 주제를 제안할 수 없습니다.");
        return;
      }
      const text = String(topic ?? "").trim().slice(0, 60);
      if (!text) return;
      if (activeVotes.has(roomId)) {
        socket.emit("topic:error", "이미 진행 중인 투표가 있어요. 투표가 끝난 뒤 다시 제안해주세요.");
        return;
      }

      if (!topicProposals.has(roomId)) topicProposals.set(roomId, new Map());
      topicProposals.get(roomId)!.set(userId, text);

      const distinct = [...new Set(topicProposals.get(roomId)!.values())];
      if (distinct.length < 2) {
        socket.emit("topic:proposed", { waitingForOthers: true });
        return;
      }

      // 후보는 최대 4개까지만(그 이상은 투표 UI가 복잡해지고 표가 과도하게 갈린다)
      const candidates = distinct.slice(0, 4);
      const timer = setTimeout(() => concludeVote(roomId), VOTE_MS);
      activeVotes.set(roomId, { candidates, votes: new Map(), timer });
      topicProposals.delete(roomId);

      io.to(`room:${roomId}`).emit("topic:vote_started", {
        roomId,
        candidates,
        endsAt: Date.now() + VOTE_MS,
      });
      postSystemMessage(
        roomId,
        `🗳️ 새로운 주제 제안이 올라왔어요! 20초 안에 투표해주세요.\n${candidates
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n")}`
      );
    });

    socket.on("topic:vote", ({ roomId, choice }: { roomId: number; choice: number }) => {
      const vote = activeVotes.get(roomId);
      if (!vote) {
        socket.emit("topic:error", "진행 중인 투표가 없습니다.");
        return;
      }
      if (!Number.isInteger(choice) || choice < 0 || choice >= vote.candidates.length) return;
      vote.votes.set(userId, choice);
      const tally = vote.candidates.map(
        (_, i) => [...vote.votes.values()].filter((v) => v === i).length
      );
      io.to(`room:${roomId}`).emit("topic:vote_tally", { roomId, tally });
    });

    socket.on("disconnect", () => {
      const rooms = socketRooms.get(socket.id);
      if (!rooms) return;
      socketRooms.delete(socket.id);
      for (const roomId of rooms) {
        roomMembers.get(roomId)?.delete(socket.id);

        const userSockets = roomUserSockets.get(roomId);
        const remaining = (userSockets?.get(userId) ?? 1) - 1;
        if (remaining <= 0) {
          userSockets?.delete(userId);
          postSystemMessage(roomId, `${getNickname(userId)}님이 퇴장하셨습니다.`);
        } else {
          userSockets!.set(userId, remaining);
        }

        broadcastPresence(roomId);
      }
    });

    socket.on("room:message", ({ roomId, content }: { roomId: number; content: string }) => {
      if (getActiveJail(userId)) {
        socket.emit("room:error", "구금 중에는 채팅을 보낼 수 없습니다.");
        return;
      }
      const text = String(content ?? "").trim();
      if (!text) return;
      const tooLong = chatLengthError(text);
      if (tooLong) {
        socket.emit("room:error", tooLong);
        return;
      }

      const sender = db
        .prepare("SELECT nickname, avatar_url AS avatarUrl FROM users WHERE id = ?")
        .get(userId) as { nickname: string; avatarUrl: string | null } | undefined;

      const insert = db
        .prepare(
          "INSERT INTO chat_messages (room_id, sender_type, user_id, content) VALUES (?, 'user', ?, ?)"
        )
        .run(roomId, userId, text);
      io.to(`room:${roomId}`).emit("room:message", {
        id: Number(insert.lastInsertRowid),
        roomId,
        senderType: "user",
        userId,
        nickname: sender?.nickname,
        avatarUrl: sender?.avatarUrl ?? null,
        content: text,
      });

      // 방이 조용해지면(또는 너무 오래 활발하면) AI 선생님이 그 사이 발화를 몰아 읽고 응답한다.
      scheduleTeacherReply(roomId);

      const badWord = detectViolation(text);
      if (badWord) {
        const violation = recordViolation(userId, "school", `금지어 감지: ${badWord}`);
        const systemMsg = violation.jailed
          ? "금지 행위가 3회 누적되어 감옥으로 이동합니다."
          : `금지 행위 경고 (${violation.level}/3): 욕설/음담패설은 삼가주세요.`;
        const sysInsert = db
          .prepare(
            "INSERT INTO chat_messages (room_id, sender_type, content) VALUES (?, 'system', ?)"
          )
          .run(roomId, systemMsg);
        io.to(`room:${roomId}`).emit("room:message", {
          id: Number(sysInsert.lastInsertRowid),
          roomId,
          senderType: "system",
          content: systemMsg,
        });
        if (violation.jailed) {
          io.to(`room:${roomId}`).emit("room:jailed", { userId, type: violation.type });
        }
      }
    });

    // README 11.3~11.5: 맞하트/열람권으로 열린 1:1 채팅의 실시간 메시지 송수신.
    // 권한(차단 여부, 열람권/맞하트 상태) 판정은 REST와 동일하게 sendSocialMessage가 담당한다.
    socket.on("dm:join", (targetId: number) => {
      // sendSocialMessage와 동일한 권한(차단 여부, 열람권/맞하트)을 확인하지 않으면
      // 상대 id만 알아도 아무나 방에 join해 실시간 메시지를 엿볼 수 있게 된다.
      if (!canChat(userId, Number(targetId))) {
        socket.emit("dm:error", "채팅 권한이 없습니다.");
        return;
      }
      socket.join(dmRoomName(userId, Number(targetId)));
    });

    socket.on("dm:message", ({ targetId, content }: { targetId: number; content: string }) => {
      try {
        const room = dmRoomName(userId, Number(targetId));
        // 상대가 이미 이 대화방을 열어 두고 있으면 실시간으로 보이므로 알림은 남기지 않는다.
        const roomSockets = io.sockets.adapter.rooms.get(room);
        const recipientWatching = [...(roomSockets ?? [])].some(
          (id) => io.sockets.sockets.get(id)?.data.userId === Number(targetId)
        );
        const { message, violation } = sendSocialMessage(userId, Number(targetId), content, recipientWatching);
        io.to(room).emit("dm:message", {
          id: message.id,
          fromId: message.from_id,
          toId: message.to_id,
          nickname: message.nickname,
          avatarUrl: message.avatarUrl,
          content: message.content,
          createdAt: message.created_at,
        });
        if (violation.violated) {
          io.to(room).emit("dm:violation", { userId, violation });
          if (violation.violation?.jailed) {
            socket.emit("room:jailed", { userId, type: violation.violation.type });
          }
        }
      } catch (e: any) {
        socket.emit("dm:error", e.message ?? "메시지를 보낼 수 없습니다.");
      }
    });
  });

  return io;
}
