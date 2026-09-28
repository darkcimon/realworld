// 점장 NPC(마트 알바) — "감독(Director) + 제한된 도구" 구조.
//  1) 서버가 근무 기록(사실)을 남기고,
//  2) 점장이 그 기록을 보고 정해진 행동(칭찬/보너스/경고/면담/특별 근무 제안) 중 하나를 고르고,
//  3) 플레이어는 미리 정해진 선택지 버튼으로 응답하며,
//  4) 돈과 상태 변경은 전부 서버가 economy.ts의 상한 안에서만 실행한다.
// 판단은 규칙 기반이라 LLM 없이도 동작하고(테스트/재현 가능), 대사 부분만 나중에 LLM으로 바꿔 끼울 수 있다.
// 플레이어의 자유 입력은 받지 않으므로 프롬프트 주입으로 보상을 얻어낼 방법이 없다.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { EVENTS, MANAGER } from "../economy.js";
import { notify } from "./notifications.js";
import { todayKstDate } from "./lottery.js";
import { bestBossRank, claimDailyRoll, pickRandom } from "./npcShared.js";

const NPC = "manager";
export const MANAGER_NAME = "김점장";

export type TierKey = "trusted" | "normal" | "watch";
export type EventKind =
  | "praise_bonus"
  | "praise"
  | "neutral"
  | "warn"
  | "interview"
  | "rush_offer"
  | "evt_angry"
  | "evt_stock"
  | "evt_rumor";

interface StateRow {
  user_id: number;
  npc: string;
  trust: number;
  warnings: number;
  gain_date: string | null;
  gain_today: number;
  task_kind: string | null;
  task_remaining: number;
}

interface EventRow {
  id: number;
  kind: EventKind;
  message: string;
  choices: string;
  resolved: number;
}

// ── 상태 ────────────────────────────────────────────────────────────
function getState(userId: number): StateRow {
  db.prepare("INSERT OR IGNORE INTO npc_state (user_id, npc) VALUES (?, ?)").run(userId, NPC);
  return db
    .prepare("SELECT * FROM npc_state WHERE user_id = ? AND npc = ?")
    .get(userId, NPC) as unknown as StateRow;
}

export function tierOf(trust: number): { key: TierKey; label: string; wageMultiplier: number } {
  if (trust >= MANAGER.trustedAt) {
    return { key: "trusted", label: "믿음직한 직원", wageMultiplier: MANAGER.trustedWageMultiplier };
  }
  if (trust < MANAGER.watchBelow) {
    return { key: "watch", label: "요주의 직원", wageMultiplier: MANAGER.watchWageMultiplier };
  }
  return { key: "normal", label: "일반 직원", wageMultiplier: 1 };
}

/**
 * 신뢰도를 바꾼다. 올리는 방향은 하루 상한(dailyTrustGainCap)이 있어 같은 날 반복 근무로
 * 신뢰도를 무한히 파밍할 수 없다. 내리는 방향은 제한이 없다. 실제로 반영된 변화량을 돌려준다.
 */
function addTrust(userId: number, delta: number): number {
  const state = getState(userId);
  const today = todayKstDate();
  const gainedToday = state.gain_date === today ? state.gain_today : 0;

  let applied = delta;
  if (delta > 0) applied = Math.max(0, Math.min(delta, MANAGER.dailyTrustGainCap - gainedToday));
  const next = Math.max(0, Math.min(100, state.trust + applied));
  applied = next - state.trust;

  db.prepare(
    "UPDATE npc_state SET trust = ?, gain_date = ?, gain_today = ? WHERE user_id = ? AND npc = ?"
  ).run(next, today, applied > 0 ? gainedToday + applied : gainedToday, userId, NPC);
  return applied;
}

/** 거래 1건당 시급 배수: 신뢰도 등급 배수 × (특별 근무 중이면 rushWageMultiplier). */
export function wageMultiplier(userId: number): { total: number; rush: boolean } {
  const state = getState(userId);
  const rush = state.task_kind === "rush" && state.task_remaining > 0;
  return {
    total: tierOf(state.trust).wageMultiplier * (rush ? MANAGER.rushWageMultiplier : 1),
    rush,
  };
}

