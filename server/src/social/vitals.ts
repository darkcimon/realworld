// 마을 이동의 체력/연료(economy.ts VITALS). 이동·식사·주유·잠자기는 모두 서버가 계산한다
// (클라이언트는 결과로 받은 이동 방식에 맞춰 걷거나 차를 타는 연출만 한다).
import { db } from "../db.js";
import { COOKING, VITALS } from "../economy.js";
import { randomUUID } from "node:crypto";
import { applyLedgerEntry } from "../wallet/ledger.js";
import { cellsBetween, isFacility } from "./townMap.js";

const HOUR = 60 * 60 * 1000;

/** 가진 집 중 가장 비싼 집(없으면 null = 박스집). */
function bestHome(userId: number): string | null {
  const row = db
    .prepare(
      `SELECT c.name FROM owned_items o JOIN catalog_items c ON c.id = o.catalog_item_id
       WHERE o.user_id = ? AND c.category = 'apartment' ORDER BY c.price DESC LIMIT 1`
    )
    .get(userId) as { name: string } | undefined;
  return row?.name ?? null;
}

/** 주차장 연료 충전 비율. 집이 비쌀수록 많이 채워 준다. */
function homeRefuelRatioOf(home: string | null): number {
  return (home && VITALS.homeRefuelRatioByHome[home]) || VITALS.homeRefuelRatio;
}

/** 집에 따른 요리 등급: 한 그릇 최대 체력, 냉장고 칸, 추가 그릇 확률, 메뉴. 박스집은 냉장고·추가 그릇 없음. */
function cookTierOf(home: string | null) {
  const t = home ? COOKING.byHome[home] : undefined;
  return t ?? { maxGain: COOKING.maxGain, fridge: 0, extraChances: [] as number[], dishes: COOKING.dishes };
}

interface StoredMeal {
  id: number;
  dish: string;
  stamina: number;
}

/** 냉장고에 넣어 둔 음식(오래된 순). */
function storedMeals(userId: number): StoredMeal[] {
  return db
    .prepare("SELECT id, dish, stamina FROM home_meals WHERE user_id = ? ORDER BY id")
    .all(userId) as unknown as StoredMeal[];
}

/** 자연 회복 속도(1시간당). 집이 비쌀수록 빠르다. */
function regenPerHourOf(home: string | null): number {
  return (home && VITALS.regenPerHourByHome[home]) || VITALS.regenPerHour;
}

interface VitalsRow {
  user_id: number;
  stamina: number;
  stamina_at: number;
  fuel: number; // load() 뒤에는 "지금 타는 차"의 남은 연료. save()가 그 차(owned_items.fuel)에 되돌려 쓴다
  slept_at: number | null;
  location: string | null;
  home_refuel_at: number | null;
  active_car_id: number | null;
  cooked_at: number | null;
  home?: string | null; // load()가 채운다: 가장 비싼 집(없으면 박스집)
  car?: { ownedId: number; name: string; tank: number } | null; // load()가 채운다(DB 컬럼 아님)
  legacyFuel?: number; // 차별 연료 도입 전 공용 연료(user_vitals.fuel) — 한 번도 안 탄 차가 이어받는다
}

interface OwnedCar {
  id: number;
  name: string;
  price: number;
  fuel: number | null;
}

export type MoveMode = "walk" | "drive" | "tired";

function isGraduated(userId: number): boolean {
  const row = db.prepare("SELECT status FROM student_profile WHERE user_id = ?").get(userId) as
    | { status: string }
    | undefined;
  return row?.status === "graduated";
}

/** 소유한 차 전부(비싼 순). 같은 차종을 여러 대 가질 수 있고, 차마다 연료가 따로 있다. */
function ownedCars(userId: number): OwnedCar[] {
  return db
    .prepare(
      `SELECT o.id, c.name, c.price, o.fuel FROM owned_items o JOIN catalog_items c ON c.id = o.catalog_item_id
       WHERE o.user_id = ? AND c.category = 'car' ORDER BY c.price DESC, o.id`
    )
    .all(userId) as unknown as OwnedCar[];
}

