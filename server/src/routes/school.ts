// 학교 시스템 라우트: 방 목록/입장 권한, 승급 시험, 승급/졸업 처리.
// 게임을 단순하게 유지하기 위해 진급은 승급 시험 결과만으로 결정한다 — 참여 시간을 채워야
// 시험 자격이 생기는 규칙은 없고, 방이 잠겨 있지 않은 한 언제든 응시할 수 있다.
import { Router } from "express";
import { db, recentTopics, recordGraduation, roomOrderIndex, setRoomTopic } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { aiProvider } from "../ai/index.js";
import type { ExamQuestion } from "../ai/AIProvider.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { buildChoices } from "../ai/choices.js";
import { SCHOOL_REPEAT_REWARD } from "../economy.js";
import { todayKstDate } from "../social/lottery.js";

export const schoolRouter = Router();
schoolRouter.use(requireAuth);
schoolRouter.use(requireNotJailed);

const LEVEL_ORDER = ["elementary", "middle", "high"];
const LEVEL_LAST_GRADE: Record<string, number> = { elementary: 6, middle: 3, high: 3 };
const EXAM_TOTAL = 10;
const PASS_THRESHOLD = 7;
const PLACEMENT_PASS_THRESHOLD = 8;

// 승급 시험 합격 보상(학교급별, 방(학년)당 최초 합격 1회만 지급 — 재응시 반복으로 돈을 뽑지 못하게).
const PROMOTION_REWARD: Record<string, number> = {
  elementary: 1_000_000,
  middle: 2_000_000,
  high: 3_000_000,
};
// 배치고사 합격 보상(학교급 무관 고정 300만원).
const PLACEMENT_REWARD = 3_000_000;
const PROMOTION_REWARD_TYPE = "승급시험보상";
// 두 번째 합격부터 주는 학년별 보상(economy.ts SCHOOL_REPEAT_REWARD, 방마다 하루 1회).
const REPEAT_REWARD_TYPE = "재시험보상";
const PLACEMENT_REWARD_TYPE = "배치고사보상";

interface StudentProfileRow {
  user_id: number;
  school_level: string;
  grade: number;
  status: string;
}

function getProfile(userId: number): StudentProfileRow {
  return db
    .prepare("SELECT * FROM student_profile WHERE user_id = ?")
    .get(userId) as unknown as StudentProfileRow;
}

// 졸업생은 모든 방을 열어준다 — 고등학교 배치고사로 졸업하면 grade가 1로 남아 있어서
// school_level/grade만으로 계산하면 고1까지만 열린 것처럼 보인다.
function unlockedOrder(profile: StudentProfileRow): number {
  return profile.status === "graduated"
    ? Number.MAX_SAFE_INTEGER
    : roomOrderIndex(profile.school_level, profile.grade);
}

// ── 방 목록 ────────────────────────────────────────────────────────
schoolRouter.get("/rooms", (req, res) => {
  const profile = getProfile(req.userId!);
  const unlockedUpTo = unlockedOrder(profile);
  const currentOrder = profile.status === "graduated" ? -1 : unlockedUpTo;
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY order_index").all() as any[];
  res.json(
    rooms.map((r) => ({
      id: r.id,
      schoolLevel: r.school_level,
      grade: r.grade,
      label: r.label,
      unlocked: r.order_index <= unlockedUpTo,
      isCurrent: r.order_index === currentOrder,
    }))
  );
});

// Phase 4(routes/lesson.ts)도 개인 수업을 시작하기 전 동일한 방 접근 권한 검사가 필요해
// 여기서 export한다 — 같은 로직을 두 곳에 복제하면 잠금 규칙이 어긋날 위험이 생긴다.
export function assertRoomAccessible(userId: number, roomId: number) {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as any;
  if (!room) throw { status: 404, message: "존재하지 않는 방입니다." };
  const profile = getProfile(userId);
  if (room.order_index > unlockedOrder(profile)) {
    throw { status: 403, message: "아직 승급 전이라 입장할 수 없는 방입니다." };
  }
  return room;
}

