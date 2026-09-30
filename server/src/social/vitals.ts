// 마을 이동의 체력/연료(economy.ts VITALS). 이동·식사·주유·잠자기는 모두 서버가 계산한다
// (클라이언트는 결과로 받은 이동 방식에 맞춰 걷거나 차를 타는 연출만 한다).
import { db } from "../db.js";
import { VITALS } from "../economy.js";
import { applyLedgerEntry } from "../wallet/ledger.js";

const MS_PER_POINT = (60 * 60 * 1000) / VITALS.regenPerHour;
const HOUR = 60 * 60 * 1000;

interface VitalsRow {
  user_id: number;
  stamina: number;
  stamina_at: number;
  fuel: number;
  slept_at: number | null;
}

export type MoveMode = "walk" | "drive" | "tired";

function isGraduated(userId: number): boolean {
  const row = db.prepare("SELECT status FROM student_profile WHERE user_id = ?").get(userId) as
    | { status: string }
    | undefined;
  return row?.status === "graduated";
}

/** 소유한 차 중 가장 비싼 차(연료 가격 기준). 없으면 null. */
function bestCar(userId: number): { name: string } | null {
  return (
    (db
      .prepare(
        `SELECT c.name FROM owned_items o JOIN catalog_items c ON c.id = o.catalog_item_id
         WHERE o.user_id = ? AND c.category = 'car' ORDER BY c.price DESC LIMIT 1`
      )
      .get(userId) as { name: string } | undefined) ?? null
  );
}

/** 행이 없으면 체력·연료 가득으로 만들고, 지난 시간만큼 자연 회복을 반영해 돌려준다. */
function load(userId: number, now = Date.now()): VitalsRow {
  db.prepare(
    "INSERT OR IGNORE INTO user_vitals (user_id, stamina, stamina_at, fuel) VALUES (?, ?, ?, ?)"
  ).run(userId, VITALS.maxStamina, now, VITALS.tankMoves);
  const row = db.prepare("SELECT * FROM user_vitals WHERE user_id = ?").get(userId) as unknown as VitalsRow;
  if (row.stamina >= VITALS.maxStamina) {
    row.stamina_at = now;
  } else {
    const points = Math.floor((now - row.stamina_at) / MS_PER_POINT);
    if (points > 0) {
      row.stamina = Math.min(VITALS.maxStamina, row.stamina + points);
      // 남은 자투리 시간은 다음 회복에 이어서 쓴다(가득 찼으면 기준 시각을 지금으로).
      row.stamina_at = row.stamina >= VITALS.maxStamina ? now : row.stamina_at + points * MS_PER_POINT;
    }
  }
  return row;
}

function save(row: VitalsRow): void {
  db.prepare("UPDATE user_vitals SET stamina = ?, stamina_at = ?, fuel = ?, slept_at = ? WHERE user_id = ?").run(
    row.stamina,
    row.stamina_at,
    row.fuel,
    row.slept_at,
    row.user_id
  );
}

function fullTankPrice(carName: string): number {
  return VITALS.fullTankPrice[carName] ?? VITALS.defaultFullTankPrice;
}

function view(row: VitalsRow, userId: number, now = Date.now()) {
  const car = bestCar(userId);
  const sleepAt = row.slept_at ? row.slept_at + VITALS.sleepCooldownHours * HOUR : null;
  return {
    stamina: row.stamina,
    maxStamina: VITALS.maxStamina,
    walkCost: VITALS.walkCost,
    regenPerHour: VITALS.regenPerHour,
    fuel: row.fuel,
    tankMoves: VITALS.tankMoves,
    car: car ? { name: car.name, fullTankPrice: fullTankPrice(car.name) } : null,
    canSleepAt: sleepAt && sleepAt > now ? new Date(sleepAt).toISOString() : null,
  };
}

export type Vitals = ReturnType<typeof view>;

export function getVitals(userId: number): Vitals {
  const row = load(userId);
  save(row);
  return view(row, userId);
}

/**
 * 마을에서 한 번 이동한다. 차가 있고 연료가 남았으면 연료 1을 써서 차로, 아니면 체력을 써서 걷는다.
 * 체력이 모자라면 체력 0으로 "지친 걸음"(아주 느림)이 된다 — 절대 못 움직이게 막지는 않는다.
 * 졸업 전(학교만 갈 수 있을 때)에는 아무것도 소모하지 않는다.
 */
export function move(userId: number): { mode: MoveMode; vitals: Vitals } {
  const row = load(userId);
  let mode: MoveMode = "walk";
  if (isGraduated(userId)) {
    if (bestCar(userId) && row.fuel > 0) {
      row.fuel -= 1;
      mode = "drive";
    } else if (row.stamina >= VITALS.walkCost) {
      row.stamina -= VITALS.walkCost;
      mode = "walk";
    } else {
      row.stamina = 0;
      mode = "tired";
    }
  }
  save(row);
  return { mode, vitals: view(row, userId) };
}

/** 내 집에서 잠자기: 체력 가득. sleepCooldownHours마다 한 번. */
export function sleep(userId: number): Vitals {
  const now = Date.now();
  const row = load(userId, now);
  if (row.slept_at && now - row.slept_at < VITALS.sleepCooldownHours * HOUR) {
    throw { status: 409, message: "방금 잤어요. 조금 있다가 다시 잘 수 있어요." };
  }
  row.stamina = VITALS.maxStamina;
  row.stamina_at = now;
  row.slept_at = now;
  save(row);
  return view(row, userId, now);
}

export function shopMenu(userId: number) {
  const row = load(userId);
  save(row);
  const v = view(row, userId);
  const missing = VITALS.tankMoves - row.fuel;
  return {
    foods: VITALS.foods,
    fuel: v.car ? { missing, price: fuelPrice(v.car.fullTankPrice, missing) } : null,
    vitals: v,
  };
}

function fuelPrice(fullTank: number, missing: number): number {
  // 100원 단위로 올림
  return Math.ceil((fullTank * missing) / VITALS.tankMoves / 100) * 100;
}

/** 마트에서 음식을 사 먹는다(즉시 체력 회복). 이미 가득이면 사지 않는다. */
export function eat(userId: number, foodKey: string): { vitals: Vitals; balance: number; gained: number } {
  const food = VITALS.foods.find((f) => f.key === foodKey);
  if (!food) throw { status: 400, message: "없는 메뉴예요." };
  const row = load(userId);
  if (row.stamina >= VITALS.maxStamina) throw { status: 409, message: "배가 불러요. 체력이 이미 가득해요." };
  const { balance } = applyLedgerEntry(userId, "장보기", -food.price);
  const before = row.stamina;
  row.stamina = Math.min(VITALS.maxStamina, row.stamina + food.stamina);
  if (row.stamina >= VITALS.maxStamina) row.stamina_at = Date.now();
  save(row);
  return { vitals: view(row, userId), balance, gained: row.stamina - before };
}

/** 마트에서 주유: 부족한 만큼 채우고 그만큼만 낸다. */
export function refuel(userId: number): { vitals: Vitals; balance: number; paid: number } {
  const car = bestCar(userId);
  if (!car) throw { status: 400, message: "차가 없어요. 자동차 매장에서 먼저 차를 사세요." };
  const row = load(userId);
  const missing = VITALS.tankMoves - row.fuel;
  if (missing <= 0) throw { status: 409, message: "연료가 이미 가득해요." };
  const paid = fuelPrice(fullTankPrice(car.name), missing);
  const { balance } = applyLedgerEntry(userId, "주유", -paid);
  row.fuel = VITALS.tankMoves;
  save(row);
  return { vitals: view(row, userId), balance, paid };
}