/** 행이 없으면 체력·연료 가득으로 만들고, 지난 시간만큼 자연 회복을 반영해 돌려준다. */
function load(userId: number, now = Date.now()): VitalsRow {
  db.prepare(
    "INSERT OR IGNORE INTO user_vitals (user_id, stamina, stamina_at, fuel) VALUES (?, ?, ?, ?)"
  ).run(userId, VITALS.maxStamina, now, VITALS.defaultTankCells);
  const row = db.prepare("SELECT * FROM user_vitals WHERE user_id = ?").get(userId) as unknown as VitalsRow;
  row.home = bestHome(userId);
  const msPerPoint = HOUR / regenPerHourOf(row.home);
  if (row.stamina >= VITALS.maxStamina) {
    row.stamina_at = now;
  } else {
    const points = Math.floor((now - row.stamina_at) / msPerPoint);
    if (points > 0) {
      row.stamina = Math.min(VITALS.maxStamina, row.stamina + points);
      // 남은 자투리 시간은 다음 회복에 이어서 쓴다(가득 찼으면 기준 시각을 지금으로).
      row.stamina_at = row.stamina >= VITALS.maxStamina ? now : row.stamina_at + points * msPerPoint;
    }
  }
  // 지금 타는 차: 고른 차(팔았으면 무시) → 없으면 가장 비싼 차. 그 차의 연료를 row.fuel로 올려 둔다.
  // 한 번도 안 탄 차(fuel NULL)는 예전에 하나로 쓰던 연료(user_vitals.fuel)를 이어받는다 — 차별 연료 도입 전 데이터 호환.
  row.legacyFuel = row.fuel;
  const cars = ownedCars(userId);
  const pick = cars.find((c) => c.id === row.active_car_id) ?? cars[0];
  if (pick) {
    const tank = tankCells(pick.name);
    row.car = { ownedId: pick.id, name: pick.name, tank };
    row.fuel = Math.min(tank, pick.fuel ?? row.legacyFuel);
  } else {
    row.car = null;
  }
  return row;
}

function save(row: VitalsRow): void {
  db.prepare(
    "UPDATE user_vitals SET stamina = ?, stamina_at = ?, slept_at = ?, location = ?, home_refuel_at = ?, active_car_id = ?, cooked_at = ? WHERE user_id = ?"
  ).run(row.stamina, row.stamina_at, row.slept_at, row.location, row.home_refuel_at, row.active_car_id, row.cooked_at, row.user_id);
  if (row.car) db.prepare("UPDATE owned_items SET fuel = ? WHERE id = ?").run(row.fuel, row.car.ownedId);
}

function fullTankPrice(carName: string): number {
  return VITALS.fullTankPrice[carName] ?? VITALS.defaultFullTankPrice;
}

/** 차종별 연료통 크기(칸). */
function tankCells(carName: string): number {
  return VITALS.tankCells[carName] ?? VITALS.defaultTankCells;
}

/** 지금 타는 차와 그 연료통(load()가 정해 둔 것). */
function carAndTank(_userId: number, row: VitalsRow): { ownedId: number; name: string; tank: number } | null {
  return row.car ?? null;
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
    regenPerHour: regenPerHourOf(row.home ?? null), // 집에 따라 다르다
    home: row.home ?? null, // 가장 비싼 집(없으면 null = 박스집)
    // 내 집 요리(리듬게임): 다시 할 수 있는 시각(null이면 지금 가능). 좋은 집일수록 한 그릇 체력이 크다.
    cookMaxGain: cookTierOf(row.home ?? null).maxGain,
    fridgeCapacity: cookTierOf(row.home ?? null).fridge, // 남은 음식을 넣어 둘 수 있는 칸(박스집 0)
    meals: storedMeals(userId), // 냉장고에 있는 음식
    cookAvailableAt:
      row.cooked_at && row.cooked_at + COOKING.cooldownMinutes * 60_000 > now
        ? new Date(row.cooked_at + COOKING.cooldownMinutes * 60_000).toISOString()
        : null,
    fuel: row.fuel, // 남은 연료(칸)
    fuelCapacity: car?.tank ?? 0, // 지금 차의 연료통(칸), 차가 없으면 0
    location: row.location ?? "school", // 마을에서 마지막으로 도착한 시설
    car: car ? { ownedItemId: car.ownedId, name: car.name, fullTankPrice: fullTankPrice(car.name) } : null,
    // 운행할 차를 고를 수 있게 소유한 차 전부와 각자의 연료(안 타 본 차는 연료통 가득으로 보인다)
    cars: ownedCars(userId).map((c) => {
      const tank = tankCells(c.name);
      const active = c.id === car?.ownedId;
      const fuel = active ? row.fuel : Math.min(tank, c.fuel ?? row.legacyFuel ?? tank);
      return { ownedItemId: c.id, name: c.name, tank, fuel, active };
    }),
    canSleepAt: sleepAt && sleepAt > now ? new Date(sleepAt).toISOString() : null,
  };
}

