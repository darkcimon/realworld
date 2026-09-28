// README 8~10장: 자동차/아파트/명품샵. 구매 → 소유(owned_items) → 프로필 전시 토글.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";

export interface CatalogItem {
  id: number;
  category: "car" | "apartment" | "luxury";
  brand: string | null;
  name: string;
  price: number;
}

export function listCatalog(category?: string): CatalogItem[] {
  if (category) {
    return db
      .prepare("SELECT * FROM catalog_items WHERE category = ? ORDER BY price")
      .all(category) as unknown as CatalogItem[];
  }
  return db
    .prepare("SELECT * FROM catalog_items ORDER BY category, price")
    .all() as unknown as CatalogItem[];
}

function getItem(itemId: number): CatalogItem | undefined {
  return db.prepare("SELECT * FROM catalog_items WHERE id = ?").get(itemId) as unknown as
    | CatalogItem
    | undefined;
}

/** 구매 시점에는 "전시 가능한 상태"로만 저장되고, 실제 노출은 별도 토글(PATCH)로 켜야 한다. */
export function purchaseItem(userId: number, itemId: number): { ownedItemId: number; item: CatalogItem } {
  const item = getItem(itemId);
  if (!item) throw { status: 404, message: "존재하지 않는 상품입니다." };
  applyLedgerEntry(userId, "자산구매", -item.price, item.id);
  const result = db
    .prepare("INSERT INTO owned_items (user_id, catalog_item_id) VALUES (?, ?)")
    .run(userId, item.id);
  return { ownedItemId: Number(result.lastInsertRowid), item };
}

export function setDisplayed(userId: number, ownedItemId: number, displayed: boolean): void {
  const owned = db.prepare("SELECT * FROM owned_items WHERE id = ?").get(ownedItemId) as any;
  if (!owned || owned.user_id !== userId) {
    throw { status: 404, message: "소유하지 않은 아이템입니다." };
  }
  db.prepare("UPDATE owned_items SET displayed = ? WHERE id = ?").run(displayed ? 1 : 0, ownedItemId);
}

export function listOwnedItems(userId: number) {
  return db
    .prepare(
      "SELECT oi.id, oi.displayed, oi.purchased_at, ci.category, ci.brand, ci.name, ci.price FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.user_id = ? ORDER BY oi.id DESC"
    )
    .all(userId);
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
  const item = getItem(itemId);
  if (!item || item.category !== "luxury") {
    throw { status: 404, message: "존재하지 않는 명품입니다." };
  }
  applyLedgerEntry(senderId, "명품선물구매", -item.price, item.id);
  const result = db
    .prepare("INSERT INTO owned_items (user_id, catalog_item_id) VALUES (?, ?)")
    .run(receiverId, item.id);
  db.prepare(
    "INSERT INTO gifts (sender_id, receiver_id, item_ref, amount) VALUES (?, ?, ?, ?)"
  ).run(senderId, receiverId, item.id, item.price);
  return { ownedItemId: Number(result.lastInsertRowid), item };
}
