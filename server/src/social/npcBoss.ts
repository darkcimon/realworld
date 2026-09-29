// 직장 상사 NPC(선택지형) — 점장과 같은 "감독 + 제한된 도구" 구조.
//  - 주 1회(BOSS.reviewPeriodDays) 그 기간의 근무 기록으로 평가(S/A/B/C)를 내리고,
//  - 좋은 평가가 연속되면 승진 심사를 요청할 수 있고(직급 → 일급 배수↑), 나쁜 평가가 연속되면 강등된다.
//  - 플레이어는 서버가 내려준 선택지 버튼으로만 답하고, 돈/직급 변경은 서버가 economy.ts의 상한 안에서만 실행한다.
// 판단은 규칙 기반이라 LLM 없이도 동작(재현/테스트 가능)하며, 평가 기준은 화면에 공개된다.
// 평가는 근무 패널을 열 때 "기한이 지났으면 그때 한 번" 계산된다(별도 스케줄러 없음).
import { db } from "../db.js";
import { applyLedgerEntry, getBalance } from "../wallet/ledger.js";
import { BOSS, EVENTS, MANAGER, WORKPLACE } from "../economy.js";
import { notify } from "./notifications.js";
import { todayKstDate } from "./lottery.js";
import { claimDailyRoll, managerTrust, pickRandom } from "./npcShared.js";

const NPC = "boss";
export const BOSS_NAME = "박부장";

type Grade = "S" | "A" | "B" | "C";
export type BossEventKind =
  | "review_good"
  | "review_ok"
  | "review_bad"
  | "demotion"
  | "deferred"
  | "evt_project"
  | "evt_dinner"
  | "evt_rumor";

interface BossStateRow {
  user_id: number;
  job_id: number;
  rank: number;
  good_streak: number;
  bad_streak: number;
  attitude: number;
  last_review_date: string;
  project_goal: number;
  colleague_adjust: number;
}

interface EventRow {
  id: number;
  kind: BossEventKind;
  message: string;
  choices: string;
  resolved: number;
  meta: string | null;
}

interface ReviewMeta {
  score: number;
  grade: Grade;
  accuracy: number; // 0~1
  workDays: number;
  overtime: number;
  reputation: number; // 점장 평판 보정
  project: number; // 긴급 프로젝트 가감점(0이면 없음)
}

const MAX_RANK = BOSS.ranks.length;
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const f = Date.parse(from + "T00:00:00Z");
  const t = Date.parse(to + "T00:00:00Z");
  return Math.round((t - f) / 86_400_000);
}

// ── 상태/직급 ───────────────────────────────────────────────────────
function activeJob(userId: number): { id: number; name: string; tier: string } | null {
  const row = db
    .prepare(
      `SELECT j.id, j.name, j.tier FROM job_assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.user_id = ? AND a.active = 1 ORDER BY a.id DESC LIMIT 1`
    )
    .get(userId) as { id: number; name: string; tier: string } | undefined;
  return row ?? null;
}

function getState(userId: number, jobId: number, today = todayKstDate()): BossStateRow {
  db.prepare(
    "INSERT OR IGNORE INTO boss_state (user_id, job_id, last_review_date) VALUES (?, ?, ?)"
  ).run(userId, jobId, today);
  return db
    .prepare("SELECT * FROM boss_state WHERE user_id = ? AND job_id = ?")
    .get(userId, jobId) as unknown as BossStateRow;
}

export function rankInfo(rank: number) {
  const r = BOSS.ranks[Math.max(1, Math.min(MAX_RANK, rank)) - 1];
  return { level: rank, title: r.title, payMultiplier: r.payMultiplier, max: MAX_RANK };
}

/** 정산 시 적용할 직급 일급 배수(이 직업에서 쌓은 직급 기준). 상태가 없으면 1. */
export function rankPayMultiplier(userId: number, jobId: number): number {
  const row = db
    .prepare("SELECT rank FROM boss_state WHERE user_id = ? AND job_id = ?")
    .get(userId, jobId) as { rank: number } | undefined;
  return row ? rankInfo(row.rank).payMultiplier : 1;
}