export type Vitals = ReturnType<typeof view>;

/** 운행할 차를 고른다(내가 가진 차만). 지금 차의 연료는 그 차에 그대로 남는다. */
export function selectCar(userId: number, ownedItemId: number): Vitals {
  const row = load(userId);
  const target = ownedCars(userId).find((c) => c.id === ownedItemId);
  if (!target) throw { status: 404, message: "내가 가진 차가 아니에요." };
  save(row); // 지금 타던 차의 연료를 먼저 그 차에 저장
  row.active_car_id = ownedItemId;
  save(row);
  const next = load(userId);
  save(next);
  return view(next, userId);
}

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
    const add = Math.min(car.tank - row.fuel, Math.ceil(car.tank * homeRefuelRatioOf(row.home ?? null)));
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

// ── 내 집 요리(리듬게임) ────────────────────────────────────────────────
// 서버가 채보를 만들어 세션으로 들고 있다가, 끝났다고 알려오면 시간·판정 수를 확인하고 체력을 준다.
// 요리 등급(체력·냉장고·추가 그릇)은 시작할 때의 집으로 정해 세션에 담아 둔다.
interface CookSession {
  userId: number;
  startedAt: number;
  notes: number;
  dish: string;
  tier: ReturnType<typeof cookTierOf>;
}
const cookSessions = new Map<string, CookSession>();

function assertCanCook(userId: number, row: VitalsRow, now: number): void {
  if (!isGraduated(userId)) throw { status: 403, message: "졸업 후 내 집에서 요리할 수 있어요." };
  if (row.cooked_at && now - row.cooked_at < COOKING.cooldownMinutes * 60_000) {
    throw { status: 409, message: "방금 요리했어요. 조금 있다가 다시 만들어요." };
  }
  // 배가 불러도 냉장고에 자리가 있으면 만들어 넣어 둘 수 있다.
  const fridge = cookTierOf(row.home ?? null).fridge;
  if (row.stamina >= VITALS.maxStamina && storedMeals(userId).length >= fridge) {
    throw { status: 409, message: fridge > 0 ? "배도 부르고 냉장고도 가득 찼어요." : "배가 불러요. 체력이 이미 가득해요." };
  }
}

/** 요리 시작: 채보(노트 시각·줄)를 만들어 준다. 노트는 시작 1.5초 뒤부터 곡 끝 1초 전까지 흩어진다. */
export function startCooking(userId: number) {
  const now = Date.now();
  const row = load(userId, now);
  assertCanCook(userId, row, now);
  const first = 1500;
  const last = COOKING.songMs - 1000;
  const gap = (last - first) / (COOKING.notes - 1);
  const notes = Array.from({ length: COOKING.notes }, (_, i) => ({
    t: Math.round(first + i * gap + (Math.random() - 0.5) * gap * 0.5),
    lane: Math.floor(Math.random() * COOKING.lanes),
  }));
  const tier = cookTierOf(row.home ?? null);
  const dish = tier.dishes[Math.floor(Math.random() * tier.dishes.length)];
  const sessionId = randomUUID();
  cookSessions.set(sessionId, { userId, startedAt: now, notes: notes.length, dish, tier });
  // 오래된 세션 정리
  for (const [id, s] of cookSessions) if (now - s.startedAt > 10 * 60_000) cookSessions.delete(id);
  return { sessionId, dish, songMs: COOKING.songMs, lanes: COOKING.lanes, notes, maxGain: tier.maxGain };
}

