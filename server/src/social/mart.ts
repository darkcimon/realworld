// README 6.3: 알바 — 마트. 계산 오차만큼 즉시 페널티가 차감되고(하한 0원),
// 각 거래 시점에 분급(1분 단위 시급)도 함께 지급되어 결과적으로 "틀리면 그 자리에서
// 지갑 잔액이 줄어드는" 체감을 만든다. 근무 자체는 매 거래를 1분으로 취급하는 단순 모델이다.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { ALBA_SPEED, VITALS } from "../economy.js";
import { assertCanWork, spendWorkStamina } from "./vitals.js";
import {
  activeScales,
  consumeModifiers,
  evaluateShift,
  maybeTriggerEvent,
  onTransactionRecorded,
  wageMultiplier,
} from "./npcManager.js";

const PER_MINUTE_WAGE_MIN = 1500;
const PER_MINUTE_WAGE_MAX = 3000;
const PENALTY_MULTIPLIER = 5;

function randomWage(): number {
  return (
    PER_MINUTE_WAGE_MIN +
    Math.floor(Math.random() * (PER_MINUTE_WAGE_MAX - PER_MINUTE_WAGE_MIN + 1))
  );
}

const ITEM_NAMES = ["우유", "라면", "과자", "생수", "계란", "빵", "음료수", "휴지"];

export interface CartItem {
  name: string;
  price: number;
}

function randomCart(big = false): CartItem[] {
  // 특별 근무(바쁜 시간대)에는 손님이 더 많이 사간다: 4~6개.
  const count = big ? 4 + Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * 3); // 평소 2~4개
  const items: CartItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      name: ITEM_NAMES[Math.floor(Math.random() * ITEM_NAMES.length)],
      price: (1 + Math.floor(Math.random() * 20)) * 500, // 500원 단위, 500~10000원
    });
  }
  return items;
}

/** 다음 손님 카트를 서버가 만들어 근무(shift)에 저장한다 — 정답 금액은 서버만 알고 있다. */
function issueCart(shiftId: number, big = false): CartItem[] {
  const cart = randomCart(big);
  db.prepare("UPDATE mart_shifts SET pending_cart = ?, cart_issued_at = ? WHERE id = ?").run(
    JSON.stringify(cart),
    Date.now(),
    shiftId
  );
  return cart;
}

/** 손님이 온 뒤 걸린 시간(초)에 따른 스피드 배수. 정답일 때만 호출한다. */
function speedMultiplier(elapsedSec: number): number {
  return ALBA_SPEED.tiers.find((t) => elapsedSec <= t.withinSec)?.multiplier ?? 1;
}

/** 카트를 낸 뒤 지난 시간(초) — 네트워크 지연 보정(graceMs)을 뺀다. 예전 근무라 시각이 없으면 제한 없음(0초 취급 안 함). */
function elapsedSecSinceCart(shift: any): number | null {
  if (!shift.cart_issued_at) return null;
  return Math.max(0, Date.now() - shift.cart_issued_at - ALBA_SPEED.graceMs) / 1000;
}

/** 20초가 지나 손님이 떠났을 때 다음 손님을 부른다(분급·페널티·체력 변화 없음). */
export function skipTimedOutCustomer(userId: number): { nextCart: CartItem[]; timeLimitSec: number } {
  const shift = activeShift(userId);
  if (!shift) throw { status: 400, message: "진행 중인 마트 근무가 없습니다." };
  const elapsed = elapsedSecSinceCart(shift);
  if (elapsed !== null && elapsed < ALBA_SPEED.timeLimitSec - 1) {
    throw { status: 400, message: "아직 손님이 기다리고 있어요." };
  }
  return { nextCart: issueCart(shift.id, wageMultiplier(userId).rush), timeLimitSec: ALBA_SPEED.timeLimitSec };
}

/** 이번 근무에서 실제로 차감된 오차 페널티 합계(원장 기준, 양수). */
function penaltyAppliedTotal(shiftId: number): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries WHERE type = '알바오차차감' AND ref_id = ?")
    .get(shiftId) as { s: number };
  return -row.s;
}

function activeShift(userId: number): any {
  return db
    .prepare("SELECT * FROM mart_shifts WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1")
    .get(userId);
}

export function startMartShift(userId: number): {
  shiftId: number;
  perMinuteWage: number;
  cart: CartItem[];
  timeLimitSec: number;
  speedTiers: typeof ALBA_SPEED.tiers;
} {
  if (activeShift(userId)) {
    throw { status: 409, message: "이미 진행 중인 근무가 있습니다." };
  }
  assertCanWork(userId);
  const perMinuteWage = randomWage();
  const result = db
    .prepare("INSERT INTO mart_shifts (user_id, per_minute_wage) VALUES (?, ?)")
    .run(userId, perMinuteWage);
  const shiftId = Number(result.lastInsertRowid);
  // 근무를 시작할 때 점장이 랜덤 이벤트(진상 손님/재고 정리/소문)를 걸 수 있다.
  maybeTriggerEvent(userId);
  return {
    shiftId,
    perMinuteWage,
    cart: issueCart(shiftId, wageMultiplier(userId).rush),
    timeLimitSec: ALBA_SPEED.timeLimitSec,
    speedTiers: ALBA_SPEED.tiers,
  };
}

