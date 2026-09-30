// 마을 이동의 체력/연료(economy.ts VITALS). 이동·식사·주유·잠자기는 모두 서버가 계산한다
// (클라이언트는 결과로 받은 이동 방식에 맞춰 걷거나 차를 타는 연출만 한다).
import { db } from "../db.js";
import { VITALS } from "../economy.js";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { cellsBetween, isFacility } from "./townMap.js";

const MS_PER_POINT = (60 * 60 * 1000) / VITALS.regenPerHour;
const HOUR = 60 * 60 * 1000;

interface VitalsRow {
  user_id: number;
  stamina: number;
  stamina_at: number;
  fuel: number;
  slept_at: number | null;
  location: string | null;
  home_refuel_at: number | null;
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
  ).run(userId, VITALS.maxStamina, now, VITALS.defaultTankCells);
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
  db.prepare(
    "UPDATE user_vitals SET stamina = ?, stamina_at = ?, fuel = ?, slept_at = ?, location = ?, home_refuel_at = ? WHERE user_id = ?"
  ).run(row.stamina, row.stamina_at, row.fuel, row.slept_at, row.location, row.home_refuel_at, row.user_id);
}

function fullTankPrice(carName: string): number {
  return VITALS.fullTankPrice[carName] ?? VITALS.defaultFullTankPrice;
}

/** 차종별 연료통 크기(칸). */
function tankCells(carName: string): number {
  return VITALS.tankCells[carName] ?? VITALS.defaultTankCells;
}

/** 지금 타는 차와 그 연료통. 연료통보다 많이 남아 있으면(작은 차로 바꿨거나 예전 데이터) 연료통 크기로 맞춘다. */
function carAndTank(userId: number, row: VitalsRow): { name: string; tank: number } | null {
  const car = bestCar(userId);
  if (!car) return null;
  const tank = tankCells(car.name);
  if (row.fuel > tank) row.fuel = tank;
  return { name: car.name, tank };
}

/** 근무 시간(분)만큼 체력을 쓴다(0 아래로는 안 내려감). 소수점 체력도 쌓였다가 화면엔 내림해서 보인다. */
export function spendWorkStamina(userId: number, minutes: number): number {
  const row = load(userId);
  const wasFull = row.stamina >= VITALS.maxStamina;
  row.stamina = Math.max(0, row.stamina - (VITALS.staminaPerWorkHour * minutes) / 60);
  if (wasFull) row.stamina_at = Date.now();
  save(row);
  return row.stamina;
}

/** 체력이 남아 있어야 일할 수 있다. */
export function assertCanWork(userId: number): void {
  const row = load(userId);
  save(row);
  if (row.stamina < 1) {
    throw { status: 409, message: "너무 지쳐서 일할 수 없어요 😵 마트에서 먹거나 내 집에서 쉬고 오세요." };
  }
}

