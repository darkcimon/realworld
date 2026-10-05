// README 7장: 로또. 만원 단위 구매, 회차당 3개 제한, 매일 09:00·12:00·15:00·18:00 KST 네 번 추첨.
// 1~4등 상금표는 README에 정확한 금액이 나와 있지 않아 임의의 기본값을 두고,
// "10명 단위마다 1등 당첨금 범위 2배 보정" 규칙만 문서 그대로 구현한다.
import { db } from "../db.js";
import { applyLedgerEntry, getBalance } from "../wallet/ledger.js";
import { notify } from "./notifications.js";

export const DAILY_TICKET_LIMIT = 3; // 회차당 구매 가능 수
// 하루 추첨 시각(KST, 시). 회차 키는 "YYYY-MM-DD HH:00" 형식이다.
// 예전 회차(하루 1회 시절)는 키가 "YYYY-MM-DD"이고 그날 19:00에 추첨된다.
export const DRAW_HOURS = [9, 12, 15, 18];
const LEGACY_DRAW_HOUR = 19;

const TIER1_BASE = { min: 1_000_000, max: 5_000_000 };
const TIER2 = { min: 300_000, max: 1_000_000 };
const TIER3 = { min: 100_000, max: 300_000 };
const TIER4_PRIZE = 20_000; // 응모가 무료라 "원금의 2배" 대신 고정 금액(예전 1만원 응모의 2배와 같다)

const TIER_ODDS: { tier: "1" | "2" | "3" | "4"; pct: number }[] = [
  { tier: "1", pct: 5 },
  { tier: "2", pct: 10 },
  { tier: "3", pct: 20 },
  { tier: "4", pct: 50 },
]; // 나머지 15%는 낙첨

export function todayKstDate(): string {
  // KST = UTC+9. 서버 로컬 타임존과 무관하게 항상 KST 기준 날짜를 구한다.
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function roundKey(date: string, hour: number): string {
  return `${date} ${String(hour).padStart(2, "0")}:00`;
}

/** 회차 키의 추첨 시각(epoch ms). 예전 날짜형 키는 그날 19:00 KST. */
function drawTimeOf(key: string): number {
  const [date, time] = key.split(" ");
  const hour = time ? Number(time.slice(0, 2)) : LEGACY_DRAW_HOUR;
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour) - 9 * 60 * 60 * 1000;
}

function ensureRound(roundDate: string): { id: number } {
  db.prepare("INSERT OR IGNORE INTO lottery_rounds (round_date) VALUES (?)").run(roundDate);
  return db.prepare("SELECT id FROM lottery_rounds WHERE round_date = ?").get(roundDate) as {
    id: number;
  };
}

function isRoundDrawn(roundDate: string): boolean {
  const round = db
    .prepare("SELECT drawn_at FROM lottery_rounds WHERE round_date = ?")
    .get(roundDate) as { drawn_at: string | null } | undefined;
  return !!round?.drawn_at;
}

function addDaysToKstDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * 지금 구매하면 실제로 어느 회차에 들어갈지 정한다. 하루 네 번(09·12·15·18시 KST) 추첨하므로
 * 추첨 시각이 아직 오지 않았고 추첨 전인 가장 가까운 회차에 들어간다. 18시가 지나면
 * 다음 날 09시 회차로 넘어간다. (추첨 끝난 회차에 묶여 당첨 기회 없이 돈만 차감되는 것을 막는다.)
 */
function resolvePurchaseRoundDate(): string {
  const now = Date.now();
  const today = todayKstDate();
  for (const date of [today, addDaysToKstDate(today, 1)]) {
    for (const hour of DRAW_HOURS) {
      const key = roundKey(date, hour);
      if (drawTimeOf(key) > now && !isRoundDrawn(key)) return key;
    }
  }
  return roundKey(addDaysToKstDate(today, 2), DRAW_HOURS[0]);
}

export function buyTicket(userId: number, units: number): {
  ticketId: number;
  amount: number;
  slot: number;
  balance: number;
  roundDate: string;
} {
  if (!Number.isInteger(units) || units < 1) {
    throw { status: 400, message: "응모권 수가 올바르지 않아요." };
  }
  const roundDate = resolvePurchaseRoundDate();
  const boughtToday = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM lottery_tickets WHERE user_id = ? AND round_date = ?"
      )
      .get(userId, roundDate) as { c: number }
  ).c;
  if (boughtToday >= DAILY_TICKET_LIMIT) {
    throw { status: 403, message: `로또 응모권은 회차당 ${DAILY_TICKET_LIMIT}장까지예요.` };
  }

  // 응모는 무료다(게임머니를 걸지 않는다) — 돈을 걸고 무작위로 따거나 잃는 "시뮬레이션 도박"이 되지 않게.
  // 장수 제한(회차당 DAILY_TICKET_LIMIT)은 그대로. amount는 기록용으로 0을 남긴다.
  const amount = 0;
  const balance = getBalance(userId);
  ensureRound(roundDate);
  const result = db
    .prepare(
      "INSERT INTO lottery_tickets (user_id, round_date, amount, slot) VALUES (?, ?, ?, ?)"
    )
    .run(userId, roundDate, amount, boughtToday + 1);

  return {
    ticketId: Number(result.lastInsertRowid),
    amount,
    slot: boughtToday + 1,
    balance,
    roundDate,
  };
}

