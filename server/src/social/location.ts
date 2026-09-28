// README 11.2: 위치 갱신(자동 GPS/수동) 및 반경 검색.
import { db } from "../db.js";
import { isBlocked } from "./dating.js";
import { isVisibleUnderCleanCheck } from "./manner.js";

const MANUAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface LocationRow {
  user_id: number;
  lat: number;
  lng: number;
  source: "gps" | "manual";
  updated_at: string;
  last_manual_change_at: string | null;
}

function getLocation(userId: number): LocationRow | undefined {
  return db.prepare("SELECT * FROM user_locations WHERE user_id = ?").get(userId) as unknown as
    | LocationRow
    | undefined;
}

/** GPS 자동 갱신. 수동 위치가 우선 적용 중이면(README: "수동 설정 시 우선 적용") 덮어쓰지 않는다. */
export function updateGpsLocation(
  userId: number,
  lat: number,
  lng: number
): { applied: boolean } {
  const existing = getLocation(userId);
  if (existing && existing.source === "manual") {
    return { applied: false };
  }
  db.prepare(
    `INSERT INTO user_locations (user_id, lat, lng, source, updated_at) VALUES (?, ?, ?, 'gps', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, source = 'gps', updated_at = datetime('now')`
  ).run(userId, lat, lng);
  return { applied: true };
}

export function updateManualLocation(userId: number, lat: number, lng: number): { ok: true } {
  const existing = getLocation(userId);
  if (existing?.last_manual_change_at) {
    const elapsedMs = Date.now() - new Date(existing.last_manual_change_at + "Z").getTime();
    if (elapsedMs < MANUAL_COOLDOWN_MS) {
      throw { status: 403, message: "수동 위치 변경은 24시간에 1회만 가능합니다." };
    }
  }
  db.prepare(
    `INSERT INTO user_locations (user_id, lat, lng, source, updated_at, last_manual_change_at)
     VALUES (?, ?, ?, 'manual', datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, source = 'manual',
       updated_at = datetime('now'), last_manual_change_at = datetime('now')`
  ).run(userId, lat, lng);
  return { ok: true };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 반경 내 목록(요약 카드만). 차단 관계 + 클린 체크(매너 90점 이하) 필터 반영. */
export function listNearby(userId: number, radiusKm: number) {
  const me = getLocation(userId);
  if (!me) throw { status: 400, message: "먼저 위치를 설정해야 합니다." };

  const others = db
    .prepare(
      "SELECT ul.*, u.nickname, u.avatar_url FROM user_locations ul JOIN users u ON u.id = ul.user_id WHERE ul.user_id != ?"
    )
    .all(userId) as any[];

  return others
    .filter((o) => !isBlocked(userId, o.user_id))
    .filter((o) => isVisibleUnderCleanCheck(userId, o.user_id))
    .map((o) => ({ ...o, distanceKm: haversineKm(me.lat, me.lng, o.lat, o.lng) }))
    .filter((o) => o.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map((o) => ({
      userId: o.user_id,
      nickname: o.nickname,
      avatarUrl: o.avatar_url,
      distanceKm: Math.round(o.distanceKm * 10) / 10,
    }));
}