export function recordMartTransaction(
  userId: number,
  enteredAmount: number
): {
  nextCart: CartItem[];
  errorAmount: number;
  penalty: number;
  wagePaid: number;
  wageMultiplier: number;
  penaltyScale: number;
  rushRemaining: number | null;
  penaltyApplied: number;
  penaltyCapped: boolean;
  balance: number;
  stamina: number;
  timedOut: boolean;
  elapsedSec: number | null;
  speedMultiplier: number;
} {
  const shift = activeShift(userId);
  if (!shift) throw { status: 400, message: "진행 중인 마트 근무가 없습니다." };
  if (!shift.pending_cart) throw { status: 400, message: "계산할 손님이 없습니다." };
  if (!Number.isFinite(enteredAmount) || enteredAmount < 0) {
    throw { status: 400, message: "올바른 금액을 입력하세요." };
  }
  // 제한 시간이 지나 이미 떠난 손님이면 계산을 받지 않는다(클라이언트 타이머가 늦게 돈 경우).
  const elapsedSec = elapsedSecSinceCart(shift);
  if (elapsedSec !== null && elapsedSec > ALBA_SPEED.timeLimitSec) {
    throw { status: 409, message: "손님이 기다리다 떠났어요.", timedOut: true };
  }
  // 체력이 바닥나면 손님을 더 받을 수 없다 — 근무를 마치고 쉬어야 한다.
  assertCanWork(userId);
  const correctAmount = (JSON.parse(shift.pending_cart) as CartItem[]).reduce(
    (sum, i) => sum + i.price,
    0
  );

  const errorAmount = Math.abs(Math.round(correctAmount) - Math.round(enteredAmount));
  // 이벤트 선택으로 걸린 임시 배수(진상 손님 대응 등)가 시급/페널티에 곱해진다.
  const scales = activeScales(userId);
  const penalty = Math.round(errorAmount * PENALTY_MULTIPLIER * scales.penaltyScale);

  db.prepare(
    "INSERT INTO mart_transactions (shift_id, correct_amount, entered_amount, error_amount, penalty) VALUES (?, ?, ?, ?, ?)"
  ).run(shift.id, correctAmount, enteredAmount, errorAmount, penalty);
  db.prepare("UPDATE mart_shifts SET penalty_total = penalty_total + ? WHERE id = ?").run(
    penalty,
    shift.id
  );

  // 이번 1분치 분급을 먼저 지급하고, 그 자리에서 오차 페널티를 차감한다(잔액 하한 0원).
  // 시급은 점장 신뢰도 등급 배수와 특별 근무(바쁜 시간대) 배수가 반영된다.
  const mult = wageMultiplier(userId);
  // 스피드 보너스: 정확하게 계산했을 때만, 걸린 시간 구간에 따라 이 손님의 분급에 배수를 곱한다.
  const speed = errorAmount === 0 && elapsedSec !== null ? speedMultiplier(elapsedSec) : 1;
  const wage = Math.round(shift.per_minute_wage * mult.total * scales.wageScale * speed);
  db.prepare("UPDATE mart_shifts SET wage_total = wage_total + ? WHERE id = ?").run(wage, shift.id);
  const { balance: afterWage } = applyLedgerEntry(userId, "알바정산", wage, shift.id);
  // 일하고 적자가 나지 않게: 이번 근무의 누적 차감액이 누적 분급을 넘지 않도록 페널티를 깎는다
  // (근무 결과는 최소 0원 — 잘 계산해서 번 분급에서 실수만큼 빠진다).
  const room = Math.max(0, shift.wage_total + wage - penaltyAppliedTotal(shift.id));
  const penaltyCharged = Math.min(penalty, room);
  const { balance: afterPenalty, amountApplied } = applyLedgerEntry(
    userId,
    "알바오차차감",
    -penaltyCharged,
    shift.id,
    { floorAtZero: true }
  );

  // 손님 1명 = workMinutes.albaCustomer분 근무만큼 체력이 준다.
  const stamina = spendWorkStamina(userId, VITALS.workMinutes.albaCustomer);

  const { rushRemaining } = onTransactionRecorded(userId);
  consumeModifiers(userId);

  return {
    nextCart: issueCart(shift.id, wageMultiplier(userId).rush),
    errorAmount,
    penalty,
    wagePaid: wage,
    wageMultiplier: Math.round(mult.total * scales.wageScale * 100) / 100,
    penaltyScale: scales.penaltyScale,
    rushRemaining,
    penaltyApplied: -amountApplied,
    penaltyCapped: penaltyCharged < penalty, // 급여를 넘는 페널티라 깎였는지
    balance: penalty > 0 ? afterPenalty : afterWage,
    stamina: Math.floor(stamina),
    timedOut: false,
    elapsedSec: elapsedSec === null ? null : Math.round(elapsedSec * 10) / 10,
    speedMultiplier: speed,
  };
}

export function endMartShift(userId: number): {
  minutesWorked: number;
  totalWagePaid: number;
  totalPenalty: number;
  netPay: number;
  managerReacted: boolean;
} {
  const shift = activeShift(userId);
  if (!shift) throw { status: 400, message: "진행 중인 마트 근무가 없습니다." };

  const txCount = (
    db.prepare("SELECT COUNT(*) AS c FROM mart_transactions WHERE shift_id = ?").get(shift.id) as {
      c: number;
    }
  ).c;

  db.prepare(
    "UPDATE mart_shifts SET active = 0, ended_at = datetime('now') WHERE id = ?"
  ).run(shift.id);

  // 근무 종료 시 점장이 이번 근무 기록을 보고 반응한다(칭찬/보너스/경고/면담).
  const reaction = evaluateShift(userId, shift.id);

  // 실제로 차감된 페널티(급여 한도로 깎인 뒤)와 실수령액(최소 0원)을 알려준다.
  const applied = penaltyAppliedTotal(shift.id);
  return {
    minutesWorked: txCount,
    totalWagePaid: shift.wage_total,
    totalPenalty: applied,
    netPay: Math.max(0, shift.wage_total - applied),
    managerReacted: reaction !== null,
  };
}
