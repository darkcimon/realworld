// 자산 랭킹: 최근 접속한 유저들의 자산 합계(getNetWorth: 현금+예금+주식+채권+소유 자산 시세) 순위.
// 유저마다 자산 합계를 계산하는 비용이 커서, 요청마다 다시 세지 않고 RANKING.refreshMinutes마다
// 한 번 만든 스냅샷을 돌려준다. 내 순위는 내 지금 자산으로 스냅샷 안에서 바로 계산한다.
// 다른 사람의 정확한 금액은 보내지 않고 "3억원대" 같은 구간만 보여준다(인연찾기 상세 프로필과 같은 원칙).
import { db } from "../db.js";
import { RANKING } from "../economy.js";
import { getNetWorth, wealthBand } from "./catalog.js";
import { isBlocked } from "./dating.js";
import { educationOf } from "./education.js";
import { haversineKm } from "./location.js";

export type RankingScope = "all" | "nearby";

interface Entry {
  userId: number;
  nickname: string;
  avatarUrl: string | null;
  total: number;
  home: string | null; // 가장 비싼 집(없으면 null = 박스집)
  car: string | null; // 가장 비싼 차
  luxuryCount: number;
  education: string;
}

let snapshot: { at: number; entries: Entry[] } | null = null;

/** 가장 비싼 집·차 이름과 명품 개수. */
function showcaseOf(userId: number): { home: string | null; car: string | null; luxuryCount: number } {
  const rows = db
    .prepare(
      `SELECT ci.category, ci.name FROM owned_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
       WHERE oi.user_id = ? ORDER BY ci.price DESC`
    )
    .all(userId) as { category: string; name: string }[];
  return {
    home: rows.find((r) => r.category === "apartment")?.name ?? null,
    car: rows.find((r) => r.category === "car")?.name ?? null,
    luxuryCount: rows.filter((r) => r.category === "luxury").length,
  };
}

function entryOf(user: { id: number; nickname: string; avatar_url: string | null }, total: number): Entry {
  return {
    userId: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    total,
    ...showcaseOf(user.id),
    education: educationOf(user.id).label,
  };
}

function entries(now = Date.now()): Entry[] {
  if (snapshot && now - snapshot.at < RANKING.refreshMinutes * 60_000) return snapshot.entries;
  const users = db
    .prepare(
      `SELECT id, nickname, avatar_url FROM users
       WHERE COALESCE(last_seen_at, created_at) >= datetime('now', ?)`
    )
    .all(`-${RANKING.activeDays} days`) as { id: number; nickname: string; avatar_url: string | null }[];
  const list = users
    .map((u) => entryOf(u, getNetWorth(u.id).total))
    .sort((a, b) => b.total - a.total || a.userId - b.userId);
  snapshot = { at: now, entries: list };
  return list;
}

/** 내 주변(RANKING.nearbyKm 이내) 유저만. 위치를 설정하지 않았으면 볼 수 없다. */
function nearbyFilter(userId: number): (e: Entry) => boolean {
  const locs = new Map(
    (db.prepare("SELECT user_id, lat, lng FROM user_locations").all() as { user_id: number; lat: number; lng: number }[]).map(
      (r) => [r.user_id, r]
    )
  );
  const me = locs.get(userId);
  if (!me) throw { status: 400, message: "내 주변 랭킹을 보려면 먼저 내 집 → 인연찾기에서 위치를 설정해 주세요." };
  return (e) => {
    const l = locs.get(e.userId);
    return !!l && haversineKm(me.lat, me.lng, l.lat, l.lng) <= RANKING.nearbyKm;
  };
}

function publicRow(e: Entry, rank: number, viewerId: number) {
  return {
    rank,
    userId: e.userId,
    nickname: e.nickname,
    avatarUrl: e.avatarUrl,
    wealthBand: wealthBand(e.total),
    home: e.home,
    car: e.car,
    luxuryCount: e.luxuryCount,
    education: e.education,
    isMe: e.userId === viewerId,
  };
}

/** 내 순위(지금 자산 기준): 스냅샷에서 나보다 자산이 많은 사람 수 + 1. */
function myRank(userId: number, list: Entry[], filter?: (e: Entry) => boolean) {
  const user = db.prepare("SELECT id, nickname, avatar_url FROM users WHERE id = ?").get(userId) as {
    id: number;
    nickname: string;
    avatar_url: string | null;
  };
  const me = entryOf(user, getNetWorth(userId).total);
  const others = list.filter((e) => e.userId !== userId && (!filter || filter(e)));
  return {
    ...publicRow(me, others.filter((e) => e.total > me.total).length + 1, userId),
    total: me.total, // 정확한 금액은 본인에게만
    outOf: others.length + 1,
  };
}

export function getRanking(userId: number, scope: RankingScope) {
  const filter = scope === "nearby" ? nearbyFilter(userId) : undefined;
  const list = entries().filter((e) => !filter || filter(e));
  // 순위는 차단 여부와 상관없이 매기고, 차단 관계인 사람은 목록에서만 뺀다.
  const top = list
    .slice(0, RANKING.topCount)
    .map((e, i) => ({ e, rank: i + 1 }))
    .filter(({ e }) => e.userId === userId || !isBlocked(userId, e.userId))
    .map(({ e, rank }) => publicRow(e, rank, userId));
  return {
    scope,
    updatedAt: new Date(snapshot!.at).toISOString(),
    refreshMinutes: RANKING.refreshMinutes,
    top,
    me: myRank(userId, entries(), filter),
  };
}

/** 자랑 카드에 들어갈 내 정보(전체 랭킹 기준). */
export function getShareCard(userId: number) {
  return myRank(userId, entries());
}
