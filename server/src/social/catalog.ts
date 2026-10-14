// README 8~10장: 자동차/아파트/명품샵. 구매 → 소유(owned_items) → 프로필 전시 토글 → 되팔기.
import { db } from "../db.js";
import { ASSET_RESALE, type BuildingKey } from "../economy.js";
import { applyLedgerEntry, getBalance, withTransaction } from "../wallet/ledger.js";
import { financialAssetsOf } from "./finance.js";
import { assertNotBlocked } from "./dating.js";
import { buildingsValueOf, chargeBuildingFee } from "./buildings.js";

export interface CatalogItem {
  id: number;
  category: "car" | "apartment" | "luxury";
  brand: string | null;
  name: string;
  price: number;
}

// ── 되팔기 시세 ─────────────────────────────────────────────────────────
const KST_OFFSET = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function kstParts(ms: number): { date: string; hour: number } {
  const k = new Date(ms + KST_OFFSET);
  return { date: k.toISOString().slice(0, 10), hour: k.getUTCHours() };
}

function kstTime(date: string, hour: number): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour) - KST_OFFSET;
}

/** 지금 적용 중인 시세 구간(KST 9·12·15·18시에 바뀜)과 다음에 바뀌는 시각. */
export function currentMarketSlot(now = Date.now()): { key: string; nextChangeAt: string } {
  const hours = ASSET_RESALE.marketHours;
  const { date, hour } = kstParts(now);
  const past = hours.filter((h) => h <= hour);
  const slot = past.length
    ? { date, hour: past[past.length - 1] }
    : { date: kstParts(now - DAY).date, hour: hours[hours.length - 1] };
  const nextHour = hours.find((h) => h > hour);
  const next = nextHour !== undefined ? kstTime(date, nextHour) : kstTime(kstParts(now + DAY).date, hours[0]);
  return {
    key: `${slot.date} ${String(slot.hour).padStart(2, "0")}:00`,
    nextChangeAt: new Date(next).toISOString(),
  };
}

/** 이 시세 구간의 품목 배수. 처음 조회할 때 랜덤으로 정해 저장하므로 미리 알 수 없고, 같은 구간에선 모두에게 같다. */
function marketMultiplier(itemId: number, slotKey: string): number {
  const get = () =>
    db.prepare("SELECT multiplier FROM market_prices WHERE slot_key = ? AND catalog_item_id = ?").get(slotKey, itemId) as
      | { multiplier: number }
      | undefined;
  const found = get();
  if (found) return found.multiplier;
  const { minMultiplier: lo, maxMultiplier: hi } = ASSET_RESALE;
  const m = Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
  db.prepare("INSERT OR IGNORE INTO market_prices (slot_key, catalog_item_id, multiplier) VALUES (?, ?, ?)").run(
    slotKey,
    itemId,
    m
  );
  return get()!.multiplier;
}

/** 지금 살 때 내는 금액: 자동차는 정가, 아파트·명품은 정가 × 지금 시세(1,000원 단위 내림 — 되팔 때와 같은 계산). */
function currentBuyPrice(item: CatalogItem): number {
  if (item.category === "car") return item.price;
  const m = marketMultiplier(item.id, currentMarketSlot().key);
  return Math.floor((item.price * m) / 1000) * 1000;
}

/** 되팔 때 받는 금액. 자동차는 보유 일수만큼 감가, 아파트·명품은 지금 시세 배수. 1,000원 단위 내림. */
function resaleQuote(
  o: { catalog_item_id: number; category: string; price: number; purchased_at: string },
  now = Date.now()
): { price: number; ratio: number; kind: "depreciation" | "market" } {
  let ratio: number;
  let kind: "depreciation" | "market";
  if (o.category === "car") {
    const days = Math.max(0, (now - Date.parse(o.purchased_at.replace(" ", "T") + "Z")) / DAY);
    ratio = Math.max(ASSET_RESALE.carFloorRatio, 1 - ASSET_RESALE.carDepreciationPerDay * days);
    kind = "depreciation";
  } else {
    ratio = marketMultiplier(o.catalog_item_id, currentMarketSlot(now).key);
    kind = "market";
  }
  ratio = Math.round(ratio * 10000) / 10000; // 초 단위 자투리 때문에 0.8이 0.79999…가 되지 않게
  return { price: Math.floor((o.price * ratio) / 1000) * 1000, ratio: Math.round(ratio * 100) / 100, kind };
}

