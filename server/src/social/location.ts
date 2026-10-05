// README 11.2: 위치 갱신(자동 GPS/수동) 및 주변 사람 검색.
import { db } from "../db.js";
import { isBlocked } from "./dating.js";
import { CLEAN_CHECK_THRESHOLD, isVisibleUnderCleanCheck } from "./manner.js";

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

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 정확한 거리는 위치 추적(삼각측량)에 악용될 수 있어 클라이언트에 보내지 않고 구간 라벨만 내려준다.
 * 마지막 구간(Infinity)이 나머지를 모두 받는다.
 */
const DISTANCE_BUCKETS: { maxKm: number; label: string }[] = [
  { maxKm: 30, label: "30km 이내" },
  { maxKm: 50, label: "50km 이내" },
  { maxKm: 100, label: "100km 이내" },
  { maxKm: 200, label: "200km 이내" },
  { maxKm: 500, label: "꽤 먼 거리" },
  { maxKm: Infinity, label: "많이 먼 거리" },
];

function distanceBucket(km: number): number {
  return DISTANCE_BUCKETS.findIndex((b) => km <= b.maxKm);
}

/**
 * 거리 제한 없이 가까운 순 목록(요약 카드만). 차단 관계 + 클린 체크(매너 90점 이하) 필터 반영.
 * 클라이언트 필터(거리/최근 접속/사진/매너/하트 보냄)용 플래그를 함께 내려준다. 접속 시각·점수 원값은 보내지 않는다.
 */
export function listNearby(userId: number) {
  const me = getLocation(userId);
  if (!me) throw { status: 400, message: "먼저 위치를 설정해야 합니다." };

  const others = db
    .prepare(
      `SELECT ul.*, u.nickname, u.avatar_url,
         u.last_seen_at >= datetime('now', '-1 day') AS recently_active,
         EXISTS (SELECT 1 FROM profile_photos p WHERE p.user_id = u.id) AS has_photo,
         COALESCE(ms.score, 100) > ? AS good_manner,
         EXISTS (SELECT 1 FROM hearts h WHERE h.sender_id = ? AND h.receiver_id = u.id) AS heart_sent
       FROM user_locations ul
       JOIN users u ON u.id = ul.user_id
       LEFT JOIN manner_scores ms ON ms.user_id = u.id
       WHERE ul.user_id != ?`
    )
    .all(CLEAN_CHECK_THRESHOLD, userId, userId) as any[];

  return others
    .filter((o) => !isBlocked(userId, o.user_id))
    .filter((o) => isVisibleUnderCleanCheck(userId, o.user_id))
    .map((o) => ({ ...o, distanceKm: haversineKm(me.lat, me.lng, o.lat, o.lng) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map((o) => ({
      userId: o.user_id,
      nickname: o.nickname,
      avatarUrl: o.avatar_url,
      distanceBucket: distanceBucket(o.distanceKm),
      distanceLabel: DISTANCE_BUCKETS[distanceBucket(o.distanceKm)].label,
      recentlyActive: !!o.recently_active,
      hasPhoto: !!o.has_photo,
      goodManner: !!o.good_manner,
      heartSent: !!o.heart_sent,
    }));
}