/** 거래 1건이 끝날 때마다 호출. 특별 근무 중이면 남은 건수를 줄이고 끝나면 보상(신뢰도 + 알림)을 준다. */
export function onTransactionRecorded(userId: number): { rushRemaining: number | null } {
  const state = getState(userId);
  if (state.task_kind !== "rush" || state.task_remaining <= 0) return { rushRemaining: null };

  const remaining = state.task_remaining - 1;
  if (remaining > 0) {
    db.prepare("UPDATE npc_state SET task_remaining = ? WHERE user_id = ? AND npc = ?").run(
      remaining,
      userId,
      NPC
    );
    return { rushRemaining: remaining };
  }
  db.prepare(
    "UPDATE npc_state SET task_kind = NULL, task_remaining = 0 WHERE user_id = ? AND npc = ?"
  ).run(userId, NPC);
  addTrust(userId, 3);
  notify(userId, "npc", `🧑‍💼 ${MANAGER_NAME}: 바쁜 시간대를 잘 버텨줬네요. 정말 든든했어요!`);
  return { rushRemaining: 0 };
}

// ── 대사/선택지 ─────────────────────────────────────────────────────
// 같은 상황이라도 매번 똑같이 말하지 않도록 변형 문장을 두고 무작위로 고른다.
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

interface ChoiceDef {
  label: string;
  trust: number;
  reply: string;
  effect?: "offer_rush" | "accept_rush";
  // 이 선택으로 걸리는 임시 효과: 다음 remaining건의 거래에 시급/페널티 배수를 곱한다.
  modifiers?: { kind: "wage_scale" | "penalty_scale"; remaining: number; value: number }[];
}

const CHOICES: Record<EventKind, Record<string, ChoiceDef>> = {
  praise_bonus: {
    thanks: { label: "감사합니다, 점장님!", trust: 1, reply: "허허, 앞으로도 이 페이스로 부탁해요." },
    ask_more: {
      label: "더 큰 일도 맡겨주세요",
      trust: 0,
      reply: "의욕이 좋네요. 그럼 한번 맡겨볼까요?",
      effect: "offer_rush",
    },
  },
  praise: {
    thanks: { label: "감사합니다!", trust: 1, reply: "네, 수고했어요. 다음에도 기대할게요." },
    ask_more: {
      label: "더 큰 일도 맡겨주세요",
      trust: 0,
      reply: "의욕이 좋네요. 그럼 한번 맡겨볼까요?",
      effect: "offer_rush",
    },
  },
  neutral: {
    ok: { label: "네, 알겠습니다", trust: 0, reply: "그래요. 수고했어요." },
    tips: {
      label: "잘 계산하는 요령이 있을까요?",
      trust: 1,
      reply: "500원 단위라서 천 원 단위로 묶어서 먼저 더하고, 남는 500원을 마지막에 더해보세요.",
    },
  },
  warn: {
    apologize: {
      label: "죄송합니다, 더 집중할게요",
      trust: 3,
      reply: "실수는 누구나 해요. 다음엔 한 번 더 확인하고 입력하세요.",
    },
    excuse: {
      label: "손님이 너무 몰려서요...",
      trust: -1,
      reply: "바쁠수록 정확해야 하는 거예요. 핑계는 곤란합니다.",
    },
    ask_help: {
      label: "계산 요령을 알려주세요",
      trust: 1,
      reply: "천 원 단위로 묶어서 먼저 더하고, 남는 500원을 마지막에 더하세요. 입력 전에 한 번만 다시 보고요.",
    },
  },
  interview: {
    promise: {
      label: "정신 차리고 다시 열심히 하겠습니다",
      trust: 5,
      reply: "좋아요. 그 말, 기억해 둘게요. 다시 기회를 드리죠.",
    },
    ask_help: {
      label: "요령을 다시 배우고 싶습니다",
      trust: 3,
      reply: "그래요, 기본부터 다시 짚어봅시다. 천 원 단위로 묶어 더하는 것부터요.",
    },
  },
  // ── 랜덤 이벤트: 선택마다 위험/보상이 다르다 ──
  evt_angry: {
    calm: {
      label: "침착하게 직접 응대한다",
      trust: 0,
      reply: `좋아요, 맡길게요. 다음 ${EVENTS.angryTx}건은 시급 ×${EVENTS.angryWageScale}이지만 이런 손님 앞에선 실수하면 페널티도 ×${EVENTS.angryPenaltyScale}이에요. 집중해요!`,
      modifiers: [
        { kind: "wage_scale", remaining: EVENTS.angryTx, value: EVENTS.angryWageScale },
        { kind: "penalty_scale", remaining: EVENTS.angryTx, value: EVENTS.angryPenaltyScale },
      ],
    },
    call: {
      label: "점장님을 불러온다",
      trust: -2,
      reply: "...알겠어요, 제가 나가볼게요. 다음엔 스스로 해결해보려고 해봐요.",
    },
  },
  evt_stock: {
    help: {
      label: "네, 도와드릴게요",
      trust: EVENTS.stockTrust,
      reply: `고마워요! 그동안 계산대는 비우게 되니 다음 ${EVENTS.stockTx}건은 시급을 못 쳐드려요. 대신 잊지 않을게요.`,
      modifiers: [{ kind: "wage_scale", remaining: EVENTS.stockTx, value: 0 }],
    },
    decline: {
      label: "죄송해요, 지금은 바빠서요",
      trust: -1,
      reply: "그래요, 어쩔 수 없죠. 다음에 부탁할게요.",
    },
  },
  evt_rumor: {
    thanks: {
      label: "감사합니다, 점장님 덕분이에요",
      trust: 2,
      reply: "허허, 우리 마트 출신이 잘되니 나도 뿌듯하네요.",
    },
    modest: {
      label: "아직 갈 길이 멀어요",
      trust: 1,
      reply: "그 겸손함이 사람을 키우는 거예요.",
    },
  },
  rush_offer: {
    accept: {
      label: "해볼게요!",
      trust: 1,
      reply: `좋아요! 다음 ${MANAGER.rushTx}건은 시급을 ${MANAGER.rushWageMultiplier}배로 쳐드릴게요. 대신 틀리면 평소대로 차감이에요.`,
      effect: "accept_rush",
    },
    decline: {
      label: "오늘은 괜찮습니다",
      trust: 0,
      reply: "그래요, 무리할 필요 없죠. 마음 바뀌면 말해요.",
    },
  },
};

