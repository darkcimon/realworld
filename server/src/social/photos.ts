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

/** 내 사진첩: 사진, 지금 올릴 수 있는 최대 장수, 사진첩(5장) 구매 여부. */
export function listMyPhotos(userId: number) {
  const photos = db
    .prepare("SELECT id, url, sort_order AS sortOrder FROM profile_photos WHERE user_id = ? ORDER BY sort_order")
    .all(userId);
  const album = hasAlbum(userId);
  return { photos, limit: album ? ALBUM_PHOTO_LIMIT : DEFAULT_PHOTO_LIMIT, hasAlbum: album, albumCost: PHOTO_ALBUM_COST, maxLimit: ALBUM_PHOTO_LIMIT };
}

/** 내 사진 지우기(남은 사진 순서는 1부터 다시 매긴다). */
export function deletePhoto(userId: number, photoId: number): void {
  const removed = db.prepare("DELETE FROM profile_photos WHERE id = ? AND user_id = ?").run(photoId, userId).changes;
  if (!removed) throw { status: 404, message: "내 사진이 아니에요." };
  const rest = db.prepare("SELECT id FROM profile_photos WHERE user_id = ? ORDER BY sort_order").all(userId) as { id: number }[];
  const set = db.prepare("UPDATE profile_photos SET sort_order = ? WHERE id = ?");
  rest.forEach((p, i) => set.run(i + 1, p.id));
}

/** 사진첩의 사진을 프로필(대표) 사진으로. */
export function useAsAvatar(userId: number, photoId: number): void {
  const row = db.prepare("SELECT url FROM profile_photos WHERE id = ? AND user_id = ?").get(photoId, userId) as { url: string } | undefined;
  if (!row) throw { status: 404, message: "내 사진이 아니에요." };
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(row.url, userId);
}
