// 시설 인수(건물주): 마을 시설마다 건물주가 한 명씩 있을 수 있다. 수치와 원칙은 economy.ts BUILDINGS.
// - 아무도 없는 시설은 정가에 인수한다(낸 돈은 사라진다).
// - 건물주가 있으면 정가의 50~150%로 매수 제안을 하거나, 보호 기간이 지났으면 정가 × 2를 건물주에게 주고 강제 인수한다.
// - 수익은 그 건물 금고에 쌓이고, 건물주가 그 건물에 직접 가야(마을 이동 위치 = 그 시설) 받을 수 있다.
import { db } from "../db.js";
import { BUILDINGS, EDUCATION_BOOST, type BuildingKey } from "../economy.js";
import { applyLedgerEntry, withTransaction } from "../wallet/ledger.js";
import { notify, nicknameOf } from "./notifications.js";
import { getVitals } from "./vitals.js";

interface BuildingRow {
  facility: BuildingKey;
  owner_id: number;
  acquired_at: string;
  paid: number;
  vault: number;
  earned_total: number;
}

interface OfferRow {
  id: number;
  facility: BuildingKey;
  buyer_id: number;
  owner_id: number;
  amount: number;
  status: string;
  created_at: string;
}

const KEYS = Object.keys(BUILDINGS.facilities) as BuildingKey[];

function assertKey(facility: string): BuildingKey {
  if (!(facility in BUILDINGS.facilities)) throw { status: 404, message: "인수할 수 없는 시설이에요." };
  return facility as BuildingKey;
}

function rowOf(facility: BuildingKey): BuildingRow | undefined {
  return db.prepare("SELECT * FROM buildings WHERE facility = ?").get(facility) as unknown as BuildingRow | undefined;
}

/** SQLite datetime('now') 문자열(UTC) → epoch ms */
function utcMs(sqliteTime: string): number {
  return Date.parse(`${sqliteTime.replace(" ", "T")}Z`);
}

function isGuest(userId: number): boolean {
  const u = db.prepare("SELECT is_guest FROM users WHERE id = ?").get(userId) as { is_guest: number } | undefined;
  return !u || !!u.is_guest;
}

function ownedCount(userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM buildings WHERE owner_id = ?").get(userId) as { n: number }).n;
}

function expireOldOffers() {
  db.prepare(
    "UPDATE building_offers SET status = 'expired', responded_at = datetime('now') WHERE status = 'pending' AND created_at < datetime('now', ?)"
  ).run(`-${BUILDINGS.offerExpireHours} hours`);
}

// ── 수익 적립 ───────────────────────────────────────────────────────

function addToVault(facility: BuildingKey, amount: number) {
  db.prepare("UPDATE buildings SET vault = vault + ?, earned_total = earned_total + ? WHERE facility = ?").run(
    amount,
    amount,
    facility
  );
}

/**
 * share 수익: 다른 유저가 그 시설에서 번 돈·쓴 돈(amount)의 일부를 시스템이 건물 금고에 넣는다.
 * 건물주 본인과 비회원의 이용은 치지 않는다. 이용자의 돈은 그대로다.
 */
export function creditBuildingShare(facility: BuildingKey, actorId: number, amount: number): void {
  const share = BUILDINGS.facilities[facility].share;
  if (!share || amount <= 0) return;
  const b = rowOf(facility);
  if (!b || b.owner_id === actorId || isGuest(actorId)) return;
  const credit = Math.floor(amount * share);
  if (credit > 0) addToVault(facility, credit);
}

/**
 * fee 수익: 되팔 수 있는 거래(base = 거래 금액)에서 이용자가 수수료를 내고 그 돈이 금고로 간다.
 * 건물주가 없거나 이용자가 건물주면 수수료가 없다. 낸 수수료를 돌려준다.
 * 이용자 잔액이 모자라면 InsufficientBalanceError — 바깥 트랜잭션(구매)째로 취소된다.
 */
export function chargeBuildingFee(facility: BuildingKey, userId: number, base: number, refId?: number): number {
  const rate = BUILDINGS.facilities[facility].fee;
  if (!rate || base <= 0) return 0;
  const b = rowOf(facility);
  if (!b || b.owner_id === userId) return 0;
  const fee = Math.floor(base * rate);
  if (fee <= 0) return 0;
  return withTransaction(() => {
    applyLedgerEntry(userId, `${BUILDINGS.facilities[facility].label}수수료`, -fee, refId);
    addToVault(facility, fee);
    return fee;
  });
}