// ── 평가 기간 통계 ──────────────────────────────────────────────────
function windowStats(userId: number, jobId: number, sinceDate: string) {
  const base = db
    .prepare(
      `SELECT COUNT(*) AS attempts, COALESCE(SUM(a.correct), 0) AS correct,
              COUNT(DISTINCT date(a.created_at, '+9 hours')) AS days
       FROM work_attempts a JOIN work_sessions s ON s.id = a.session_id
       WHERE s.user_id = ? AND s.job_id = ? AND date(a.created_at, '+9 hours') >= ?`
    )
    .get(userId, jobId, sinceDate) as { attempts: number; correct: number; days: number };
  // 잔업: 한 근무(세션)에서 첫 5문제 배치를 넘겨 더 한 배치 수
  const ot = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN b > 1 THEN b - 1 ELSE 0 END), 0) AS overtime FROM (
         SELECT COUNT(DISTINCT a.batch_no) AS b
         FROM work_sessions s JOIN work_attempts a ON a.session_id = s.id
         WHERE s.user_id = ? AND s.job_id = ? AND date(a.created_at, '+9 hours') >= ?
         GROUP BY s.id
       )`
    )
    .get(userId, jobId, sinceDate) as { overtime: number };
  return {
    attempts: base.attempts,
    accuracy: base.attempts ? base.correct / base.attempts : 0,
    workDays: base.days,
    overtime: ot.overtime,
  };
}

/** 평가 점수(0~100): 정답률 60 + 근무일수 25(5일 만점) + 잔업 15(5배치 만점) + 면담 태도. */
function scoreOf(stats: { accuracy: number; workDays: number; overtime: number }, attitude = 0): number {
  const raw =
    60 * stats.accuracy + 25 * Math.min(stats.workDays / 5, 1) + 15 * Math.min(stats.overtime / 5, 1) + attitude;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function gradeOf(score: number): Grade {
  if (score >= BOSS.gradeS) return "S";
  if (score >= BOSS.gradeA) return "A";
  if (score >= BOSS.gradeB) return "B";
  return "C";
}

/** 가장 부족한 항목에 맞춘 조언(선택지 "요령/기준을 알려주세요"의 답변). */
function adviceFor(meta: ReviewMeta): string {
  const deficits = [
    { key: "acc", v: 60 * (1 - meta.accuracy) },
    { key: "days", v: 25 * (1 - Math.min(meta.workDays / 5, 1)) },
    { key: "ot", v: 15 * (1 - Math.min(meta.overtime / 5, 1)) },
  ].sort((a, b) => b.v - a.v);
  switch (deficits[0].key) {
    case "acc":
      return `이번엔 정답률(${Math.round(meta.accuracy * 100)}%)이 가장 아쉬웠어요. 문제를 끝까지 읽고, 보기를 하나씩 소거하면서 풀어보세요.`;
    case "days":
      return `근무일이 ${meta.workDays}일뿐이었어요. 하루에 조금씩이라도 꾸준히 출근하면 점수가 크게 올라요.`;
    default:
      return "성실하긴 한데 잔업이 적었어요. 5문제를 끝낸 뒤 잔업을 한두 번 더 해주면 좋은 점수를 받을 수 있어요.";
  }
}

// ── 이벤트 ──────────────────────────────────────────────────────────
interface ChoiceDef {
  label: string;
  attitude?: number;
  reply: (meta: ReviewMeta | null, ctx: { state: BossStateRow }) => string;
  effect?: "request_promotion" | "set_project" | "pay_dinner";
}

const CHOICES: Record<BossEventKind, Record<string, ChoiceDef>> = {
  review_good: {
    thanks: { label: "감사합니다, 부장님!", reply: () => "허허, 이 기세로 계속 가요." },
    request_promotion: {
      label: "승진 심사를 요청합니다",
      reply: () => "", // 결과에 따라 chooseBossOption에서 채운다
      effect: "request_promotion",
    },
  },
  review_ok: {
    ok: { label: "네, 알겠습니다", reply: () => "그래요. 다음 주엔 더 나아질 거라 믿어요." },
    ask_criteria: {
      label: "무엇을 보완하면 좋을까요?",
      attitude: BOSS.attitude.ask,
      reply: (meta) => (meta ? adviceFor(meta) : "꾸준함이 제일 중요해요."),
    },
  },
  review_bad: {
    apologize: {
      label: "죄송합니다, 다음엔 만회하겠습니다",
      attitude: BOSS.attitude.apologize,
      reply: () => "반성하는 태도는 좋아요. 다음 평가에서 지켜보겠어요.",
    },
    ask_advice: {
      label: "어떻게 하면 나아질까요?",
      attitude: BOSS.attitude.ask,
      reply: (meta) => (meta ? adviceFor(meta) : "기본부터 차근차근 해봐요."),
    },
    excuse: {
      label: "이번 주는 사정이 있었어요...",
      attitude: BOSS.attitude.excuse,
      reply: () => "사정은 누구에게나 있어요. 결과로 보여줘야죠.",
    },
  },
  demotion: {
    accept: {
      label: "받아들이겠습니다",
      attitude: BOSS.attitude.apologize,
      reply: () => "다시 올라올 기회는 얼마든지 있어요. 처음부터 차근차근 해봐요.",
    },
    ask_advice: {
      label: "다시 올라가려면 어떻게 해야 하나요?",
      attitude: BOSS.attitude.ask,
      reply: (meta) => (meta ? adviceFor(meta) : "꾸준히 근무하는 게 우선이에요."),
    },
  },
  // ── 랜덤 이벤트: 선택마다 위험/보상이 다르다 ──
  evt_project: {
    accept: {
      label: "맡겠습니다",
      reply: () =>
        `좋아요! 이번 평가 기간 안에 잔업을 ${EVENTS.projectGoal}회 이상 해주면 +${EVENTS.projectSuccessBonus}점 가산해요. 다만 못 채우면 -${EVENTS.projectFailPenalty}점이에요.`,
      effect: "set_project",
    },
    decline: {
      label: "이번엔 어렵겠습니다",
      attitude: -1,
      reply: () => "알겠어요. 무리하는 것보단 낫죠. 다음엔 기대할게요.",
    },
  },
  evt_dinner: {
    join: {
      label: "참석하겠습니다",
      attitude: BOSS.attitude.ask,
      reply: () => `좋아요! 회식비 ${EVENTS.dinnerCost.toLocaleString()}원은 각자 조금씩 내는 걸로 해요. 이런 자리에서 친해지는 거죠.`,
      effect: "pay_dinner",
    },
    skip: {
      label: "오늘은 약속이 있어서요",
      attitude: -1,
      reply: () => "그래요, 다음에 봐요.",
    },
  },
  evt_rumor: {
    thanks: {
      label: "감사합니다, 점장님이 잘 봐주셔서요",
      attitude: 2,
      reply: () => "겸손하네요. 일 잘한다는 소문은 금방 도는 법이에요.",
    },
  },
  deferred: {
    ok: { label: "알겠습니다", reply: () => "다음 주엔 근무 기록을 좀 더 채워서 평가받아봐요." },
  },
};

function createEvent(
  userId: number,
  kind: BossEventKind,
  message: string,
  choiceKeys: string[],
  meta: ReviewMeta | null
): void {
  // 답하지 않은 이전 이벤트는 정리해 항상 "지금 답할 대화"가 하나만 남게 한다.
  db.prepare("UPDATE npc_events SET resolved = 1 WHERE user_id = ? AND npc = ? AND resolved = 0").run(userId, NPC);
  db.prepare(
    "INSERT INTO npc_events (user_id, npc, kind, message, choices, meta) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, NPC, kind, message, JSON.stringify(choiceKeys), meta ? JSON.stringify(meta) : null);
}

/**
 * 평가 기한이 지났으면 그 기간의 근무 기록으로 평가를 내린다(기한 전이면 null).
 * 근무 기록이 전혀 없으면 조용히 기간만 넘기고(오랜만에 돌아온 유저를 벌하지 않는다),
 * 기록이 있지만 부족하면 평가를 "보류"한다.
 */
export function maybeReview(
  userId: number,
  jobId: number,
  today = todayKstDate()
): { kind: BossEventKind } | null {
  const state = getState(userId, jobId, today);
  if (today < addDays(state.last_review_date, BOSS.reviewPeriodDays)) return null;

  const stats = windowStats(userId, jobId, state.last_review_date);
  const advanceDate = () =>
    db.prepare("UPDATE boss_state SET last_review_date = ? WHERE user_id = ? AND job_id = ?").run(today, userId, jobId);

  if (stats.attempts === 0) {
    advanceDate();
    return null;
  }

  if (stats.attempts < BOSS.minAttempts || stats.workDays < BOSS.minWorkDays) {
    advanceDate();
    const msg = `이번 기간은 근무 기록이 적어서(문제 ${stats.attempts}개, ${stats.workDays}일) 평가를 보류할게요. 최소 ${BOSS.minWorkDays}일, ${BOSS.minAttempts}문제는 채워줘야 해요.`;
    createEvent(userId, "deferred", msg, ["ok"], null);
    notify(userId, "npc", `👔 ${BOSS_NAME}: ${msg}`);
    return { kind: "deferred" };
  }

  // NPC 간 평판: 마트 점장의 신뢰도가 높으면 좋은 추천이, 낮으면 나쁜 소문이 평가에 반영된다.
  const trust = managerTrust(userId);
  const reputation =
    trust >= MANAGER.trustedAt ? EVENTS.reputationAdjust : trust < MANAGER.watchBelow ? -EVENTS.reputationAdjust : 0;
  // 긴급 프로젝트: 잔업 목표를 달성하면 가산, 못하면 감산.
  let project = 0;
  if (state.project_goal > 0) {
    project = stats.overtime >= state.project_goal ? EVENTS.projectSuccessBonus : -EVENTS.projectFailPenalty;
  }

  const score = scoreOf(stats, state.attitude + reputation + project + state.colleague_adjust);
  const grade = gradeOf(score);
  const meta: ReviewMeta = {
    score,
    grade,
    accuracy: stats.accuracy,
    workDays: stats.workDays,
    overtime: stats.overtime,
    reputation,
    project,
  };
  const pct = Math.round(stats.accuracy * 100);
  const notes = [
    reputation !== 0 ? `점장 평판 ${reputation > 0 ? "+" : ""}${reputation}` : "",
    project !== 0 ? `긴급 프로젝트 ${project > 0 ? "성공 +" : "미달 "}${Math.abs(project)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const summary = `(정답률 ${pct}%, 근무 ${stats.workDays}일, 잔업 ${stats.overtime}회${notes ? `, ${notes}` : ""} → ${score}점)`;

  let good = state.good_streak;
  let bad = state.bad_streak;
  let rank = state.rank;
  let kind: BossEventKind;
  let message: string;
  let choiceKeys: string[];

  if (grade === "S" || grade === "A") {
    good += 1;
    bad = 0;
    kind = "review_good";
    message = pick([
      `이번 주 평가는 ${grade}등급이에요. ${summary} 아주 훌륭했어요.`,
      `${grade}등급! ${summary} 팀에서 믿고 맡길 수 있는 사람이네요.`,
    ]);
    if (good >= BOSS.promotionStreak && rank < MAX_RANK) {
      message += ` 좋은 평가가 ${good}회 연속이니, 원하면 승진 심사를 받아볼 수 있어요.`;
    }
    choiceKeys = rank < MAX_RANK ? ["thanks", "request_promotion"] : ["thanks"];
  } else if (grade === "B") {
    good = 0;
    bad = 0;
    kind = "review_ok";
    message = pick([
      `이번 주 평가는 B등급이에요. ${summary} 무난했어요.`,
      `B등급입니다. ${summary} 나쁘진 않은데 한 단계 더 올라갈 수 있어요.`,
    ]);
    choiceKeys = ["ok", "ask_criteria"];
  } else {
    good = 0;
    bad += 1;
    if (bad >= BOSS.demotionStreak && rank > 1) {
      rank -= 1;
      bad = 0;
      kind = "demotion";
      message = `C등급이 ${BOSS.demotionStreak}회 연속이에요. ${summary} 유감이지만 ${rankInfo(rank).title}(으)로 직급을 조정합니다.`;
      choiceKeys = ["accept", "ask_advice"];
    } else {
      kind = "review_bad";
      message =
        bad >= BOSS.demotionStreak - 1
          ? `이번 주 평가는 C등급이에요. ${summary} 한 번 더 이러면 직급 조정을 검토할 수밖에 없어요.`
          : pick([
              `이번 주 평가는 C등급이에요. ${summary} 아쉬운 한 주였어요.`,
              `C등급입니다. ${summary} 기대에 못 미쳤어요.`,
            ]);
      choiceKeys = ["apologize", "ask_advice", "excuse"];
      if (bad >= BOSS.demotionStreak) bad = BOSS.demotionStreak; // 최하 직급에서는 누적만 유지
    }
  }

  db.prepare(
    "UPDATE boss_state SET rank = ?, good_streak = ?, bad_streak = ?, attitude = 0, project_goal = 0, colleague_adjust = 0, last_review_date = ? WHERE user_id = ? AND job_id = ?"
  ).run(rank, good, bad, today, userId, jobId);

  createEvent(userId, kind, message, choiceKeys, meta);
  notify(userId, "npc", `👔 ${BOSS_NAME}: ${message}`);
  return { kind };
}

