// README 11.1: 프로필 사진첩. 기본 1장, 사진첩(2,000만) 구매 시 최대 5장.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";

const DEFAULT_PHOTO_LIMIT = 1;
const ALBUM_PHOTO_LIMIT = 5;
export const PHOTO_ALBUM_COST = 20_000_000;

function hasAlbum(userId: number): boolean {
  return !!db.prepare("SELECT 1 FROM photo_album_purchases WHERE user_id = ?").get(userId);
}

export function addPhoto(userId: number, url: string): { photoId: number; sortOrder: number } {
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM profile_photos WHERE user_id = ?").get(userId) as {
      c: number;
    }
  ).c;
  const limit = hasAlbum(userId) ? ALBUM_PHOTO_LIMIT : DEFAULT_PHOTO_LIMIT;
  if (count >= limit) {
    throw {
      status: 403,
      message: hasAlbum(userId)
        ? "사진첩 최대 5장을 모두 채웠습니다."
        : "사진첩을 구매해야 2번째 사진부터 등록할 수 있습니다.",
    };
  }
  const result = db
    .prepare("INSERT INTO profile_photos (user_id, url, sort_order) VALUES (?, ?, ?)")
    .run(userId, url, count + 1);
  return { photoId: Number(result.lastInsertRowid), sortOrder: count + 1 };
}

export function purchasePhotoAlbum(userId: number): { balance: number } {
  if (hasAlbum(userId)) throw { status: 409, message: "이미 사진첩을 구매했습니다." };
  const { balance } = applyLedgerEntry(userId, "사진첩구매", -PHOTO_ALBUM_COST);
  db.prepare("INSERT INTO photo_album_purchases (user_id) VALUES (?)").run(userId);
  return { balance };
}