/**
 * 요리 끝: 퍼펙트·굿 수로 점수를 매겨 체력을 채운다. 곡 길이만큼 시간이 지나야 인정한다.
 * 산 집에서는 잘 만들면 가끔 여러 그릇이 나와 남은 건 냉장고에 들어간다. 배가 부르면 첫 그릇도 냉장고로.
 */
export function finishCooking(
  userId: number,
  sessionId: string,
  perfect: number,
  good: number
): { dish: string; score: number; gained: number; portions: number; stored: number; vitals: Vitals } {
  const session = cookSessions.get(sessionId);
  if (!session || session.userId !== userId) throw { status: 404, message: "요리 기록이 없어요. 다시 시작해 주세요." };
  const now = Date.now();
  if (now - session.startedAt < COOKING.songMs - 1500) throw { status: 400, message: "아직 요리가 끝나지 않았어요." };
  cookSessions.delete(sessionId);
  const p = Math.max(0, Math.floor(Number(perfect) || 0));
  const g = Math.max(0, Math.floor(Number(good) || 0));
  if (p + g > session.notes) throw { status: 400, message: "판정 기록이 이상해요." };
  const score = Math.round(((p + g * COOKING.goodWeight) / session.notes) * 100);
  const row = load(userId, now);
  assertCanCook(userId, row, now);
  const { tier } = session;
  const perPortion = Math.round((tier.maxGain * score) / 100);
  // 추가 그릇: 확률을 차례로 굴려 실패하면 멈춘다(1그릇 더 → 2그릇 더 …).
  let portions = 1;
  if (score >= COOKING.extraMinScore) {
    for (const chance of tier.extraChances) {
      if (Math.random() >= chance) break;
      portions++;
    }
  }
  const before = row.stamina;
  let toStore = portions;
  if (row.stamina < VITALS.maxStamina) {
    row.stamina = Math.min(VITALS.maxStamina, row.stamina + perPortion);
    if (row.stamina >= VITALS.maxStamina) row.stamina_at = now;
    toStore--; // 한 그릇은 바로 먹는다
  }
  // 냉장고 자리만큼만 넣는다(넘치는 그릇은 그 자리에서 나눠 먹은 셈).
  const space = Math.max(0, tier.fridge - storedMeals(userId).length);
  const stored = perPortion > 0 ? Math.min(toStore, space) : 0;
  const insert = db.prepare("INSERT INTO home_meals (user_id, dish, stamina) VALUES (?, ?, ?)");
  for (let i = 0; i < stored; i++) insert.run(userId, session.dish, perPortion);
  row.cooked_at = now;
  save(row);
  return {
    dish: session.dish,
    score,
    gained: Math.floor(row.stamina) - Math.floor(before),
    portions,
    stored,
    vitals: view(row, userId, now),
  };
}

/** 냉장고에 넣어 둔 음식을 꺼내 먹는다(쿨타임 없음). 배가 부르면 먹지 않는다. */
export function eatStoredMeal(userId: number, mealId: number): { dish: string; gained: number; vitals: Vitals } {
  const row = load(userId);
  const meal = storedMeals(userId).find((m) => m.id === mealId);
  if (!meal) throw { status: 404, message: "냉장고에 그 음식이 없어요." };
  if (row.stamina >= VITALS.maxStamina - 0.5) throw { status: 409, message: "배가 불러요. 체력이 이미 가득해요." };
  // user_id 조건으로 지워야 같은 음식을 동시에 두 번 먹는 일을 막을 수 있다.
  const removed = db.prepare("DELETE FROM home_meals WHERE id = ? AND user_id = ?").run(mealId, userId);
  if (Number(removed.changes) !== 1) throw { status: 409, message: "이미 먹은 음식이에요." };
  const before = row.stamina;
  row.stamina = Math.min(VITALS.maxStamina, row.stamina + meal.stamina);
  if (row.stamina >= VITALS.maxStamina) row.stamina_at = Date.now();
  save(row);
  return { dish: meal.dish, gained: Math.floor(row.stamina) - Math.floor(before), vitals: view(row, userId) };
}