// ── 랜덤 이벤트 ─────────────────────────────────────────────────────
/**
 * 상사 패널을 열 때 호출. 오늘 아직 판정하지 않았고 답하지 않은 대화가 없을 때만 확률(EVENTS.chance)로
 * 이벤트가 발생한다. 점장 신뢰도가 높으면 "점장 소문" 이벤트가 후보에 추가된다(NPC 간 연결).
 */
export function maybeTriggerBossEvent(userId: number, rng: () => number = Math.random): { kind: BossEventKind } | null {
  const pending = db
    .prepare("SELECT 1 FROM npc_events WHERE user_id = ? AND npc = ? AND resolved = 0 LIMIT 1")
    .get(userId, NPC);
  if (pending) return null;
  if (!claimDailyRoll(userId, "boss")) return null;
  if (rng() >= EVENTS.chance) return null;

  const candidates: { kind: BossEventKind; message: string; choices: string[] }[] = [
    {
      kind: "evt_project",
      message: `급한 프로젝트가 들어왔어요. 이번 평가 기간 안에 잔업을 ${EVENTS.projectGoal}회 이상 맡아줄 수 있겠어요? 해내면 평가에 크게 반영하지만, 못 채우면 감점이에요.`,
      choices: ["accept", "decline"],
    },
    {
      kind: "evt_dinner",
      message: `오늘 저녁에 팀 회식이 있어요. 참석하면 얼굴도 익히고 좋을 텐데, 어때요? (회식비 ${EVENTS.dinnerCost.toLocaleString()}원)`,
      choices: ["join", "skip"],
    },
  ];
  if (managerTrust(userId) >= MANAGER.trustedAt) {
    candidates.push({
      kind: "evt_rumor",
      message: "옆 동네 마트 점장이 당신 칭찬을 자자하게 하더라고요. 어디서든 성실한 사람은 티가 나는 법이에요.",
      choices: ["thanks"],
    });
  }
  const picked = pickRandom(candidates, rng);
  createEvent(userId, picked.kind, picked.message, picked.choices, null);
  notify(userId, "npc", `👔 ${BOSS_NAME}: ${picked.message}`);
  return { kind: picked.kind };
}