/** 지금 이 시설에서 이 유저가 거래하면 붙는 수수료율(건물주가 없거나 본인이면 0). 화면 안내용. */
export function feeRateFor(facility: BuildingKey, userId: number): number {
  const rate = BUILDINGS.facilities[facility].fee ?? 0;
  const b = rowOf(facility);
  return !b || b.owner_id === userId ? 0 : rate;
}

/**
 * 학교 건물주: 다른 유저가 졸업 후 강화(education_boosts)를 쌓을 때마다 건물주의 지능도 단위당 조금 오른다.
 * 하루 상한(BUILDINGS.schoolOwnerDailyUnits, KST 자정 기준)이 있다.
 */
export function creditSchoolOwner(actorId: number, source: "lesson" | "exam", refId: number, units: number): void {
  const b = rowOf("school");
  if (!b || b.owner_id === actorId || isGuest(actorId) || units <= 0) return;
  const today = (
    db
      .prepare(
        `SELECT COALESCE(SUM(units), 0) AS n FROM education_boosts
         WHERE user_id = ? AND school_level = 'building' AND created_at >= datetime('now', '+9 hours', 'start of day', '-9 hours')`
      )
      .get(b.owner_id) as { n: number }
  ).n;
  const grant = Math.min(units, BUILDINGS.schoolOwnerDailyUnits - today);
  if (grant <= 0) return;
  db.prepare(
    "INSERT OR IGNORE INTO education_boosts (user_id, school_level, source, ref_id, units) VALUES (?, 'building', ?, ?, ?)"
  ).run(b.owner_id, `owner_${source}`, refId, grant);
}

// ── 조회 ────────────────────────────────────────────────────────────

/** 모든 시설의 건물주 현황. 금고·받은 제안은 건물주 본인에게만, 내가 보낸 제안은 나에게만 보인다. */
export function listBuildings(viewerId: number) {
  expireOldOffers();
  const rows = new Map(
    (db.prepare("SELECT * FROM buildings").all() as unknown as BuildingRow[]).map((r) => [r.facility, r])
  );
  const myOffers = new Map(
    (
      db
        .prepare("SELECT * FROM building_offers WHERE buyer_id = ? AND status = 'pending'")
        .all(viewerId) as unknown as OfferRow[]
    ).map((o) => [o.facility, o])
  );
  const incoming = db.prepare(
    `SELECT o.id, o.buyer_id AS buyerId, u.nickname AS buyer, o.amount, o.created_at AS createdAt
     FROM building_offers o JOIN users u ON u.id = o.buyer_id
     WHERE o.facility = ? AND o.owner_id = ? AND o.status = 'pending' ORDER BY o.amount DESC, o.id`
  );
  const now = Date.now();
  const buildings = KEYS.map((facility) => {
    const cfg = BUILDINGS.facilities[facility];
    const r = rows.get(facility);
    const mine = !!r && r.owner_id === viewerId;
    const protectedUntil = r ? utcMs(r.acquired_at) + BUILDINGS.protectHours * 3_600_000 : null;
    const mo = myOffers.get(facility);
    return {
      facility,
      label: cfg.label,
      effect: cfg.effect,
      price: cfg.price,
      offerMin: Math.ceil(cfg.price * BUILDINGS.offerMinRatio),
      offerMax: Math.floor(cfg.price * BUILDINGS.offerMaxRatio),
      takeoverPrice: cfg.price * BUILDINGS.takeoverRatio,
      owner: r ? { id: r.owner_id, nickname: nicknameOf(r.owner_id) } : null,
      acquiredAt: r ? new Date(utcMs(r.acquired_at)).toISOString() : null,
      protectedUntil: protectedUntil && protectedUntil > now ? new Date(protectedUntil).toISOString() : null,
      mine,
      vault: mine ? r!.vault : null,
      earnedTotal: mine ? r!.earned_total : null,
      incomingOffers: mine ? incoming.all(facility, viewerId) : [],
      myOffer: mo && r && mo.owner_id === r.owner_id ? { id: mo.id, amount: mo.amount, createdAt: mo.created_at } : null,
    };
  });
  return {
    buildings,
    myCount: ownedCount(viewerId),
    maxPerUser: BUILDINGS.maxPerUser,
    offerExpireHours: BUILDINGS.offerExpireHours,
  };
}

/** 프로필 배지용: 이 유저가 가진 건물 이름. */
export function buildingsOwnedBy(userId: number): string[] {
  return (db.prepare("SELECT facility FROM buildings WHERE owner_id = ?").all(userId) as { facility: BuildingKey }[]).map(
    (r) => BUILDINGS.facilities[r.facility]?.label ?? r.facility
  );
}