// ── 이벤트 생성 ─────────────────────────────────────────────────────
function createEvent(
  userId: number,
  kind: EventKind,
  message: string,
  choiceKeys: string[],
  shiftId: number | null
): number {
  // 답하지 않은 이전 이벤트는 정리해서 항상 "지금 답할 이벤트"가 하나만 남게 한다.
  db.prepare(
    "UPDATE npc_events SET resolved = 1 WHERE user_id = ? AND npc = ? AND resolved = 0"
  ).run(userId, NPC);
  const row = db
    .prepare(
      "INSERT INTO npc_events (user_id, npc, kind, message, choices, shift_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(userId, NPC, kind, message, JSON.stringify(choiceKeys), shiftId);
  return Number(row.lastInsertRowid);
}

function bonusGivenToday(userId: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM npc_events WHERE user_id = ? AND npc = ? AND kind = 'praise_bonus' AND date(created_at, '+9 hours') = ? LIMIT 1"
    )
    .get(userId, NPC, todayKstDate());
  return !!row;
}

/**
 * 근무 종료 시 호출. 그 근무의 정확도를 보고 점장의 반응을 결정한다.
 *  - 정확도 90%+  : 칭찬(+신뢰도). 10건 이상이고 오늘 아직 보너스가 없으면 소액 보너스도 준다.
 *  - 정확도 60~89%: 무난(신뢰도 소폭 상승).
 *  - 정확도 60%↓  : 경고(신뢰도 하락). 신뢰도가 바닥이고 경고가 누적되면 면담.
 * 너무 짧은 근무(minTxToEvaluate 미만)는 평가하지 않는다.
 */