// ── 플레이어 응답 ───────────────────────────────────────────────────
export interface BossPanelEvent {
  id: number;
  kind: BossEventKind;
  message: string;
  choices: { key: string; label: string }[];
}

function toPanelEvent(row: EventRow): BossPanelEvent {
  const keys = JSON.parse(row.choices) as string[];
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    choices: keys.map((k) => ({ key: k, label: CHOICES[row.kind][k].label })),
  };
}

export function chooseBossOption(
  userId: number,
  eventId: number,
  choiceKey: string
): { reply: string; promoted: boolean } {
  const event = db
    .prepare("SELECT * FROM npc_events WHERE id = ? AND user_id = ? AND npc = ?")
    .get(eventId, userId, NPC) as unknown as EventRow | undefined;
  if (!event) throw { status: 404, message: "존재하지 않는 대화입니다." };
  if (event.resolved) throw { status: 409, message: "이미 응답한 대화입니다." };

  // 서버가 제시한 선택지 안의 키만 인정한다.
  const offered = JSON.parse(event.choices) as string[];
  const def = offered.includes(choiceKey) ? CHOICES[event.kind]?.[choiceKey] : undefined;
  if (!def) throw { status: 400, message: "올바르지 않은 선택입니다." };

  const job = activeJob(userId);
  if (!job) throw { status: 400, message: "먼저 직업을 배정받아야 합니다." };
  const state = getState(userId, job.id);
  const meta = event.meta ? (JSON.parse(event.meta) as ReviewMeta) : null;

  // 돈이 드는 선택은 응답을 확정하기 전에 잔액부터 확인한다(부족하면 대화가 그대로 남아 다른 선택을 할 수 있다).
  if (def.effect === "pay_dinner" && getBalance(userId) < EVENTS.dinnerCost) {
    throw { status: 400, message: `회식비 ${EVENTS.dinnerCost.toLocaleString()}원이 부족해요. 다른 선택을 해주세요.` };
  }

  db.prepare("UPDATE npc_events SET resolved = 1, choice_key = ? WHERE id = ?").run(choiceKey, eventId);

  // 면담 태도는 다음 평가 점수에 1회 반영된다(±5 범위로 제한).
  if (def.attitude) {
    const next = Math.max(-BOSS.attitude.apologize, Math.min(BOSS.attitude.apologize, state.attitude + def.attitude));
    db.prepare("UPDATE boss_state SET attitude = ? WHERE user_id = ? AND job_id = ?").run(next, userId, job.id);
  }

  if (def.effect === "set_project") {
    // 이미 프로젝트가 걸려 있으면 목표를 덮어쓰지 않는다(중복 수락으로 가산점을 쌓을 수 없다).
    db.prepare("UPDATE boss_state SET project_goal = ? WHERE user_id = ? AND job_id = ? AND project_goal = 0").run(
      EVENTS.projectGoal,
      userId,
      job.id
    );
  }
  if (def.effect === "pay_dinner") {
    applyLedgerEntry(userId, "회식비", -EVENTS.dinnerCost, job.id);
  }

  if (def.effect === "request_promotion") {
    if (state.rank >= MAX_RANK) {
      return { reply: "이미 최고 직급이에요. 더 올라갈 데가 없네요!", promoted: false };
    }
    if (state.good_streak < BOSS.promotionStreak) {
      return {
        reply: `성과는 좋지만 승진 심사는 좋은 평가(S/A)가 ${BOSS.promotionStreak}회 연속일 때 볼 수 있어요. (현재 ${state.good_streak}회 연속) 한 번만 더 보여줘요.`,
        promoted: false,
      };
    }
    const newRank = state.rank + 1;
    db.prepare("UPDATE boss_state SET rank = ?, good_streak = 0 WHERE user_id = ? AND job_id = ?").run(
      newRank,
      userId,
      job.id
    );
    const bonus = BOSS.promotionBonusPerRank * newRank;
    applyLedgerEntry(userId, "승진축하금", bonus, job.id);
    const info = rankInfo(newRank);
    const text = `축하해요! ${info.title}(으)로 승진입니다. 일급이 ×${info.payMultiplier}로 오르고, 축하금 ${bonus.toLocaleString()}원도 챙겨뒀어요.`;
    notify(userId, "npc", `👔 ${BOSS_NAME}: ${text}`);
    return { reply: text, promoted: true };
  }

  return { reply: def.reply(meta, { state }), promoted: false };
}