// ── 단체 수업(학년 채팅방) 입장/퇴장 ────────────────────────────────
// README 4.2.4: 개인 수업과 별개로, 원하면 반 전체가 함께 쓰는 단체 채팅방으로 옮겨가
// 다른 학생들과 이야기할 수 있다. 참여 시간은 승급 시험 자격과 무관하다(시험은 언제든
// 응시 가능) — 여기서는 순수하게 "지금 이 방에 누가 있는지/무슨 주제로 얘기 중인지"만 관리한다.
schoolRouter.post("/rooms/:roomId/join", async (req, res) => {
  try {
    const roomId = Number(req.params.roomId);
    const room = assertRoomAccessible(req.userId!, roomId);

    // 나 말고 이미 이 방에 활성 참여자가 있는지(=이미 진행 중인 세션인지) 먼저 확인해둔다
    // (아래 INSERT보다 먼저 체크해야 "나 자신"이 활성 참여자로 잡히지 않는다).
    const otherActive = db
      .prepare("SELECT 1 FROM room_participation WHERE room_id = ? AND active = 1 LIMIT 1")
      .get(roomId);

    db.prepare(
      "UPDATE room_participation SET active = 0, left_at = datetime('now') WHERE user_id = ? AND active = 1"
    ).run(req.userId);
    db.prepare("INSERT INTO room_participation (user_id, room_id) VALUES (?, ?)").run(req.userId, roomId);

    let topic: string;
    let announcement: string;

    if (otherActive && room.current_topic) {
      // 이미 다른 학생들이 진행 중인 세션에 합류하는 경우 — 주제를 새로 뽑지 않고 이어간다.
      topic = room.current_topic;
      announcement = `지금 진행 중인 학습 주제는 "${topic}" 입니다. 함께 이야기해볼까요?`;
    } else {
      // 새 세션 시작 — README 4.2.4의 "AI가 직접 선정" / "참여자 의견 반영" 두 방식을 하나로
      // 합쳐서, 이 방에서 최근에 학생들이 나눈 대화(있다면)를 AI에게 참고자료로 준다.
      const recentRows = db
        .prepare(
          `SELECT cm.content, u.nickname FROM chat_messages cm LEFT JOIN users u ON u.id = cm.user_id
           WHERE cm.room_id = ? AND cm.sender_type = 'user' ORDER BY cm.id DESC LIMIT 15`
        )
        .all(roomId) as { content: string; nickname: string | null }[];
      const recentMessages = recentRows
        .reverse()
        .map((r) => ({ nickname: r.nickname ?? "학생", content: r.content }));

      topic = await aiProvider.pickDiscussionTopic(
        room.school_level,
        room.grade,
        recentMessages,
        recentTopics(roomId)
      );
      setRoomTopic(roomId, topic, "ai");
      announcement = `오늘의 학습 주제는 "${topic}" 입니다. 자유롭게 의견을 나눠볼까요?`;
    }

    db.prepare(
      "INSERT INTO chat_messages (room_id, sender_type, content) VALUES (?, 'ai_teacher', ?)"
    ).run(roomId, announcement);

    res.json({ ok: true, room: { id: room.id, label: room.label }, topic });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

schoolRouter.post("/rooms/:roomId/leave", (req, res) => {
  const roomId = Number(req.params.roomId);
  const session = db
    .prepare(
      "SELECT * FROM room_participation WHERE user_id = ? AND room_id = ? AND active = 1 ORDER BY id DESC LIMIT 1"
    )
    .get(req.userId, roomId) as any;
  if (!session) {
    res.status(400).json({ error: "입장 중인 세션이 없습니다." });
    return;
  }
  db.prepare(
    "UPDATE room_participation SET active = 0, left_at = datetime('now') WHERE id = ?"
  ).run(session.id);
  res.json({ ok: true });
});

// ── 채팅 이력 (실시간 송수신은 Socket.IO, 여기서는 과거 메시지 조회만) ─────
schoolRouter.get("/rooms/:roomId/messages", (req, res) => {
  try {
    const roomId = Number(req.params.roomId);
    assertRoomAccessible(req.userId!, roomId);
    // 컬럼을 실시간 소켓 이벤트(room:message)와 동일한 camelCase로 별칭해서, 히스토리로 불러온
    // 메시지와 실시간으로 들어온 메시지가 클라이언트에서 같은 모양(roomId/senderType/userId/avatarUrl)을
    // 갖게 한다(안 그러면 히스토리 메시지만 sender_type처럼 snake_case로 와서 스타일링이 어긋난다).
    const rows = db
      .prepare(
        `SELECT cm.id, cm.room_id AS roomId, cm.sender_type AS senderType, cm.user_id AS userId,
                cm.content, cm.created_at, u.nickname, u.avatar_url AS avatarUrl
         FROM chat_messages cm LEFT JOIN users u ON u.id = cm.user_id
         WHERE cm.room_id = ? ORDER BY cm.id DESC LIMIT 50`
      )
      .all(roomId) as any[];
    res.json(rows.reverse());
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// ── 승급 시험 ────────────────────────────────────────────────────
function currentCycleAttempts(userId: number, roomId: number) {
  const lastResult = db
    .prepare(
      "SELECT created_at FROM exam_results WHERE user_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(userId, roomId) as { created_at: string } | undefined;
  return lastResult
    ? (db
        .prepare(
          "SELECT * FROM exam_attempts WHERE user_id = ? AND room_id = ? AND created_at > ? ORDER BY question_no"
        )
        .all(userId, roomId, lastResult.created_at) as any[])
    : (db
        .prepare(
          "SELECT * FROM exam_attempts WHERE user_id = ? AND room_id = ? ORDER BY question_no"
        )
        .all(userId, roomId) as any[]);
}

schoolRouter.post("/rooms/:roomId/exam/start", (req, res) => {
  try {
    const roomId = Number(req.params.roomId);
    const room = assertRoomAccessible(req.userId!, roomId);

    const attempts = currentCycleAttempts(req.userId!, roomId);
    const bank = aiProvider.getExamQuestions(room.school_level, room.grade);
    const nextIndex = attempts.length; // 0-based
    if (nextIndex >= EXAM_TOTAL) {
      res.status(400).json({ error: "이미 이번 사이클의 시험을 완료했습니다." });
      return;
    }
    res.json({
      questionNo: nextIndex + 1,
      total: EXAM_TOTAL,
      question: bank[nextIndex].question,
      choices: buildChoices(bank[nextIndex], bank),
      answeredSoFar: attempts.length,
    });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

schoolRouter.post("/rooms/:roomId/exam/answer", (req, res) => {
  const roomId = Number(req.params.roomId);
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as any;
  if (!room) {
    res.status(404).json({ error: "존재하지 않는 방입니다." });
    return;
  }
  const { questionNo, answer } = req.body ?? {};
  const attempts = currentCycleAttempts(req.userId!, roomId);
  const expectedNo = attempts.length + 1;
  if (Number(questionNo) !== expectedNo) {
    res.status(400).json({ error: `현재 제출 가능한 문제 번호는 ${expectedNo}번입니다.` });
    return;
  }

  const bank = aiProvider.getExamQuestions(room.school_level, room.grade);
  const question = bank[expectedNo - 1];
  const correct = aiProvider.gradeAnswer(question, String(answer ?? ""));

  db.prepare(
    "INSERT INTO exam_attempts (user_id, room_id, question_no, question, answer, correct) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(req.userId, roomId, expectedNo, question.question, String(answer ?? ""), correct ? 1 : 0);

  if (expectedNo < EXAM_TOTAL) {
    res.json({
      correct,
      questionNo: expectedNo,
      correctAnswer: question.answer,
      explanation: question.explanation,
      finished: false,
      nextQuestion: bank[expectedNo].question,
      nextChoices: buildChoices(bank[expectedNo], bank),
    });
    return;
  }

  // 마지막 문제 — 채점 마감. 틀린 문제는 정답과 이유를 함께 돌려줘 결과 화면에서 복습할 수 있게 한다.
  const finalAttempts = currentCycleAttempts(req.userId!, roomId);
  const correctCount = finalAttempts.filter((a: any) => a.correct).length;
  const passed = correctCount >= PASS_THRESHOLD;
  db.prepare(
    "INSERT INTO exam_results (user_id, room_id, correct_count, total, passed) VALUES (?, ?, ?, ?, ?)"
  ).run(req.userId, roomId, correctCount, EXAM_TOTAL, passed ? 1 : 0);

  let reward = 0;
  let rewardNote: string | null = null;
  if (passed) {
    const already = db
      .prepare("SELECT 1 FROM ledger_entries WHERE user_id = ? AND type = ? AND ref_id = ? LIMIT 1")
      .get(req.userId, PROMOTION_REWARD_TYPE, roomId);
    if (!already) {
      reward = PROMOTION_REWARD[room.school_level] ?? 0;
      if (reward > 0) applyLedgerEntry(req.userId!, PROMOTION_REWARD_TYPE, reward, roomId);
    } else {
      // 두 번째 합격부터: 학년별 차등 보상, 이 방에서 오늘(KST) 아직 안 받았을 때만.
      const repeat = SCHOOL_REPEAT_REWARD[room.school_level]?.[room.grade - 1] ?? 0;
      const today = db
        .prepare(
          "SELECT 1 FROM ledger_entries WHERE user_id = ? AND type = ? AND ref_id = ? AND date(created_at, '+9 hours') = ? LIMIT 1"
        )
        .get(req.userId, REPEAT_REWARD_TYPE, roomId, todayKstDate());
      if (repeat > 0 && !today) {
        reward = repeat;
        applyLedgerEntry(req.userId!, REPEAT_REWARD_TYPE, reward, roomId);
      } else if (repeat > 0) {
        rewardNote = "이 학년 재시험 보상은 오늘 이미 받았어요. 내일 다시 도전하세요!";
      }
    }
  }

  const wrongAnswers = finalAttempts
    .filter((a: any) => !a.correct)
    .map((a: any) => {
      const q: ExamQuestion | undefined = bank[a.question_no - 1];
      return {
        questionNo: a.question_no,
        question: a.question,
        yourAnswer: a.answer,
        correctAnswer: q?.answer ?? "",
        explanation: q?.explanation ?? "",
      };
    });

  res.json({
    correct,
    questionNo: expectedNo,
    correctAnswer: question.answer,
    explanation: question.explanation,
    finished: true,
    correctCount,
    total: EXAM_TOTAL,
    passed,
    reward,
    rewardNote,
    wrongAnswers,
  });
});

// ── 승급 선택 ────────────────────────────────────────────────────
function computeTier(avgScore: number): string {
  if (avgScore >= 90) return "S";
  if (avgScore >= 80) return "A";
  if (avgScore >= 75) return "B";
  return "C";
}

schoolRouter.post("/rooms/:roomId/promote", (req, res) => {
  const roomId = Number(req.params.roomId);
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as any;
  const result = db
    .prepare(
      "SELECT * FROM exam_results WHERE user_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(req.userId, roomId) as any;

  if (!room || !result) {
    res.status(400).json({ error: "먼저 승급 시험을 완료해야 합니다." });
    return;
  }
  if (!result.passed) {
    res.status(403).json({ error: "7문제 이상 맞춰야 승급 여부를 선택할 수 있습니다." });
    return;
  }
  if (result.decision) {
    res.status(409).json({ error: "이미 이번 시험 결과에 대한 선택을 완료했습니다." });
    return;
  }

  const advance = !!req.body?.advance;
  db.prepare("UPDATE exam_results SET decision = ? WHERE id = ?").run(
    advance ? "advance" : "stay",
    result.id
  );

  if (!advance) {
    res.json({ ok: true, decision: "stay" });
    return;
  }

  const profile = getProfile(req.userId!);
  const isLastGradeOfLevel = room.grade === LEVEL_LAST_GRADE[room.school_level];
  // 이미 지나온 학년(또는 졸업 후) 재응시: 성적만 갱신하고 학교급/학년은 절대 뒤로 돌리지 않는다.
  const isRetake = profile.status === "graduated" || room.order_index < unlockedOrder(profile);

  if (isLastGradeOfLevel) {
    // 레벨 졸업 처리 — 해당 레벨의 각 학년 마지막 합격 시험 점수 평균으로 등급 산정
    const rooms = db
      .prepare("SELECT id, grade FROM rooms WHERE school_level = ? ORDER BY grade")
      .all(room.school_level) as any[];
    const scores: number[] = [];
    for (const r of rooms) {
      const best = db
        .prepare(
          "SELECT correct_count, total FROM exam_results WHERE user_id = ? AND room_id = ? AND passed = 1 ORDER BY id DESC LIMIT 1"
        )
        .get(req.userId, r.id) as any;
      if (best) scores.push((best.correct_count / best.total) * 100);
    }
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const tier = computeTier(avg);
    recordGraduation(req.userId!, room.school_level, avg, tier);
    if (isRetake) {
      res.json({ ok: true, decision: "advance", graduated: room.school_level, tier, averageScore: avg, retake: true });
      return;
    }

    const levelIdx = LEVEL_ORDER.indexOf(room.school_level);
    if (levelIdx === LEVEL_ORDER.length - 1) {
      // 고등학교 졸업 — 학교 전 과정 완료(최종 학력 고졸)
      db.prepare(
        "UPDATE student_profile SET status = 'graduated' WHERE user_id = ?"
      ).run(req.userId);
      res.json({ ok: true, decision: "advance", graduated: "high", tier, averageScore: avg });
      return;
    }
    const nextLevel = LEVEL_ORDER[levelIdx + 1];
    db.prepare(
      "UPDATE student_profile SET school_level = ?, grade = 1 WHERE user_id = ?"
    ).run(nextLevel, req.userId);
    res.json({
      ok: true,
      decision: "advance",
      graduated: room.school_level,
      tier,
      averageScore: avg,
      nextLevel,
    });
    return;
  }

  if (isRetake) {
    res.json({ ok: true, decision: "advance", retake: true });
    return;
  }
  db.prepare("UPDATE student_profile SET grade = grade + 1 WHERE user_id = ?").run(
    req.userId
  );
  res.json({ ok: true, decision: "advance", nextGrade: profile.grade + 1 });
});

schoolRouter.get("/graduation/:level", (req, res) => {
  const row = db
    .prepare("SELECT * FROM graduations WHERE user_id = ? AND school_level = ?")
    .get(req.userId, req.params.level);
  res.json(row ?? null);
});

// ── 배치고사 ─────────────────────────────────────────────────────
// 학년별 승급 시험을 하나하나 거치지 않고 학교급(초/중/고) 단위로 한 번에 졸업할 수 있는 지름길.
// 10문제 중 8문제 이상 맞히면 해당 학교급 졸업장(성적 등급 포함)을 바로 받고 다음 학교급 1학년으로
// 올라가며(고등학교면 학교 과정 완료 — 최종 학력 고졸), 고정 보상 300만원을 받는다. 지금 다니는 학교급만 응시할 수 있다.
const LEVEL_LABEL: Record<string, string> = {
  elementary: "초등학교",
  middle: "중학교",
  high: "고등학교",
};

function assertPlacementAvailable(userId: number, level: string) {
  if (!LEVEL_ORDER.includes(level)) throw { status: 404, message: "존재하지 않는 학교급입니다." };
  const profile = getProfile(userId);
  if (profile.status === "graduated") {
    throw { status: 403, message: "이미 모든 학교 과정을 졸업했습니다." };
  }
  if (profile.school_level !== level) {
    throw {
      status: 403,
      message:
        LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(profile.school_level)
          ? "이전 학교급을 먼저 졸업해야 응시할 수 있습니다."
          : "이미 졸업한 학교급입니다.",
    };
  }
}

// 한 사이클은 항상 정확히 10개의 시도로 끝나므로(마지막 문제에서 결과 행이 생성됨), 지금까지의 결과
// 수 × 10개를 건너뛴 나머지가 현재 진행 중인 사이클이다 — 시각 비교 대신 개수로 구분해 같은 초 안에
// 연속 응시해도 사이클이 섞이지 않는다.
function placementCycleAttempts(userId: number, level: string): any[] {
  const { c } = db
    .prepare("SELECT COUNT(*) AS c FROM placement_results WHERE user_id = ? AND school_level = ?")
    .get(userId, level) as { c: number };
  return db
    .prepare(
      "SELECT * FROM placement_attempts WHERE user_id = ? AND school_level = ? ORDER BY id LIMIT -1 OFFSET ?"
    )
    .all(userId, level, c * EXAM_TOTAL) as any[];
}

schoolRouter.get("/placement", (req, res) => {
  const profile = getProfile(req.userId!);
  res.json(
    LEVEL_ORDER.map((level) => ({
      schoolLevel: level,
      label: LEVEL_LABEL[level],
      available: profile.status !== "graduated" && profile.school_level === level,
      reward: PLACEMENT_REWARD,
      passThreshold: PLACEMENT_PASS_THRESHOLD,
      total: EXAM_TOTAL,
    }))
  );
});

schoolRouter.post("/placement/:level/start", (req, res) => {
  try {
    const level = String(req.params.level);
    assertPlacementAvailable(req.userId!, level);
    const attempts = placementCycleAttempts(req.userId!, level);
    const bank = aiProvider.getPlacementQuestions(level);
    res.json({
      questionNo: attempts.length + 1,
      total: EXAM_TOTAL,
      question: bank[attempts.length].question,
      choices: buildChoices(bank[attempts.length], bank),
      answeredSoFar: attempts.length,
    });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

schoolRouter.post("/placement/:level/answer", (req, res) => {
  try {
    const level = String(req.params.level);
    assertPlacementAvailable(req.userId!, level);
    const { questionNo, answer } = req.body ?? {};
    const attempts = placementCycleAttempts(req.userId!, level);
    const expectedNo = attempts.length + 1;
    if (Number(questionNo) !== expectedNo) {
      res.status(400).json({ error: `현재 제출 가능한 문제 번호는 ${expectedNo}번입니다.` });
      return;
    }

    const bank = aiProvider.getPlacementQuestions(level);
    const question = bank[expectedNo - 1];
    const correct = aiProvider.gradeAnswer(question, String(answer ?? ""));
    db.prepare(
      "INSERT INTO placement_attempts (user_id, school_level, question_no, question, answer, correct) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(req.userId, level, expectedNo, question.question, String(answer ?? ""), correct ? 1 : 0);

    if (expectedNo < EXAM_TOTAL) {
      res.json({
        correct,
        questionNo: expectedNo,
        correctAnswer: question.answer,
        explanation: question.explanation,
        finished: false,
        nextQuestion: bank[expectedNo].question,
        nextChoices: buildChoices(bank[expectedNo], bank),
      });
      return;
    }

    const finalAttempts = placementCycleAttempts(req.userId!, level);
    const correctCount = finalAttempts.filter((a: any) => a.correct).length;
    const passed = correctCount >= PLACEMENT_PASS_THRESHOLD;
    const resultRow = db
      .prepare(
        "INSERT INTO placement_results (user_id, school_level, correct_count, total, passed) VALUES (?, ?, ?, ?, ?)"
      )
      .run(req.userId, level, correctCount, EXAM_TOTAL, passed ? 1 : 0);

    const wrongAnswers = finalAttempts
      .filter((a: any) => !a.correct)
      .map((a: any) => {
        const q: ExamQuestion | undefined = bank[a.question_no - 1];
        return {
          questionNo: a.question_no,
          question: a.question,
          yourAnswer: a.answer,
          correctAnswer: q?.answer ?? "",
          explanation: q?.explanation ?? "",
        };
      });

    const base = {
      correct,
      questionNo: expectedNo,
      correctAnswer: question.answer,
      explanation: question.explanation,
      finished: true,
      correctCount,
      total: EXAM_TOTAL,
      passed,
      wrongAnswers,
    };
    if (!passed) {
      res.json(base);
      return;
    }

    // 합격 — 졸업장 발급 + 다음 학교급 진학(또는 사회 진입) + 고정 보상. 졸업 후에는 이 학교급의
    // 배치고사에 다시 응시할 수 없으므로(assertPlacementAvailable) 보상은 학교급당 1회만 지급된다.
    const averageScore = (correctCount / EXAM_TOTAL) * 100;
    const tier = computeTier(averageScore);
    recordGraduation(req.userId!, level, averageScore, tier);
    applyLedgerEntry(
      req.userId!,
      PLACEMENT_REWARD_TYPE,
      PLACEMENT_REWARD,
      Number(resultRow.lastInsertRowid)
    );

    const levelIdx = LEVEL_ORDER.indexOf(level);
    let nextLevel: string | null = null;
    if (levelIdx === LEVEL_ORDER.length - 1) {
      db.prepare("UPDATE student_profile SET status = 'graduated' WHERE user_id = ?").run(req.userId);
    } else {
      nextLevel = LEVEL_ORDER[levelIdx + 1];
      db.prepare("UPDATE student_profile SET school_level = ?, grade = 1 WHERE user_id = ?").run(
        nextLevel,
        req.userId
      );
    }
    res.json({ ...base, graduated: level, tier, averageScore, nextLevel, reward: PLACEMENT_REWARD });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});
