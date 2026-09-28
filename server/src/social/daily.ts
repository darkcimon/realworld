// 출석 체크 + 일일 퀘스트(리텐션 루프). 날짜는 모두 KST 기준이다.
// 퀘스트 진행도는 별도 카운터를 두지 않고 오늘 쌓인 실제 활동 기록(수업 질문, 시험 결과, 근무 답안,
// 마트 계산)에서 바로 계산한다 — 기존 라우트를 건드리지 않아도 되고 값이 어긋날 일이 없다.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { ATTENDANCE_REWARDS, QUESTS, type QuestKey } from "../economy.js";
import { todayKstDate } from "./lottery.js";

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function count(sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// created_at은 UTC(datetime('now'))로 저장되므로 +9시간을 더해 KST 날짜와 비교한다.
function questProgress(userId: number, key: QuestKey, today: string): number {
  switch (key) {
    case "lesson_ask":
      return count(
        `SELECT COUNT(*) AS c FROM lesson_messages m JOIN lesson_sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND m.sender_type = 'student' AND date(m.created_at, '+9 hours') = ?`,
        userId,
        today
      );
    case "exam_try":
      return (
        count(
          "SELECT COUNT(*) AS c FROM exam_results WHERE user_id = ? AND date(created_at, '+9 hours') = ?",
          userId,
          today
        ) +
        count(
          "SELECT COUNT(*) AS c FROM placement_results WHERE user_id = ? AND date(created_at, '+9 hours') = ?",
          userId,
          today
        )
      );
    case "work_batch":
      return count(
        `SELECT COUNT(*) AS c FROM work_attempts a JOIN work_sessions s ON s.id = a.session_id
         WHERE s.user_id = ? AND date(a.created_at, '+9 hours') = ?`,
        userId,
        today
      );
    case "alba_tx":
      return count(
        `SELECT COUNT(*) AS c FROM mart_transactions t JOIN mart_shifts s ON s.id = t.shift_id
         WHERE s.user_id = ? AND date(t.created_at, '+9 hours') = ?`,
        userId,
        today
      );
  }
}

function isGraduated(userId: number): boolean {
  const row = db.prepare("SELECT status FROM student_profile WHERE user_id = ?").get(userId) as
    | { status: string }
    | undefined;
  return row?.status === "graduated";
}

export function getDailyStatus(userId: number) {
  const today = todayKstDate();
  const yesterday = addDays(today, -1);
  const last = db
    .prepare("SELECT date, streak FROM attendance_log WHERE user_id = ? ORDER BY date DESC LIMIT 1")
    .get(userId) as { date: string; streak: number } | undefined;

  const checkedInToday = last?.date === today;
  // 지금 이어지고 있는 연속 출석 일수(어제까지 이어졌거나 오늘 이미 출석한 경우만 유효).
  const streak = last && (last.date === today || last.date === yesterday) ? last.streak : 0;
  const nextStreak = checkedInToday ? streak : streak + 1;
  const nextReward = ATTENDANCE_REWARDS[(nextStreak - 1) % ATTENDANCE_REWARDS.length];

  const phase = isGraduated(userId) ? "adult" : "school";
  const claimed = new Set(
    (
      db.prepare("SELECT quest_key FROM quest_claims WHERE user_id = ? AND date = ?").all(userId, today) as {
        quest_key: string;
      }[]
    ).map((r) => r.quest_key)
  );
  const quests = QUESTS.filter((q) => q.phase === phase).map((q) => {
    const progress = Math.min(questProgress(userId, q.key, today), q.goal);
    return {
      key: q.key,
      label: q.label,
      goal: q.goal,
      reward: q.reward,
      progress,
      claimed: claimed.has(q.key),
      claimable: progress >= q.goal && !claimed.has(q.key),
    };
  });

  return {
    date: today,
    attendance: {
      checkedInToday,
      streak,
      nextDay: ((nextStreak - 1) % ATTENDANCE_REWARDS.length) + 1,
      nextReward,
      rewards: ATTENDANCE_REWARDS,
    },
    quests,
    // 사이드바 뱃지용: 아직 받을 수 있는 보상 개수(출석 + 완료한 퀘스트)
    pendingCount: (checkedInToday ? 0 : 1) + quests.filter((q) => q.claimable).length,
  };
}

export function checkIn(userId: number): { streak: number; reward: number; balance: number } {
  const today = todayKstDate();
  const last = db
    .prepare("SELECT date, streak FROM attendance_log WHERE user_id = ? ORDER BY date DESC LIMIT 1")
    .get(userId) as { date: string; streak: number } | undefined;
  if (last?.date === today) throw { status: 409, message: "오늘은 이미 출석했습니다." };

  const streak = last && last.date === addDays(today, -1) ? last.streak + 1 : 1;
  const reward = ATTENDANCE_REWARDS[(streak - 1) % ATTENDANCE_REWARDS.length];
  const row = db
    .prepare("INSERT INTO attendance_log (user_id, date, streak, reward) VALUES (?, ?, ?, ?)")
    .run(userId, today, streak, reward);
  const { balance } = applyLedgerEntry(userId, "출석보상", reward, Number(row.lastInsertRowid));
  return { streak, reward, balance };
}

export function claimQuest(userId: number, key: string): { reward: number; balance: number } {
  const today = todayKstDate();
  const quest = QUESTS.find((q) => q.key === key);
  const phase = isGraduated(userId) ? "adult" : "school";
  if (!quest || quest.phase !== phase) throw { status: 404, message: "존재하지 않는 퀘스트입니다." };

  const done = db
    .prepare("SELECT 1 FROM quest_claims WHERE user_id = ? AND date = ? AND quest_key = ?")
    .get(userId, today, key);
  if (done) throw { status: 409, message: "이미 보상을 받은 퀘스트입니다." };
  if (questProgress(userId, quest.key, today) < quest.goal) {
    throw { status: 400, message: "아직 퀘스트를 완료하지 않았습니다." };
  }

  const row = db
    .prepare("INSERT INTO quest_claims (user_id, date, quest_key, reward) VALUES (?, ?, ?, ?)")
    .run(userId, today, key, quest.reward);
  const { balance } = applyLedgerEntry(userId, "퀘스트보상", quest.reward, Number(row.lastInsertRowid));
  return { reward: quest.reward, balance };
}