// ── 패널 ────────────────────────────────────────────────────────────
function greeting(rank: number, lastGrade: Grade | null): string {
  const title = rankInfo(rank).title;
  if (lastGrade === "S" || lastGrade === "A") {
    return pick([`어서 와요, ${title}. 지난 평가가 좋았으니 오늘도 기대할게요.`, "오늘도 힘내봅시다. 좋은 흐름이에요."]);
  }
  if (lastGrade === "C") {
    return pick(["왔어요? 이번 주엔 만회해봅시다.", "오늘은 집중해서 해봐요. 점수는 꾸준함에서 나와요."]);
  }
  return pick(["어서 와요. 오늘도 수고해요.", "좋은 아침이에요. 오늘 업무 시작해볼까요?"]);
}

// ── 직장 동료(workplace.ts)가 쓰는 조회/반영 함수 ─────────────────────
/** 이번 평가 기간의 근무 사실 요약(동료 NPC 프롬프트에 넣는다 — 모델이 기록을 지어내지 않게). */
export function workPeriodSummary(userId: number, jobId: number, today = todayKstDate()): { rankTitle: string; text: string } {
  const state = getState(userId, jobId, today);
  const stats = windowStats(userId, jobId, state.last_review_date);
  const rankTitle = rankInfo(state.rank).title;
  const text = stats.attempts
    ? `직급 ${rankTitle}, ${state.last_review_date}부터 근무 ${stats.workDays}일, 문제 ${stats.attempts}개, 정답률 ${Math.round(
        stats.accuracy * 100
      )}%, 잔업 ${stats.overtime}회${state.bad_streak > 0 ? `, 최근 부진 평가 ${state.bad_streak}회 연속` : ""}${
        state.good_streak > 0 ? `, 최근 좋은 평가 ${state.good_streak}회 연속` : ""
      }`
    : `직급 ${rankTitle}, 이번 평가 기간(${state.last_review_date}~)에는 아직 근무 기록이 없음`;
  return { rankTitle, text };
}