export function evaluateShift(userId: number, shiftId: number): { kind: EventKind; bonus: number } | null {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN error_amount = 0 THEN 1 ELSE 0 END), 0) AS correct,
              COALESCE(SUM(penalty), 0) AS penalty
       FROM mart_transactions WHERE shift_id = ?`
    )
    .get(shiftId) as { total: number; correct: number; penalty: number };
  if (stats.total < MANAGER.minTxToEvaluate) return null;

  const accuracy = stats.correct / stats.total;
  const pct = Math.round(accuracy * 100);
  const state = getState(userId);

  let kind: EventKind;
  let bonus = 0;
  let message: string;
  let choiceKeys: string[];

  if (accuracy >= 0.9) {
    addTrust(userId, 5);
    db.prepare("UPDATE npc_state SET warnings = 0 WHERE user_id = ? AND npc = ?").run(userId, NPC);
    const canBonus = stats.total >= MANAGER.minTxForBonus && !bonusGivenToday(userId);
    if (canBonus) {
      bonus = Math.min(MANAGER.bonusMax, stats.total * MANAGER.bonusPerTx);
      applyLedgerEntry(userId, "점장보너스", bonus, shiftId);
      kind = "praise_bonus";
      message = pick([
        `${stats.total}건 중 ${pct}% 정확! 오늘 계산대 아주 깔끔했어요. 수고비 ${bonus.toLocaleString()}원 챙겨뒀어요.`,
        `와, 정확도 ${pct}%라니. 이런 직원 흔치 않아요. 약소하지만 ${bonus.toLocaleString()}원 보너스입니다.`,
      ]);
    } else {
      kind = "praise";
      message = pick([
        `${stats.total}건 중 ${pct}% 정확했어요. 오늘도 든든했습니다.`,
        `계산이 정확하네요(${pct}%). 손님들 줄이 금방 줄었어요.`,
      ]);
    }
    const trustNow = getState(userId).trust;
    choiceKeys = trustNow >= MANAGER.rushOfferMinTrust ? ["thanks", "ask_more"] : ["thanks"];
  } else if (accuracy >= 0.6) {
    addTrust(userId, 1);
    kind = "neutral";
    message = pick([
      `${stats.total}건 중 ${stats.correct}건 정확(${pct}%)이네요. 나쁘지 않은데, 조금만 더 신경 써주세요.`,
      `무난했어요(${pct}%). 틀린 건 다음엔 한 번 더 확인하고 입력해봐요.`,
    ]);
    choiceKeys = ["ok", "tips"];
  } else {
    const nextWarnings = state.warnings + 1;
    addTrust(userId, -8);
    db.prepare("UPDATE npc_state SET warnings = ? WHERE user_id = ? AND npc = ?").run(nextWarnings, userId, NPC);
    const trustNow = getState(userId).trust;
    if (trustNow < MANAGER.watchBelow && nextWarnings >= 3) {
      kind = "interview";
      message = `잠깐 얘기 좀 합시다. 최근 연속으로 실수가 너무 많아요(오늘 ${pct}%, 손해 ${stats.penalty.toLocaleString()}원). 이대로면 계산대를 맡기기 어려워요.`;
      choiceKeys = ["promise", "ask_help"];
      db.prepare("UPDATE npc_state SET warnings = 0 WHERE user_id = ? AND npc = ?").run(userId, NPC);
    } else {
      kind = "warn";
      message = pick([
        `${stats.total}건 중 ${stats.correct}건만 맞았어요(${pct}%). 틀린 금액 때문에 ${stats.penalty.toLocaleString()}원 손해가 났어요.`,
        `오늘 계산 실수가 잦았어요(${pct}%). 계산대는 정확함이 생명이에요.`,
      ]);
      choiceKeys = ["apologize", "excuse", "ask_help"];
    }
  }

  createEvent(userId, kind, message, choiceKeys, shiftId);
  notify(userId, "npc", `🧑‍💼 ${MANAGER_NAME}: ${message}`);
  return { kind, bonus };
}

// ── 플레이어 응답 ───────────────────────────────────────────────────
export function chooseOption(
  userId: number,
  eventId: number,
  choiceKey: string
): { reply: string; trustChange: number; next: PanelEvent | null } {
  const event = db
    .prepare("SELECT * FROM npc_events WHERE id = ? AND user_id = ? AND npc = ?")
    .get(eventId, userId, NPC) as unknown as EventRow | undefined;
  if (!event) throw { status: 404, message: "존재하지 않는 대화입니다." };
  if (event.resolved) throw { status: 409, message: "이미 응답한 대화입니다." };

  // 서버가 제시한 선택지 안의 키만 인정한다.
  const offered = JSON.parse(event.choices) as string[];
  const def = offered.includes(choiceKey) ? CHOICES[event.kind]?.[choiceKey] : undefined;
  if (!def) throw { status: 400, message: "올바르지 않은 선택입니다." };

  let reply = def.reply;
  let next: PanelEvent | null = null;

  db.prepare("UPDATE npc_events SET resolved = 1, choice_key = ? WHERE id = ?").run(choiceKey, eventId);
  const trustChange = addTrust(userId, def.trust);
  for (const m of def.modifiers ?? []) {
    db.prepare("INSERT INTO npc_modifiers (user_id, kind, remaining, value) VALUES (?, ?, ?, ?)").run(
      userId,
      m.kind,
      m.remaining,
      m.value
    );
  }

  if (def.effect === "offer_rush") {
    const state = getState(userId);
    if (state.trust >= MANAGER.rushOfferMinTrust && state.task_kind !== "rush") {
      const offerId = createEvent(
        userId,
        "rush_offer",
        `마침 손님이 몰리는 시간대예요. 다음 ${MANAGER.rushTx}건은 시급 ${MANAGER.rushWageMultiplier}배로 쳐줄 테니 맡아볼래요? (틀리면 평소대로 차감이에요)`,
        ["accept", "decline"],
        null
      );
      next = toPanelEvent(db.prepare("SELECT * FROM npc_events WHERE id = ?").get(offerId) as unknown as EventRow);
    } else {
      reply = state.task_kind === "rush" ? "이미 특별 근무 중이잖아요. 먼저 그것부터 끝내요." : "음, 아직은 좀 이른 것 같아요. 조금만 더 지켜볼게요.";
    }
  } else if (def.effect === "accept_rush") {
    const state = getState(userId);
    if (state.task_kind !== "rush") {
      db.prepare("UPDATE npc_state SET task_kind = 'rush', task_remaining = ? WHERE user_id = ? AND npc = ?").run(
        MANAGER.rushTx,
        userId,
        NPC
      );
    }
  }

  return { reply, trustChange, next };
}

// ── 임시 효과(modifier): 이벤트 선택으로 걸리는 "다음 N건" 배수 ──────────────
export function activeScales(userId: number): { wageScale: number; penaltyScale: number } {
  const rows = db
    .prepare("SELECT kind, value FROM npc_modifiers WHERE user_id = ? AND remaining > 0")
    .all(userId) as { kind: string; value: number }[];
  let wageScale = 1;
  let penaltyScale = 1;
  for (const r of rows) {
    if (r.kind === "wage_scale") wageScale *= r.value;
    if (r.kind === "penalty_scale") penaltyScale *= r.value;
  }
  return { wageScale, penaltyScale };
}

/** 거래 1건이 끝날 때마다 호출: 남은 건수를 줄이고 다 쓴 효과는 지운다. */
export function consumeModifiers(userId: number): void {
  db.prepare("UPDATE npc_modifiers SET remaining = remaining - 1 WHERE user_id = ? AND remaining > 0").run(userId);
  db.prepare("DELETE FROM npc_modifiers WHERE user_id = ? AND remaining <= 0").run(userId);
}

function activeModifierSummary(userId: number) {
  const rows = db
    .prepare("SELECT kind, remaining, value FROM npc_modifiers WHERE user_id = ? AND remaining > 0 ORDER BY id")
    .all(userId) as { kind: string; remaining: number; value: number }[];
  return rows.map((r) => ({ kind: r.kind, remaining: r.remaining, value: r.value }));
}

// ── 랜덤 이벤트 ─────────────────────────────────────────────────────
/**
 * 근무 시작 시 호출. 오늘 아직 판정하지 않았고 답하지 않은 대화가 없을 때만 확률(EVENTS.chance)로
 * 이벤트가 발생하며, 신뢰도/직장 직급에 맞는 후보 중 하나가 뽑힌다. rng는 테스트에서 주입한다.
 */
export function maybeTriggerEvent(userId: number, rng: () => number = Math.random): { kind: EventKind } | null {
  const pending = db
    .prepare("SELECT 1 FROM npc_events WHERE user_id = ? AND npc = ? AND resolved = 0 LIMIT 1")
    .get(userId, NPC);
  if (pending) return null;
  if (!claimDailyRoll(userId, "manager")) return null;
  if (rng() >= EVENTS.chance) return null;

  const trust = getState(userId).trust;
  const candidates: { kind: EventKind; message: string; choices: string[] }[] = [
    {
      kind: "evt_angry",
      message: "계산대에 까다로운 손님이 서 계세요. 큰소리로 재촉하고 있네요... 어떻게 할래요?",
      choices: ["calm", "call"],
    },
  ];
  if (trust >= EVENTS.stockMinTrust) {
    candidates.push({
      kind: "evt_stock",
      message: "마침 물건이 잔뜩 들어왔는데 손이 모자라요. 잠깐 재고 정리를 도와줄 수 있어요?",
      choices: ["help", "decline"],
    });
  }
  if (bestBossRank(userId) >= EVENTS.rumorMinBossRank) {
    candidates.push({
      kind: "evt_rumor",
      message: "직장에서 승진했다는 얘기 들었어요! 여기서 일 배운 게 도움이 됐다니 뿌듯하네요.",
      choices: ["thanks", "modest"],
    });
  }
  const picked = pickRandom(candidates, rng);
  createEvent(userId, picked.kind, picked.message, picked.choices, null);
  notify(userId, "npc", `🧑‍💼 ${MANAGER_NAME}: ${picked.message}`);
  return { kind: picked.kind };
}

// ── 패널 상태(클라이언트 표시용) ─────────────────────────────────────
export interface PanelEvent {
  id: number;
  kind: EventKind;
  message: string;
  choices: { key: string; label: string }[];
}

function toPanelEvent(row: EventRow): PanelEvent {
  const keys = JSON.parse(row.choices) as string[];
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    choices: keys.map((k) => ({ key: k, label: CHOICES[row.kind][k].label })),
  };
}

function greeting(tier: TierKey, bossRank: number): string {
  // NPC 간 연결: 플레이어가 직장에서 승진했다면 점장도 그 소식을 알고 있다.
  if (bossRank >= EVENTS.rumorMinBossRank && Math.random() < 0.4) {
    return pick([
      "직장에서 승진했다는 소문 들었어요. 우리 마트에서도 계속 도와줄 거죠?",
      "요즘 회사에서 잘나간다면서요? 여기 일도 잊지 말아요.",
    ]);
  }
  if (tier === "trusted") {
    return pick([
      "어서 와요! 오늘도 계산대는 믿고 맡길게요.",
      "왔군요. 손님 많은 시간대엔 역시 당신이 있어야 안심이에요.",
    ]);
  }
  if (tier === "watch") {
    return pick([
      "왔어요? 오늘은 정확하게 부탁해요. 실수가 계속되면 곤란합니다.",
      "요즘 실수가 잦았죠. 오늘은 한 번 더 확인하고 입력하세요.",
    ]);
  }
  return pick(["어서 와요. 오늘도 잘 부탁해요.", "출근했군요. 계산은 천천히, 정확하게!"]);
}

export function getManagerPanel(userId: number) {
  const state = getState(userId);
  const tier = tierOf(state.trust);
  const pending = db
    .prepare(
      "SELECT * FROM npc_events WHERE user_id = ? AND npc = ? AND resolved = 0 ORDER BY id DESC LIMIT 1"
    )
    .get(userId, NPC) as unknown as EventRow | undefined;

  const rush = state.task_kind === "rush" && state.task_remaining > 0;
  return {
    npc: { name: MANAGER_NAME, title: "마트 점장" },
    trust: state.trust,
    tier,
    // 기준 공개: 어떤 행동이 신뢰도에 영향을 주는지 플레이어가 알 수 있게 한다.
    rules: [
      `근무 ${MANAGER.minTxToEvaluate}건 이상, 정확도 90%↑ → 칭찬(신뢰도 +5)`,
      `근무 ${MANAGER.minTxForBonus}건 이상 + 90%↑ → 하루 1회 보너스`,
      "정확도 60%↓ → 경고(신뢰도 -8)",
      `신뢰도 ${MANAGER.trustedAt}↑ 시급 ×${MANAGER.trustedWageMultiplier} / ${MANAGER.watchBelow}↓ 시급 ×${MANAGER.watchWageMultiplier}`,
      `신뢰도 ${MANAGER.rushOfferMinTrust}↑ 이면 특별 근무 제안 가능`,
    ],
    greeting: greeting(tier.key, bestBossRank(userId)),
    modifiers: activeModifierSummary(userId),
    event: pending ? toPanelEvent(pending) : null,
    task: rush ? { kind: "rush" as const, remaining: state.task_remaining, wageMultiplier: MANAGER.rushWageMultiplier } : null,
  };
}