// ── 양도소득세(건물=아파트 카테고리만) ──────────────────────────────
// 팔 때 가진 건물 수(파는 건물 포함)로 세율을 정하고, 판 금액 - 산 금액(이익)에만 매긴다. 손해면 0원.
// 선물 등으로 산 금액 기록이 없으면 정가를 산 금액으로 본다.
const CAPITAL_GAINS_RATES = [0, 0, 0.2, 0.3, 0.4, 0.5]; // [보유 수] → 세율, 5개 이상은 50%

export interface CapitalGainsTax {
  buildings: number; // 팔기 전 보유 건물 수
  rate: number;
  gain: number; // 이익(손해면 음수)
  tax: number;
}

function countBuildings(userId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.user_id = ? AND ci.category = 'apartment'"
      )
      .get(userId) as { n: number }
  ).n;
}

function capitalGainsTax(
  buildings: number,
  o: { category: string; price: number; paid_price: number | null },
  salePrice: number
): CapitalGainsTax | null {
  if (o.category !== "apartment") return null;
  const rate = CAPITAL_GAINS_RATES[Math.min(buildings, CAPITAL_GAINS_RATES.length - 1)];
  const gain = salePrice - (o.paid_price ?? o.price);
  return { buildings, rate, gain, tax: gain > 0 ? Math.floor(gain * rate) : 0 };
}

export function listCatalog(
  category?: string
): (CatalogItem & { basePrice: number; marketMultiplier: number | null })[] {
  const rows = (
    category
      ? db.prepare("SELECT * FROM catalog_items WHERE category = ? ORDER BY price").all(category)
      : db.prepare("SELECT * FROM catalog_items ORDER BY category, price").all()
  ) as unknown as CatalogItem[];
  const slot = currentMarketSlot().key;
  // price = 지금 살 때 내는 금액(아파트·명품은 시세 반영), basePrice = 정가.
  return rows.map((r) => ({
    ...r,
    basePrice: r.price,
    price: currentBuyPrice(r),
    marketMultiplier: r.category === "car" ? null : marketMultiplier(r.id, slot),
  }));
}

function getItem(itemId: number): CatalogItem | undefined {
  return db.prepare("SELECT * FROM catalog_items WHERE id = ?").get(itemId) as unknown as
    | CatalogItem
    | undefined;
}

/**
 * 구매 시점에는 "전시 가능한 상태"로만 저장되고, 실제 노출은 별도 토글(PATCH)로 켜야 한다.
 * 명품은 quantity개를 같은 시세로 한꺼번에 사고, 개수와 상관없이 owned_items 한 행에 개수만 적는다(개수 제한 없음).
 * 자동차·집은 차마다 연료, 집마다 양도세가 따로라 한 번에 하나씩만 산다.
 */
export function purchaseItem(
  userId: number,
  itemId: number,
  quantity = 1
): { ownedItemId: number; quantity: number; total: number; item: CatalogItem } {
  const item = getItem(itemId);
  if (!item) throw { status: 404, message: "존재하지 않는 상품입니다." };
  if (!Number.isInteger(quantity) || quantity < 1) throw { status: 400, message: "수량은 1개 이상으로 입력해주세요." };
  if (item.category !== "luxury" && quantity !== 1) throw { status: 400, message: "자동차·집은 하나씩만 살 수 있어요." };
  const paid = currentBuyPrice(item);
  const total = paid * quantity;
  if (!Number.isSafeInteger(total)) throw { status: 400, message: "수량이 너무 많아요." };
  // 돈 빼기와 물건 넣기를 한 트랜잭션으로 — 중간에 실패하면 돈만 빠지는 일이 없게
  const ownedItemId = withTransaction(() => {
    applyLedgerEntry(userId, "자산구매", -total, item.id); // 잔액이 모자라면 여기서 막혀 아무것도 안 생긴다
    chargeBuildingFee(item.category as BuildingKey, userId, total, item.id); // 그 매장 건물주가 있으면 수수료
    return Number(
      db
        .prepare("INSERT INTO owned_items (user_id, catalog_item_id, paid_price, quantity) VALUES (?, ?, ?, ?)")
        .run(userId, item.id, paid, quantity).lastInsertRowid
    );
  });
  return { ownedItemId, quantity, total, item: { ...item, price: paid } };
}

export function setDisplayed(userId: number, ownedItemId: number, displayed: boolean): void {
  const owned = db.prepare("SELECT * FROM owned_items WHERE id = ?").get(ownedItemId) as any;
  if (!owned || owned.user_id !== userId) {
    throw { status: 404, message: "소유하지 않은 아이템입니다." };
  }
  db.prepare("UPDATE owned_items SET displayed = ? WHERE id = ?").run(displayed ? 1 : 0, ownedItemId);
}