/**
 * 동료가 준 평가 가감점을 이번 기간 누적에 더한다. 누적은 ±WORKPLACE.evalAdjustPerPeriod로 잘리고,
 * 실제로 반영된 만큼(잘렸으면 0일 수도 있음)을 돌려준다. 다음 주간 평가에서 1회 쓰이고 0으로 초기화된다.
 */
export function addColleagueAdjust(userId: number, jobId: number, delta: number, today = todayKstDate()): number {
  const state = getState(userId, jobId, today);
  const cap = WORKPLACE.evalAdjustPerPeriod;
  const next = Math.max(-cap, Math.min(cap, state.colleague_adjust + delta));
  const applied = next - state.colleague_adjust;
  if (applied !== 0) {
    db.prepare("UPDATE boss_state SET colleague_adjust = ? WHERE user_id = ? AND job_id = ?").run(next, userId, jobId);
  }
  return applied;
}

export function getBossPanel(userId: number, today = todayKstDate()) {
  const job = activeJob(userId);
  if (!job) return { assigned: false as const };

  maybeReview(userId, job.id, today); // 기한이 지났으면 지금 평가를 내린다
  maybeTriggerBossEvent(userId); // 오늘의 랜덤 이벤트(하루 1회 판정)
  const state = getState(userId, job.id, today);
  const stats = windowStats(userId, job.id, state.last_review_date);
  const nextReviewDate = addDays(state.last_review_date, BOSS.reviewPeriodDays);

  const pending = db
    .prepare("SELECT * FROM npc_events WHERE user_id = ? AND npc = ? AND resolved = 0 ORDER BY id DESC LIMIT 1")
    .get(userId, NPC) as unknown as EventRow | undefined;
  const last = db
    .prepare("SELECT meta FROM npc_events WHERE user_id = ? AND npc = ? AND meta IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(userId, NPC) as { meta: string } | undefined;
  const lastGrade = last ? (JSON.parse(last.meta) as ReviewMeta).grade : null;

  const trust = managerTrust(userId);
  const reputation =
    trust >= MANAGER.trustedAt ? EVENTS.reputationAdjust : trust < MANAGER.watchBelow ? -EVENTS.reputationAdjust : 0;
  const projectAdj =
    state.project_goal > 0 ? (stats.overtime >= state.project_goal ? EVENTS.projectSuccessBonus : -EVENTS.projectFailPenalty) : 0;
  const projected = scoreOf(stats, state.attitude + reputation + projectAdj + state.colleague_adjust);
  return {
    assigned: true as const,
    job,
    npc: { name: BOSS_NAME, title: "직장 상사" },
    rank: rankInfo(state.rank),
    streaks: { good: state.good_streak, bad: state.bad_streak },
    review: {
      nextDate: nextReviewDate,
      daysLeft: Math.max(0, daysBetween(today, nextReviewDate)),
      periodDays: BOSS.reviewPeriodDays,
      // 이번 평가 기간의 현재까지 기록(실시간): 어떤 점수로 이어지는지 미리 보여준다
      progress: {
        attempts: stats.attempts,
        accuracy: Math.round(stats.accuracy * 100),
        workDays: stats.workDays,
        overtime: stats.overtime,
        projectedScore: stats.attempts ? projected : 0,
        projectedGrade: stats.attempts ? gradeOf(projected) : null,
      },
    },
    // NPC 간 연결: 마트 점장 신뢰도가 이 직장 평가에 ±점수로 반영된다.
    reputation: { managerTrust: trust, adjust: reputation },
    // 직장 동료와의 대화에서 받은 평가 가감점(누적, 다음 평가에 1회 반영)
    colleagueAdjust: state.colleague_adjust,
    project: state.project_goal > 0 ? { goal: state.project_goal, overtime: stats.overtime } : null,
    rules: [
      `마트 점장 신뢰도 ${MANAGER.trustedAt}↑ 이면 평가 +${EVENTS.reputationAdjust}점, ${MANAGER.watchBelow} 미만이면 -${EVENTS.reputationAdjust}점(평판)`,
      `평가는 ${BOSS.reviewPeriodDays}일마다 · 최소 ${BOSS.minWorkDays}일 근무 + ${BOSS.minAttempts}문제 필요(미달 시 보류)`,
      "점수 = 정답률 60 + 근무일수 25(5일 만점) + 잔업 15(5회 만점) + 면담 태도(±5)",
      `직장 동료와의 대화에서 받은 가감점(평가 기간 누적 ±${WORKPLACE.evalAdjustPerPeriod}점)도 반영`,
      `S ${BOSS.gradeS}점↑ / A ${BOSS.gradeA}점↑ / B ${BOSS.gradeB}점↑ / 그 미만 C`,
      `S·A가 ${BOSS.promotionStreak}회 연속이면 승진 심사 요청 가능(직급별 일급 ×${BOSS.ranks.map((r) => r.payMultiplier).join(" → ×")})`,
      `C가 ${BOSS.demotionStreak}회 연속이면 한 직급 강등`,
    ],
    greeting: greeting(state.rank, lastGrade),
    event: pending ? toPanelEvent(pending) : null,
  };
}