/** 자산 합계용: 가진 건물의 정가 합. */
export function buildingsValueOf(userId: number): number {
  return (db.prepare("SELECT facility FROM buildings WHERE owner_id = ?").all(userId) as { facility: BuildingKey }[]).reduce(
    (sum, r) => sum + (BUILDINGS.facilities[r.facility]?.price ?? 0),
    0
  );
}

// ── 인수 ────────────────────────────────────────────────────────────

function assertCanAcquire(userId: number) {
  if (isGuest(userId)) throw { status: 403, message: "비회원은 건물을 인수할 수 없어요. 먼저 계정을 저장해 주세요." };
  if (ownedCount(userId) >= BUILDINGS.maxPerUser) {
    throw { status: 409, message: `건물은 한 사람이 ${BUILDINGS.maxPerUser}채까지만 가질 수 있어요.` };
  }
}

/**
 * 주인을 바꾼다: 남은 금고는 이전 건물주에게 지급하고, 이 건물에 걸린 다른 제안은 모두 무효가 된다.
 * 새 건물주의 보호 기간은 지금부터 다시 센다.
 */
function transfer(facility: BuildingKey, from: BuildingRow | undefined, toId: number, paid: number) {
  if (from && from.vault > 0) applyLedgerEntry(from.owner_id, "건물수익수령", from.vault);
  db.prepare(
    `INSERT INTO buildings (facility, owner_id, acquired_at, paid, vault, earned_total) VALUES (?, ?, datetime('now'), ?, 0, 0)
     ON CONFLICT(facility) DO UPDATE SET owner_id = excluded.owner_id, acquired_at = excluded.acquired_at,
       paid = excluded.paid, vault = 0, earned_total = 0`
  ).run(facility, toId, paid);
  db.prepare(
    "UPDATE building_offers SET status = 'expired', responded_at = datetime('now') WHERE facility = ? AND status = 'pending'"
  ).run(facility);
}

/** 아무도 없는 시설을 정가에 인수한다(낸 돈은 시스템이 가져간다). */
export function buyBuilding(userId: number, facilityRaw: string) {
  const facility = assertKey(facilityRaw);
  const cfg = BUILDINGS.facilities[facility];
  return withTransaction(() => {
    if (rowOf(facility)) throw { status: 409, message: "이미 건물주가 있어요. 매수 제안이나 강제 인수를 해 보세요." };
    assertCanAcquire(userId);
    const { balance } = applyLedgerEntry(userId, "건물인수", -cfg.price);
    transfer(facility, undefined, userId, cfg.price);
    return { balance };
  });
}

/** 강제 인수: 보호 기간이 지났으면 정가 × 2를 지금 건물주에게 주고 바로 가져온다. */
export function takeoverBuilding(userId: number, facilityRaw: string) {
  const facility = assertKey(facilityRaw);
  const cfg = BUILDINGS.facilities[facility];
  const price = cfg.price * BUILDINGS.takeoverRatio;
  const result = withTransaction(() => {
    const b = rowOf(facility);
    if (!b) throw { status: 409, message: "아직 건물주가 없어요. 정가에 바로 인수할 수 있어요." };
    if (b.owner_id === userId) throw { status: 409, message: "이미 내 건물이에요." };
    const until = utcMs(b.acquired_at) + BUILDINGS.protectHours * 3_600_000;
    if (Date.now() < until) throw { status: 409, message: "인수한 지 얼마 안 된 건물이라 아직 강제 인수할 수 없어요." };
    assertCanAcquire(userId);
    const { balance } = applyLedgerEntry(userId, "건물인수", -price);
    applyLedgerEntry(b.owner_id, "건물매각", price);
    transfer(facility, b, userId, price);
    return { balance, previousOwner: b.owner_id };
  });
  notify(
    result.previousOwner,
    "building",
    `🏢 ${nicknameOf(userId)}님이 ${cfg.label} 건물을 강제 인수했어요. 인수 대금 ${price.toLocaleString()}원과 금고에 남은 수익이 지급되었어요.`,
    userId
  );
  return { balance: result.balance };
}