export function listOwnedItems(userId: number) {
  const rows = db
    .prepare(
      "SELECT oi.id, oi.displayed, oi.purchased_at, oi.catalog_item_id, oi.paid_price, oi.quantity, ci.category, ci.brand, ci.name, ci.price FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.user_id = ? ORDER BY oi.id DESC"
    )
    .all(userId) as any[];
  const now = Date.now();
  const buildings = rows.filter((r) => r.category === "apartment").length;
  // price는 정가(마을 지도에서 "가장 비싼 집/차"를 고르는 기준), paidPrice는 실제로 낸 금액(선물 받은 건 null).
  return rows.map(({ paid_price, ...r }) => {
    const resale = resaleQuote(r, now);
    return {
      ...r,
      displayed: !!r.displayed,
      paidPrice: paid_price as number | null,
      resale,
      capitalGainsTax: capitalGainsTax(buildings, { ...r, paid_price }, resale.price), // 건물만, 지금 팔 때 기준
    };
  });
}

/**
 * 소유 자산 하나를 지금 시세(자동차는 감가 반영)로 되판다. 판 자산은 목록·전시에서 사라진다.
 * 여러 개가 묶인 명품 행이면 1개만 판다(개수만 줄어든다).
 */
export function sellOwnedItem(
  userId: number,
  ownedItemId: number
): { soldFor: number; tax: number; balance: number; name: string } {
  const row = db
    .prepare(
      "SELECT oi.id, oi.user_id, oi.purchased_at, oi.catalog_item_id, oi.paid_price, oi.quantity, ci.category, ci.name, ci.price FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.id = ?"
    )
    .get(ownedItemId) as any;
  if (!row || row.user_id !== userId) throw { status: 404, message: "소유하지 않은 자산입니다." };
  const quote = resaleQuote(row);
  const cgt = capitalGainsTax(countBuildings(userId), row, quote.price); // 삭제 전에 세야 파는 건물이 포함된다
  return withTransaction(() => {
    // 행을 줄이거나 지우는 게 성공해야 돈이 들어간다(같은 자산을 두 번 파는 것 방지).
    const removed =
      row.quantity > 1
        ? db
            .prepare("UPDATE owned_items SET quantity = quantity - 1 WHERE id = ? AND user_id = ? AND quantity = ?")
            .run(ownedItemId, userId, row.quantity)
        : db.prepare("DELETE FROM owned_items WHERE id = ? AND user_id = ?").run(ownedItemId, userId);
    if (Number(removed.changes) !== 1) throw { status: 409, message: "이미 판 자산입니다." };
    let { balance } = applyLedgerEntry(userId, "자산판매", quote.price, row.catalog_item_id);
    if (chargeBuildingFee(row.category as BuildingKey, userId, quote.price, row.catalog_item_id) > 0) balance = getBalance(userId);
    // 세금은 판매 대금과 따로 원장에 남긴다(이익 ≤ 판매 대금이라 잔액이 모자랄 일은 없다).
    if (cgt && cgt.tax > 0) balance = applyLedgerEntry(userId, "양도소득세", -cgt.tax, row.catalog_item_id).balance;
    return { soldFor: quote.price, tax: cgt?.tax ?? 0, balance, name: row.name };
  });
}

/**
 * 같은 명품을 quantity개 한꺼번에 판다 — 개수와 상관없이 한 트랜잭션, 원장에도 한 줄.
 * 여러 번 나눠 산 행이 있으면 전시 안 한 행부터, 오래된 행부터 개수를 뺀다(전시 중인 건 최대한 남긴다).
 */
