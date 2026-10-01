// 출석 체크 + 일일 퀘스트(리텐션 루프). 날짜는 모두 KST 기준이다.
// 퀘스트 진행도는 별도 카운터를 두지 않고 오늘 쌓인 실제 활동 기록(수업 질문, 시험 결과, 근무 답안,
// 마트 계산)에서 바로 계산한다 — 기존 라우트를 건드리지 않아도 되고 값이 어긋날 일이 없다.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import {
  ATTENDANCE_REWARDS,
  NEWBIE_DAYS,
  QUESTS,
  TIMED_QUEST_HOURS,
  TIMED_QUEST_REWARD_SCALE,
  TIMED_QUESTS,
  type QuestKey,
  type QuestPhase,
} from "../economy.js";
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

const KST_OFFSET = 9 * 60 * 60 * 1000;

/** KST 날짜의 hour시 정각을 DB의 UTC datetime 문자열("YYYY-MM-DD HH:MM:SS")로. */
function kstToDb(date: string, hour = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour) - KST_OFFSET).toISOString().slice(0, 19).replace("T", " ");
}

function nowDb(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 19).replace("T", " ");
}

// created_at 등은 UTC(datetime('now'))로 저장되므로 [from, to) UTC 구간으로 센다.
// 하루 퀘스트는 오늘 KST 0시부터, 시간대 퀘스트는 열린 시각부터 오늘 자정까지.
function questProgress(userId: number, key: QuestKey, from: string, to: string): number {
  switch (key) {
    case "lesson_ask":
      return count(
        `SELECT COUNT(*) AS c FROM lesson_messages m JOIN lesson_sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND m.sender_type = 'student' AND m.created_at >= ? AND m.created_at < ?`,
        userId,
        from,
        to
      );
    case "group_chat":
      return count(
        `SELECT COUNT(*) AS c FROM chat_messages
         WHERE user_id = ? AND sender_type = 'user' AND created_at >= ? AND created_at < ?`,
        userId,
        from,
        to
      );
    case "exam_try":
      return (
        count(
          "SELECT COUNT(*) AS c FROM exam_results WHERE user_id = ? AND created_at >= ? AND created_at < ?",
          userId,
          from,
          to
        ) +
        count(
          "SELECT COUNT(*) AS c FROM placement_results WHERE user_id = ? AND created_at >= ? AND created_at < ?",
          userId,
          from,
          to
        )
      );
    case "get_job":
      return count(
        "SELECT COUNT(*) AS c FROM job_assignments WHERE user_id = ? AND assigned_at >= ? AND assigned_at < ?",
        userId,
        from,
        to
      );
    case "set_location":
      return count(
        "SELECT COUNT(*) AS c FROM user_locations WHERE user_id = ? AND updated_at >= ? AND updated_at < ?",
        userId,
        from,
        to
      );
    case "work_batch":
      return count(
        `SELECT COUNT(*) AS c FROM work_attempts a JOIN work_sessions s ON s.id = a.session_id
         WHERE s.user_id = ? AND a.created_at >= ? AND a.created_at < ?`,
        userId,
        from,
        to
      );
    case "first_alba":
    case "alba_tx":
      return count(
        `SELECT COUNT(*) AS c FROM mart_transactions t JOIN mart_shifts s ON s.id = t.shift_id
         WHERE s.user_id = ? AND t.created_at >= ? AND t.created_at < ?`,
        userId,
        from,
        to
      );
    case "lottery_buy":
      return count(
        "SELECT COUNT(*) AS c FROM lottery_tickets WHERE user_id = ? AND created_at >= ? AND created_at < ?",
        userId,
        from,
        to
      );
    case "shop_food":
      return count(
        "SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ? AND type = '장보기' AND created_at >= ? AND created_at < ?",
        userId,
        from,
        to
      );
  }
}

// 학생은 지금 다니는 학교급, 졸업생은 고등학교 졸업일로부터 NEWBIE_DAYS일(KST, 졸업 당일 포함)
// 동안은 신입(newbie), 그 뒤로는 사회인(adult) 퀘스트를 받는다.
function questPhase(userId: number, today: string): QuestPhase {
  const profile = db
    .prepare("SELECT school_level, status FROM student_profile WHERE user_id = ?")
    .get(userId) as { school_level: string; status: string } | undefined;
  if (!profile) return "elementary";
  if (profile.status !== "graduated") return profile.school_level as QuestPhase;
  const grad = db
    .prepare(
      "SELECT date(MAX(graduated_at), '+9 hours') AS d FROM graduations WHERE user_id = ? AND school_level = 'high'"
    )
    .get(userId) as { d: string | null };
  return grad.d && grad.d > addDays(today, -NEWBIE_DAYS) ? "newbie" : "adult";
}