/** buyTicket과 동일한 회차 판단 기준을 사용해, "지금 사면 들어가는 회차"의 현황을 보여준다. */
export function getTodayStatus(userId: number) {
  const roundDate = resolvePurchaseRoundDate();
  const tickets = db
    .prepare(
      "SELECT * FROM lottery_tickets WHERE user_id = ? AND round_date = ? ORDER BY slot"
    )
    .all(userId, roundDate);
  const round = db.prepare("SELECT * FROM lottery_rounds WHERE round_date = ?").get(roundDate);
  return {
    roundDate,
    drawAt: new Date(drawTimeOf(roundDate)).toISOString(),
    drawHours: DRAW_HOURS,
    tickets,
    remaining: DAILY_TICKET_LIMIT - tickets.length,
    round,
  };
}

export function getRound(roundDate: string, userId?: number) {
  const round = db.prepare("SELECT * FROM lottery_rounds WHERE round_date = ?").get(roundDate) as
    | any
    | undefined;
  if (!round) return null;
  const myResults = userId
    ? db
        .prepare("SELECT * FROM lottery_results WHERE round_id = ? AND user_id = ?")
        .all(round.id, userId)
    : undefined;
  return { ...round, myResults };
}

function randomInRange(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

/** 아직 추첨되지 않은 회차를 추첨한다. 이미 추첨된 회차면 아무 것도 하지 않는다. */
export function drawRound(roundDate: string): {
  drawn: boolean;
  participantCount?: number;
  tier1Min?: number;
  tier1Max?: number;
} {
  const round = db.prepare("SELECT * FROM lottery_rounds WHERE round_date = ?").get(roundDate) as
    | any
    | undefined;
  if (!round || round.drawn_at) return { drawn: false };

  const tickets = db
    .prepare("SELECT * FROM lottery_tickets WHERE round_date = ?")
    .all(roundDate) as any[];

  const participantCount = new Set(tickets.map((t) => t.user_id)).size;
  const units = Math.floor(participantCount / 10);
  const multiplier = 2 ** units; // README: 10명 단위마다 1등 당첨금 범위 2배 보정
  const tier1Min = TIER1_BASE.min * multiplier;
  const tier1Max = TIER1_BASE.max * multiplier;

  // 유저별 당첨 요약(알림용): 여러 장을 샀어도 알림은 회차당 1건만 보낸다.
  const summary = new Map<number, { prize: number; bestTier: number }>();

  for (const ticket of tickets) {
    const roll = Math.random() * 100;
    let cumulative = 0;
    let awarded: { tier: "1" | "2" | "3" | "4" | "낙첨"; prize: number } = {
      tier: "낙첨",
      prize: 0,
    };
    for (const { tier, pct } of TIER_ODDS) {
      cumulative += pct;
      if (roll < cumulative) {
        const prize =
          tier === "1"
            ? randomInRange(tier1Min, tier1Max)
            : tier === "2"
              ? randomInRange(TIER2.min, TIER2.max)
              : tier === "3"
                ? randomInRange(TIER3.min, TIER3.max)
                : TIER4_PRIZE;
        awarded = { tier, prize };
        break;
      }
    }

    db.prepare(
      "INSERT INTO lottery_results (round_id, ticket_id, user_id, tier, prize_amount) VALUES (?, ?, ?, ?, ?)"
    ).run(round.id, ticket.id, ticket.user_id, awarded.tier, awarded.prize);

    if (awarded.prize > 0) {
      applyLedgerEntry(ticket.user_id, "로또당첨", awarded.prize, ticket.id);
    }

    const sum = summary.get(ticket.user_id) ?? { prize: 0, bestTier: 99 };
    sum.prize += awarded.prize;
    if (awarded.tier !== "낙첨") sum.bestTier = Math.min(sum.bestTier, Number(awarded.tier));
    summary.set(ticket.user_id, sum);
  }

  for (const [userId, sum] of summary) {
    notify(
      userId,
      "lottery",
      sum.prize > 0
        ? `🎰 ${roundDate} 회차 로또 결과: ${sum.bestTier}등 당첨! 총 ${sum.prize.toLocaleString()}원이 지급되었어요.`
        : `🎰 ${roundDate} 회차 로또 결과: 아쉽게도 낙첨이에요. 다음 회차를 노려보세요!`
    );
  }

  db.prepare(
    "UPDATE lottery_rounds SET participant_count = ?, tier1_min = ?, tier1_max = ?, drawn_at = datetime('now') WHERE id = ?"
  ).run(participantCount, tier1Min, tier1Max, round.id);

  return { drawn: true, participantCount, tier1Min, tier1Max };
}

/**
 * 추첨 시각이 지났는데 아직 추첨 전인 회차를 모두 추첨한다. 1분마다 폴링해 호출한다.
 * 서버가 꺼져 있던 동안 지나간 회차(예전 날짜형 회차 포함)도 여기서 뒤늦게 추첨된다.
 */
export function drawTodayIfDue(): void {
  const now = Date.now();
  const today = todayKstDate();
  for (const hour of DRAW_HOURS) {
    const key = roundKey(today, hour);
    if (drawTimeOf(key) <= now) ensureRound(key);
  }
  const pending = db
    .prepare("SELECT round_date FROM lottery_rounds WHERE drawn_at IS NULL")
    .all() as { round_date: string }[];
  for (const { round_date } of pending) {
    if (drawTimeOf(round_date) <= now) drawRound(round_date);
  }
}

let scheduler: NodeJS.Timeout | null = null;

export function startLotteryScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(drawTodayIfDue, 60_000);
  drawTodayIfDue();
}
