// README 8~10장: 자동차/아파트/명품샵. 구매 → 소유(owned_items) → 프로필 전시 토글 → 되팔기.
import { db } from "../db.js";
import { ASSET_RESALE } from "../economy.js";
import { applyLedgerEntry, getBalance, withTransaction } from "../wallet/ledger.js";
import { financialAssetsOf } from "./finance.js";
import { assertNotBlocked } from "./dating.js";

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

/** 한 번에 살 수 있는 최대 개수. */
const MAX_PURCHASE_QUANTITY = 100;

/** 구매 시점에는 "전시 가능한 상태"로만 저장되고, 실제 노출은 별도 토글(PATCH)로 켜야 한다. quantity개를 같은 시세로 한꺼번에 산다. */
export function purchaseItem(
  userId: number,
  itemId: number,
  quantity = 1
): { ownedItemId: number; ownedItemIds: number[]; quantity: number; total: number; item: CatalogItem } {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    throw { status: 400, message: `수량은 1~${MAX_PURCHASE_QUANTITY}개로 입력해주세요.` };
  }
  const item = getItem(itemId);
  if (!item) throw { status: 404, message: "존재하지 않는 상품입니다." };
  const paid = currentBuyPrice(item);
  const total = paid * quantity;
  // 돈 빼기와 물건 넣기를 한 트랜잭션으로 — 중간에 실패하면 돈만 빠지는 일이 없게
  const ownedItemIds = withTransaction(() => {
    applyLedgerEntry(userId, "자산구매", -total, item.id); // 잔액이 모자라면 여기서 막혀 아무것도 안 생긴다
    const insert = db.prepare("INSERT INTO owned_items (user_id, catalog_item_id, paid_price) VALUES (?, ?, ?)");
    return Array.from({ length: quantity }, () => Number(insert.run(userId, item.id, paid).lastInsertRowid));
  });
  return { ownedItemId: ownedItemIds[0], ownedItemIds, quantity, total, item: { ...item, price: paid } };
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
      "SELECT oi.id, oi.displayed, oi.purchased_at, oi.catalog_item_id, oi.paid_price, ci.category, ci.brand, ci.name, ci.price FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.user_id = ? ORDER BY oi.id DESC"
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

/** 소유 자산을 지금 시세(자동차는 감가 반영)로 되판다. 판 자산은 목록·전시에서 사라진다. */
export function sellOwnedItem(
  userId: number,
  ownedItemId: number
): { soldFor: number; tax: number; balance: number; name: string } {
  const row = db
    .prepare(
      "SELECT oi.id, oi.user_id, oi.purchased_at, oi.catalog_item_id, oi.paid_price, ci.category, ci.name, ci.price FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.id = ?"
    )
    .get(ownedItemId) as any;
  if (!row || row.user_id !== userId) throw { status: 404, message: "소유하지 않은 자산입니다." };
  const quote = resaleQuote(row);
  const cgt = capitalGainsTax(countBuildings(userId), row, quote.price); // 삭제 전에 세야 파는 건물이 포함된다
  // 행 삭제가 성공해야 돈이 들어간다(같은 자산을 두 번 파는 것 방지).
  const del = db.prepare("DELETE FROM owned_items WHERE id = ? AND user_id = ?").run(ownedItemId, userId);
  if (Number(del.changes) !== 1) throw { status: 409, message: "이미 판 자산입니다." };
  let { balance } = applyLedgerEntry(userId, "자산판매", quote.price, row.catalog_item_id);
  // 세금은 판매 대금과 따로 원장에 남긴다(이익 ≤ 판매 대금이라 잔액이 모자랄 일은 없다).
  if (cgt && cgt.tax > 0) balance = applyLedgerEntry(userId, "양도소득세", -cgt.tax, row.catalog_item_id).balance;
  return { soldFor: quote.price, tax: cgt?.tax ?? 0, balance, name: row.name };
}

/** 여러 자산을 한꺼번에 판다. 하나씩 파는 것과 같은 계산(건물 양도세는 파는 순서대로 보유 수가 줄어든다). */
export function sellOwnedItems(
  userId: number,
  ownedItemIds: number[]
): { count: number; soldFor: number; tax: number; balance: number } {
  const ids = [...new Set(ownedItemIds)];
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
    throw { status: 400, message: "팔 자산을 골라주세요." };
  }
  // 하나라도 내 것이 아니면 아무것도 팔지 않는다.
  const mine = ids.filter(
    (id) => (db.prepare("SELECT user_id FROM owned_items WHERE id = ?").get(id) as { user_id: number } | undefined)?.user_id === userId
  );
  if (mine.length !== ids.length) throw { status: 404, message: "소유하지 않은 자산이 섞여 있습니다." };
  let soldFor = 0;
  let tax = 0;
  let balance = 0;
  for (const id of ids) {
    const r = sellOwnedItem(userId, id);
    soldFor += r.soldFor;
    tax += r.tax;
    balance = r.balance;
  }
  return { count: ids.length, soldFor, tax, balance };
}

/** 내 자산 합계: 현금 + 예금 + 주식 평가액 + 채권 원금 + 소유 자산(지금 팔면 받는 금액, 양도세 전). */
export function getNetWorth(userId: number) {
  const cash = getBalance(userId);
  const { deposit, stocks, bonds } = financialAssetsOf(userId);
  const items = listOwnedItems(userId).reduce((sum, o) => sum + o.resale.price, 0);
  return { total: cash + deposit + stocks + bonds + items, cash, deposit, stocks, bonds, items };
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
      "SELECT oi.id, ci.category, ci.brand, ci.name FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.user_id = ? AND oi.displayed = 1"
    )
    .all(userId);
}

/** README 10장: 명품을 사서 바로 상대에게 선물한다(내 소유가 아니라 상대 소유가 된다). */
export function giftLuxuryItem(
  senderId: number,
  receiverId: number,
  itemId: number
): { ownedItemId: number; item: CatalogItem } {
  if (senderId === receiverId) throw { status: 400, message: "자기 자신에게 선물할 수 없습니다." };
  assertNotBlocked(senderId, receiverId); // 차단한 사람·다른 연령대에게는 선물할 수 없다
  const item = getItem(itemId);
  if (!item || item.category !== "luxury") {
    throw { status: 404, message: "존재하지 않는 명품입니다." };
  }
  // 명품 선물도 지금 시세로 산다. 받은 사람은 낸 돈이 없으므로 paid_price는 비워 둔다.
  const paid = currentBuyPrice(item);
  applyLedgerEntry(senderId, "명품선물구매", -paid, item.id);
  const result = db
    .prepare("INSERT INTO owned_items (user_id, catalog_item_id) VALUES (?, ?)")
    .run(receiverId, item.id);
  db.prepare(
    "INSERT INTO gifts (sender_id, receiver_id, item_ref, amount) VALUES (?, ?, ?, ?)"
  ).run(senderId, receiverId, item.id, paid);
  return { ownedItemId: Number(result.lastInsertRowid), item: { ...item, price: paid } };
}