export function sellLuxury(
  userId: number,
  catalogItemId: number,
  quantity: number
): { count: number; soldFor: number; balance: number } {
  if (!Number.isInteger(quantity) || quantity < 1) throw { status: 400, message: "팔 개수를 1개 이상으로 입력해주세요." };
  const item = getItem(catalogItemId);
  if (!item || item.category !== "luxury") throw { status: 404, message: "존재하지 않는 명품입니다." };
  // 명품 되팔기 값은 시세 배수만 쓰므로 산 날짜는 필요 없다.
  const unit = resaleQuote({ catalog_item_id: item.id, category: item.category, price: item.price, purchased_at: "" }).price;
  return withTransaction(() => {
    const rows = db
      .prepare("SELECT id, quantity FROM owned_items WHERE user_id = ? AND catalog_item_id = ? ORDER BY displayed, id")
      .all(userId, catalogItemId) as { id: number; quantity: number }[];
    const have = rows.reduce((sum, r) => sum + r.quantity, 0);
    if (have < quantity) throw { status: 409, message: `가진 개수(${have}개)보다 많이 팔 수 없어요.` };
    const del = db.prepare("DELETE FROM owned_items WHERE id = ?");
    const dec = db.prepare("UPDATE owned_items SET quantity = quantity - ? WHERE id = ?");
    let left = quantity;
    for (const r of rows) {
      if (left === 0) break;
      if (r.quantity <= left) {
        del.run(r.id);
        left -= r.quantity;
      } else {
        dec.run(left, r.id);
        left = 0;
      }
    }
    const soldFor = unit * quantity;
    applyLedgerEntry(userId, "자산판매", soldFor, item.id);
    chargeBuildingFee("luxury", userId, soldFor, item.id); // 명품샵 건물주가 있으면 수수료
    return { count: quantity, soldFor, balance: getBalance(userId) };
  });
}

/** 내 자산 합계: 현금 + 예금 + 주식 평가액 + 채권 원금 + 소유 자산(지금 팔면 받는 금액, 양도세 전) + 인수한 시설(정가). */
export function getNetWorth(userId: number) {
  const cash = getBalance(userId);
  const { deposit, stocks, bonds } = financialAssetsOf(userId);
  const items = listOwnedItems(userId).reduce((sum, o) => sum + o.resale.price * o.quantity, 0);
  const buildings = buildingsValueOf(userId); // 인수한 시설(정가)
  return { total: cash + deposit + stocks + bonds + items + buildings, cash, deposit, stocks, bonds, items, buildings };
}

/** 자산 합계를 "3억원대"처럼 앞자리 단위로 뭉뚱그린다. 다른 사람에게는 정확한 금액 대신 이것만 보여준다. */
export function wealthBand(total: number): string {
  if (total >= 1e12) return `${Math.floor(total / 1e12).toLocaleString()}조원대`;
  if (total >= 1e8) return `${Math.floor(total / 1e8).toLocaleString()}억원대`;
  if (total >= 1e7) return `${Math.floor(total / 1e7)}천만원대`;
  return `${Math.floor(Math.max(0, total) / 1e4).toLocaleString()}만원대`;
}

/** 다른 유저의 프로필 조회 화면에 노출할, 전시 설정된 소유 아이템만. */
export function listDisplayedItems(userId: number) {
  return db
    .prepare(
      "SELECT oi.id, oi.quantity, ci.category, ci.brand, ci.name FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.user_id = ? AND oi.displayed = 1"
    )
    .all(userId);
}

/** README 10장: 명품을 사서 바로 상대에게 선물한다(내 소유가 아니라 상대 소유가 된다). quantity개를 한 트랜잭션으로 보낸다. */
export function giftLuxuryItem(
  senderId: number,
  receiverId: number,
  itemId: number,
  quantity = 1
): { ownedItemId: number; quantity: number; total: number; item: CatalogItem } {
  if (senderId === receiverId) throw { status: 400, message: "자기 자신에게 선물할 수 없습니다." };
  if (!Number.isInteger(quantity) || quantity < 1) throw { status: 400, message: "수량은 1개 이상으로 입력해주세요." };
  assertNotBlocked(senderId, receiverId); // 차단한 사람·다른 연령대에게는 선물할 수 없다
  const item = getItem(itemId);
  if (!item || item.category !== "luxury") {
    throw { status: 404, message: "존재하지 않는 명품입니다." };
  }
  // 명품 선물도 지금 시세로 산다. 받은 사람은 낸 돈이 없으므로 paid_price는 비워 둔다.
  const paid = currentBuyPrice(item);
  const total = paid * quantity;
  if (!Number.isSafeInteger(total)) throw { status: 400, message: "수량이 너무 많아요." };
  const ownedItemId = withTransaction(() => {
    applyLedgerEntry(senderId, "명품선물구매", -total, item.id);
    chargeBuildingFee("luxury", senderId, total, item.id);
    const result = db
      .prepare("INSERT INTO owned_items (user_id, catalog_item_id, quantity) VALUES (?, ?, ?)")
      .run(receiverId, item.id, quantity);
    db.prepare(
      "INSERT INTO gifts (sender_id, receiver_id, item_ref, amount, quantity) VALUES (?, ?, ?, ?, ?)"
    ).run(senderId, receiverId, item.id, total, quantity);
    return Number(result.lastInsertRowid);
  });
  return { ownedItemId, quantity, total, item: { ...item, price: paid } };
}