/** 매수 제안(정가의 50~150%). 돈은 건물주가 수락할 때 옮겨진다. 같은 건물에는 대기 중인 제안을 하나만 둘 수 있다. */
export function makeOffer(userId: number, facilityRaw: string, rawAmount: unknown) {
  const facility = assertKey(facilityRaw);
  const cfg = BUILDINGS.facilities[facility];
  const amount = Math.floor(Number(rawAmount));
  const min = Math.ceil(cfg.price * BUILDINGS.offerMinRatio);
  const max = Math.floor(cfg.price * BUILDINGS.offerMaxRatio);
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    throw { status: 400, message: `제안 금액은 ${min.toLocaleString()}원 ~ ${max.toLocaleString()}원 사이로 정해 주세요.` };
  }
  expireOldOffers();
  const b = rowOf(facility);
  if (!b) throw { status: 409, message: "아직 건물주가 없어요. 정가에 바로 인수할 수 있어요." };
  if (b.owner_id === userId) throw { status: 409, message: "이미 내 건물이에요." };
  assertCanAcquire(userId);
  const pending = db
    .prepare("SELECT 1 FROM building_offers WHERE facility = ? AND buyer_id = ? AND status = 'pending'")
    .get(facility, userId);
  if (pending) throw { status: 409, message: "이 건물에 이미 보낸 제안이 있어요. 취소하고 다시 제안해 주세요." };
  db.prepare("INSERT INTO building_offers (facility, buyer_id, owner_id, amount) VALUES (?, ?, ?, ?)").run(
    facility,
    userId,
    b.owner_id,
    amount
  );
  notify(
    b.owner_id,
    "building",
    `🏢 ${nicknameOf(userId)}님이 내 ${cfg.label} 건물을 ${amount.toLocaleString()}원에 사고 싶어 해요. 그 건물에 가서 답해 주세요.`,
    userId
  );
  return { ok: true };
}

function pendingOffer(offerId: number): OfferRow {
  expireOldOffers();
  const o = db.prepare("SELECT * FROM building_offers WHERE id = ?").get(offerId) as unknown as OfferRow | undefined;
  if (!o || o.status !== "pending") throw { status: 404, message: "이미 끝났거나 없는 제안이에요." };
  return o;
}

export function cancelOffer(userId: number, offerId: number) {
  const o = pendingOffer(offerId);
  if (o.buyer_id !== userId) throw { status: 404, message: "내가 보낸 제안이 아니에요." };
  db.prepare("UPDATE building_offers SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?").run(o.id);
  return { ok: true };
}

/** 건물주가 제안에 답한다. 수락하면 제안 금액이 제안자에게서 건물주에게 가고 건물이 넘어간다. */
export function respondOffer(userId: number, offerId: number, accept: boolean) {
  const o = pendingOffer(offerId);
  const b = rowOf(o.facility);
  if (!b || b.owner_id !== userId || o.owner_id !== userId) throw { status: 404, message: "내 건물에 온 제안이 아니에요." };
  const label = BUILDINGS.facilities[o.facility].label;
  if (!accept) {
    db.prepare("UPDATE building_offers SET status = 'rejected', responded_at = datetime('now') WHERE id = ?").run(o.id);
    notify(o.buyer_id, "building", `🏢 ${nicknameOf(userId)}님이 ${label} 건물 매수 제안을 거절했어요.`, userId);
    return { ok: true };
  }
  const result = withTransaction(() => {
    if (isGuest(o.buyer_id) || ownedCount(o.buyer_id) >= BUILDINGS.maxPerUser) {
      throw { status: 409, message: "제안한 사람이 지금은 건물을 더 가질 수 없어요." };
    }
    try {
      applyLedgerEntry(o.buyer_id, "건물인수", -o.amount);
    } catch {
      throw { status: 409, message: "제안한 사람의 잔액이 모자라 거래할 수 없어요." };
    }
    const { balance } = applyLedgerEntry(userId, "건물매각", o.amount);
    transfer(o.facility, b, o.buyer_id, o.amount);
    db.prepare("UPDATE building_offers SET status = 'accepted', responded_at = datetime('now') WHERE id = ?").run(o.id);
    return { balance };
  });
  notify(
    o.buyer_id,
    "building",
    `🏢 ${nicknameOf(userId)}님이 제안을 받아들였어요. 이제 ${label} 건물주예요!`,
    userId
  );
  return result;
}

/** 금고에 쌓인 수익을 받는다. 그 건물에 와 있어야 한다(마을에서 마지막으로 도착한 시설). */
export function collectVault(userId: number, facilityRaw: string) {
  const facility = assertKey(facilityRaw);
  if (getVitals(userId).location !== facility) {
    throw { status: 409, message: "금고는 그 건물에 직접 가야 열 수 있어요." };
  }
  return withTransaction(() => {
    const b = rowOf(facility);
    if (!b || b.owner_id !== userId) throw { status: 404, message: "내 건물이 아니에요." };
    if (b.vault <= 0) throw { status: 409, message: "금고가 비어 있어요." };
    db.prepare("UPDATE buildings SET vault = 0 WHERE facility = ?").run(facility);
    const { balance } = applyLedgerEntry(userId, "건물수익수령", b.vault);
    return { collected: b.vault, balance };
  });
}