function view(row: VitalsRow, userId: number, now = Date.now()) {
  const car = carAndTank(userId, row);
  const sleepAt = row.slept_at ? row.slept_at + VITALS.sleepCooldownHours * HOUR : null;
  return {
    stamina: Math.floor(row.stamina), // 근무로 소수점이 생길 수 있어 화면엔 내림
    maxStamina: VITALS.maxStamina,
    walkCost: VITALS.walkCost,
    regenPerHour: VITALS.regenPerHour,
    fuel: row.fuel, // 남은 연료(칸)
    fuelCapacity: car?.tank ?? 0, // 지금 차의 연료통(칸), 차가 없으면 0
    location: row.location ?? "school", // 마을에서 마지막으로 도착한 시설
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
 * 마을에서 지금 있는 시설 → to로 이동한다. 거리(칸)는 서버가 지도로 잰다(social/townMap.ts).
 * 차가 있고 연료가 그 거리만큼 남았으면 연료를 칸 수만큼 써서 차로, 아니면 체력을 써서 걷는다
 * (연료가 모자라면 차를 두고 걷는다 — 연료는 그대로). 체력이 모자라면 "지친 걸음"(아주 느림).
 * 졸업 전(학교만 갈 수 있을 때)에는 아무것도 소모하지 않는다.
 */
export function move(
  userId: number,
  to: string
): { mode: MoveMode; cells: number; homeRefuel: number; vitals: Vitals } {
  if (!isFacility(to)) throw { status: 400, message: "없는 장소예요." };
  const row = load(userId);
  const cells = cellsBetween(row.location ?? "school", to);
  row.location = to;
  let mode: MoveMode = "walk";
  const car = carAndTank(userId, row);
  if (isGraduated(userId) && cells > 0) {
    if (car && row.fuel >= cells) {
      row.fuel -= cells;
      mode = "drive";
    } else if (row.stamina >= VITALS.walkCost) {
      row.stamina -= VITALS.walkCost;
      mode = "walk";
    } else {
      row.stamina = 0;
      mode = "tired";
    }
  } else if (car && row.fuel > 0) {
    mode = "drive"; // 제자리(0칸)거나 졸업 전: 소모 없이 지금 모습 그대로
  }
  // 내 집에 도착하면(다른 곳에서 와야 함) 주차장에서 연료통의 일부를 채운다 — 쿨타임마다 한 번.
  let homeRefuel = 0;
  const now = Date.now();
  if (
    to === "home" &&
    cells > 0 &&
    car &&
    isGraduated(userId) &&
    (!row.home_refuel_at || now - row.home_refuel_at >= VITALS.homeRefuelCooldownHours * HOUR)
  ) {
    const add = Math.min(car.tank - row.fuel, Math.ceil(car.tank * VITALS.homeRefuelRatio));
    if (add > 0) {
      row.fuel += add;
      row.home_refuel_at = now;
      homeRefuel = add;
    }
  }
  save(row);
  return { mode, cells, homeRefuel, vitals: view(row, userId) };
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
  const missing = v.fuelCapacity - row.fuel;
  return {
    foods: VITALS.foods,
    fuel: v.car ? { missing, price: fuelPrice(v.car.fullTankPrice, missing, v.fuelCapacity) } : null,
    vitals: v,
  };
}

function fuelPrice(fullTank: number, missing: number, capacity: number): number {
  // 부족한 칸만큼 비례, 100원 단위로 올림
  return Math.ceil((fullTank * missing) / capacity / 100) * 100;
}

/** 마트에서 음식을 사 먹는다(즉시 체력 회복). 이미 가득이면 사지 않는다. */
export function eat(userId: number, foodKey: string): { vitals: Vitals; balance: number; gained: number } {
  const food = VITALS.foods.find((f) => f.key === foodKey);
  if (!food) throw { status: 400, message: "없는 메뉴예요." };
  const row = load(userId);
  if (row.stamina >= VITALS.maxStamina - 0.5) throw { status: 409, message: "배가 불러요. 체력이 이미 가득해요." };
  const { balance } = applyLedgerEntry(userId, "장보기", -food.price);
  const before = row.stamina;
  row.stamina = Math.min(VITALS.maxStamina, row.stamina + food.stamina);
  if (row.stamina >= VITALS.maxStamina) row.stamina_at = Date.now();
  save(row);
  return { vitals: view(row, userId), balance, gained: Math.floor(row.stamina) - Math.floor(before) };
}

/** 마트에서 주유: 부족한 만큼 채우고 그만큼만 낸다. */
export function refuel(userId: number): { vitals: Vitals; balance: number; paid: number } {
  const row = load(userId);
  const car = carAndTank(userId, row);
  if (!car) throw { status: 400, message: "차가 없어요. 자동차 매장에서 먼저 차를 사세요." };
  const missing = car.tank - row.fuel;
  if (missing <= 0) throw { status: 409, message: "연료가 이미 가득해요." };
  const paid = fuelPrice(fullTankPrice(car.name), missing, car.tank);
  const { balance } = applyLedgerEntry(userId, "주유", -paid);
  row.fuel = car.tank;
  save(row);
  return { vitals: view(row, userId), balance, paid };
}