/** 문자열 → 0~1 사이 고정 난수(같은 입력이면 항상 같은 값). */
function seeded(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

interface ActiveQuest {
  key: string; // 수령 기록용 키: 하루 퀘스트는 QuestKey, 시간대 퀘스트는 "t12:work_batch"
  kind: QuestKey; // 진행도를 세는 방법
  label: string;
  goal: number;
  reward: number;
  from: string; // 진행도를 세기 시작하는 시각(UTC DB 문자열)
  slot: string | null; // 시간대 퀘스트면 "12:00"
  once?: boolean;
}

/** 오늘 받을 수 있는 퀘스트 전체: 단계별 하루 퀘스트 + 이미 열린 시간대 퀘스트(시간대마다 1~2개). */
function activeQuests(userId: number, today: string, phase: QuestPhase, now = Date.now()): ActiveQuest[] {
  const list: ActiveQuest[] = QUESTS.filter((q) => q.phase === phase).map((q) => ({
    key: q.key,
    kind: q.key,
    label: q.label,
    goal: q.goal,
    reward: q.reward,
    from: kstToDb(today),
    slot: null,
    once: q.once,
  }));
  const pool = TIMED_QUESTS.filter((q) => q.phases.includes(phase));
  const scale = TIMED_QUEST_REWARD_SCALE[phase];
  const current = nowDb(now);
  for (const hour of TIMED_QUEST_HOURS) {
    const from = kstToDb(today, hour);
    if (from > current || !pool.length) continue; // 아직 안 열린 시간대
    const seed = `${userId}|${today}|${hour}`;
    const howMany = seeded(seed + "|n") < 0.5 ? 1 : 2;
    // 풀에서 겹치지 않게 뽑는다(같은 시간대 안에서만 — 시간대가 다르면 같은 종류가 또 나올 수 있다).
    const picks = [...pool].sort(
      (a, b) => seeded(`${seed}|${a.key}|${a.label}`) - seeded(`${seed}|${b.key}|${b.label}`)
    );
    const hh = String(hour).padStart(2, "0");
    for (const q of picks.slice(0, howMany)) {
      list.push({
        key: `t${hh}:${q.key}`,
        kind: q.key,
        label: q.label,
        goal: q.goal,
        reward: Math.round((q.reward * scale) / 10_000) * 10_000,
        from,
        slot: `${hh}:00`,
      });
    }
  }
  return list;
}

/**
 * 퀘스트별 진행도. 하루 퀘스트는 오늘 0시부터 센다. 시간대 퀘스트는 열린 시각부터 세되, 같은 종류가 여러 번
 * 열렸으면 활동 한 건이 한 퀘스트에만 쓰이게 나눈다(로또 한 장으로 로또 퀘스트 여러 개를 채우지 못하게):
 * 늦게 열린 퀘스트부터 그 이후 활동을 가져가고, 남는 만큼 앞 퀘스트에 채운다.
 */
function progressMap(userId: number, quests: ActiveQuest[], dayEnd: string): Map<string, number> {
  const result = new Map<string, number>();
  const byKind = new Map<QuestKey, ActiveQuest[]>();
  for (const q of quests) {
    if (!q.slot) {
      result.set(q.key, Math.min(questProgress(userId, q.kind, q.from, dayEnd), q.goal));
      continue;
    }
    byKind.set(q.kind, [...(byKind.get(q.kind) ?? []), q]);
  }
  for (const [kind, list] of byKind) {
    let used = 0;
    for (const q of [...list].sort((a, b) => (a.from < b.from ? 1 : -1))) {
      const available = questProgress(userId, kind, q.from, dayEnd) - used;
      const progress = Math.max(0, Math.min(q.goal, available));
      result.set(q.key, progress);
      used += progress;
    }
  }
  return result;
}

/** 다음 시간대 퀘스트가 열리는 시각(ISO). 오늘 마지막 시간대가 지났으면 null. */
function nextTimedQuestAt(today: string, now = Date.now()): string | null {
  const current = nowDb(now);
  const next = TIMED_QUEST_HOURS.map((h) => kstToDb(today, h)).find((t) => t > current);
  return next ? next.replace(" ", "T") + ".000Z" : null;
}

function claimedEver(userId: number, key: QuestKey): boolean {
  return !!db.prepare("SELECT 1 FROM quest_claims WHERE user_id = ? AND quest_key = ? LIMIT 1").get(userId, key);
}

// 올 클리어 보너스: 그날 퀘스트(시간대 퀘스트 포함)를 전부 완료하면 퀘스트 보상 합계만큼 한 번 더 준다.
// 수령 기록은 quest_claims에 이 키로 남긴다(퀘스트 키와 겹치지 않는다).
const ALL_CLEAR_KEY = "all_clear";

/** 오늘 보이는 퀘스트와 진행도(상태 조회와 올 클리어 수령이 같은 기준을 쓰도록 한곳에서 계산). */
function todayQuests(userId: number, today: string) {
  const phase = questPhase(userId, today);
  const claimed = new Set(
    (
      db.prepare("SELECT quest_key FROM quest_claims WHERE user_id = ? AND date = ?").all(userId, today) as {
        quest_key: string;
      }[]
    ).map((r) => r.quest_key)
  );
  // 평생 1회 퀘스트는 이전 날짜에 이미 받았으면 목록에서 뺀다(오늘 받은 건 "받음"으로 남겨둔다).
  const visible = activeQuests(userId, today, phase).filter(
    (q) => !(q.once && !claimed.has(q.key) && claimedEver(userId, q.kind))
  );
  const progressOf = progressMap(userId, visible, kstToDb(addDays(today, 1)));
  const quests = visible.map((q) => {
    const progress = progressOf.get(q.key) ?? 0;
    return {
      key: q.key,
      label: q.label,
      goal: q.goal,
      reward: q.reward,
      slot: q.slot,
      progress,
      claimed: claimed.has(q.key),
      claimable: progress >= q.goal && !claimed.has(q.key),
    };
  });
  // 오늘 마지막 시간대 퀘스트까지 열려야(nextQuestAt === null) 오늘 퀘스트 목록이 확정된다.
  const allOpened = nextTimedQuestAt(today) === null;
  const doneCount = quests.filter((q) => q.progress >= q.goal).length;
  const allClearClaimed = claimed.has(ALL_CLEAR_KEY);
  const allClear = {
    reward: quests.reduce((sum, q) => sum + q.reward, 0),
    done: doneCount,
    total: quests.length,
    allOpened,
    claimed: allClearClaimed,
    claimable: allOpened && quests.length > 0 && doneCount === quests.length && !allClearClaimed,
  };
  return { quests, allClear };
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

  const { quests, allClear } = todayQuests(userId, today);

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
    allClear,
    nextQuestAt: nextTimedQuestAt(today), // 다음 시간대 퀘스트가 열리는 시각(오늘 마지막이 지났으면 null)
    // 사이드바 뱃지용: 아직 받을 수 있는 보상 개수(출석 + 완료한 퀘스트)
    pendingCount: (checkedInToday ? 0 : 1) + quests.filter((q) => q.claimable).length + (allClear.claimable ? 1 : 0),
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
  const all = activeQuests(userId, today, questPhase(userId, today));
  const quest = all.find((q) => q.key === key);
  if (!quest) throw { status: 404, message: "존재하지 않는 퀘스트입니다." };
  if (quest.once && claimedEver(userId, quest.kind)) {
    throw { status: 409, message: "이미 보상을 받은 퀘스트입니다." };
  }

  const done = db
    .prepare("SELECT 1 FROM quest_claims WHERE user_id = ? AND date = ? AND quest_key = ?")
    .get(userId, today, key);
  if (done) throw { status: 409, message: "이미 보상을 받은 퀘스트입니다." };
  if ((progressMap(userId, all, kstToDb(addDays(today, 1))).get(quest.key) ?? 0) < quest.goal) {
    throw { status: 400, message: "아직 퀘스트를 완료하지 않았습니다." };
  }

  const row = db
    .prepare("INSERT INTO quest_claims (user_id, date, quest_key, reward) VALUES (?, ?, ?, ?)")
    .run(userId, today, key, quest.reward);
  const { balance } = applyLedgerEntry(userId, "퀘스트보상", quest.reward, Number(row.lastInsertRowid));
  return { reward: quest.reward, balance };
}

export function claimAllClear(userId: number): { reward: number; balance: number } {
  const today = todayKstDate();
  const { allClear } = todayQuests(userId, today);
  if (allClear.claimed) throw { status: 409, message: "오늘 올 클리어 보상은 이미 받았습니다." };
  if (!allClear.allOpened) throw { status: 400, message: "오늘 마지막 시간대 퀘스트가 열린 뒤에 받을 수 있어요." };
  if (!allClear.claimable) throw { status: 400, message: "아직 모든 퀘스트를 완료하지 않았습니다." };

  const row = db
    .prepare("INSERT INTO quest_claims (user_id, date, quest_key, reward) VALUES (?, ?, ?, ?)")
    .run(userId, today, ALL_CLEAR_KEY, allClear.reward);
  const { balance } = applyLedgerEntry(userId, "퀘스트올클리어", allClear.reward, Number(row.lastInsertRowid));
  return { reward: allClear.reward, balance };
}
