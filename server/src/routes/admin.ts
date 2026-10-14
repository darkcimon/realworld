// 관리자: 신고받은 이용자 확인, 이용 정지·감옥 해제. 환경변수 ADMIN_TOKEN이 있어야 켜진다(없으면 404).
// 화면은 client/public/admin.html(/admin) — 관리자 키를 X-Admin-Token 헤더로 보낸다.
import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { notify } from "../social/notifications.js";
import { BUILDINGS, type BuildingKey } from "../economy.js";
import { getNetWorth } from "../social/catalog.js";
import { depositInterest } from "../social/finance.js";

export const adminRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(404).json({ error: "관리자 기능이 꺼져 있어요 (ADMIN_TOKEN 미설정)." });
    return;
  }
  const given = Buffer.from(String(req.headers["x-admin-token"] ?? ""));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ error: "관리자 키가 틀렸어요." });
    return;
  }
  next();
}

adminRouter.use(requireAdmin);

/** 처리 안 된 신고가 있거나, 정지·감옥 중인 이용자 목록(신고 많은 순). */
adminRouter.get("/reported", (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.nickname, u.email, u.is_guest AS isGuest, u.banned_at AS bannedAt,
              (SELECT COUNT(*) FROM reports r WHERE r.target_id = u.id AND r.cleared_at IS NULL) AS activeReports,
              (SELECT COUNT(*) FROM reports r WHERE r.target_id = u.id) AS totalReports,
              (SELECT MAX(ends_at) FROM jail_sessions j WHERE j.user_id = u.id AND j.active = 1 AND j.ends_at > strftime('%Y-%m-%dT%H:%M:%f', 'now')) AS jailedUntil
       FROM users u
       WHERE u.banned_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM reports r WHERE r.target_id = u.id AND r.cleared_at IS NULL)
       ORDER BY (u.banned_at IS NOT NULL) DESC, activeReports DESC, u.id`
    )
    .all() as { id: number }[];
  const reportsOf = db.prepare(
    `SELECT r.id, r.reason, r.detail, r.created_at AS createdAt, r.cleared_at AS clearedAt, r.reporter_id AS reporterId, ru.nickname AS reporter
     FROM reports r JOIN users ru ON ru.id = r.reporter_id WHERE r.target_id = ? ORDER BY r.id DESC LIMIT 20`
  );
  res.json({ users: users.map((u) => ({ ...u, reports: reportsOf.all(u.id) })) });
});

function targetId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) {
    throw { status: 404, message: "없는 이용자예요." };
  }
  return id;
}

/** 이용 정지 해제 + 감옥에서 꺼내기 + 그동안의 신고를 처리됨으로(누적 0부터 다시). */
adminRouter.post("/users/:id/unban", (req, res) => {
  try {
    const id = targetId(req);
    db.exec("BEGIN");
    db.prepare("UPDATE users SET banned_at = NULL WHERE id = ?").run(id);
    db.prepare("UPDATE jail_sessions SET active = 0 WHERE user_id = ? AND active = 1").run(id);
    db.prepare("UPDATE reports SET cleared_at = datetime('now') WHERE target_id = ? AND cleared_at IS NULL").run(id);
    db.exec("COMMIT");
    notify(id, "system", "✅ 운영자 확인 결과 이용 제한이 풀렸어요. 다시 즐겁게 이용해 주세요!");
    res.json({ ok: true });
  } catch (e: any) {
    if (db.isTransaction) db.exec("ROLLBACK");
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

/** 감옥에서만 꺼낸다(정지·신고 기록은 그대로). */
adminRouter.post("/users/:id/release", (req, res) => {
  try {
    const id = targetId(req);
    db.prepare("UPDATE jail_sessions SET active = 0 WHERE user_id = ? AND active = 1").run(id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

/**
 * 시설 인수 가격을 정하기 위한 경제 통계(economy.ts BUILDINGS.price 조정용). 비회원은 뺀다.
 * - top: 총자산 상위 10명(최근 30일 접속)
 * - buildings: 최근 days일 동안 시설별 거래량, 지금 효과로 건물주가 하루에 벌 금액,
 *   그 금액으로 paybackDays일 만에 본전을 뽑는 가격(recommendedPrice)과 지금 정가
 * 예) GET /api/admin/economy?days=7&payback=30
 */
adminRouter.get("/economy", (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const paybackDays = Math.min(365, Math.max(1, Number(req.query.payback) || 30));
  const since = `-${days} days`;
  const sumOf = (where: string, ...params: string[]) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(ABS(l.amount)), 0) AS s FROM ledger_entries l JOIN users u ON u.id = l.user_id
           LEFT JOIN catalog_items ci ON ci.id = l.ref_id
           WHERE u.is_guest = 0 AND l.created_at >= datetime('now', ?) AND ${where}`
        )
        .get(since, ...(params as string[])) as { s: number }
    ).s;
  const catalog = (category: string) =>
    sumOf("l.type IN ('자산구매', '자산판매', '명품선물구매') AND ci.category = ?", category);
  const volume: Record<BuildingKey, number> = {
    alba: sumOf("l.type = '알바정산'"),
    school: 0,
    jobs: sumOf("l.type = '일급'"),
    mart: sumOf("l.type IN ('장보기', '주유')"),
    lottery: sumOf("l.type = '로또당첨'"),
    luxury: catalog("luxury"),
    car: catalog("car"),
    apartment: catalog("apartment"),
    bank: sumOf("l.type IN ('주식매수', '주식매도')"),
    style: sumOf("l.type = '캐릭터꾸미기'"),
  };
  // 예금 이자는 원장에 남지 않으므로 지금 예금 잔액으로 하루치(3시간 × 8번)를 어림한다.
  const deposits = db
    .prepare("SELECT d.balance FROM deposits d JOIN users u ON u.id = d.user_id WHERE u.is_guest = 0")
    .all() as { balance: number }[];
  const depositInterestPerDay = deposits.reduce((sum, d) => sum + depositInterest(d.balance) * 8, 0);

  const buildings = (Object.keys(BUILDINGS.facilities) as BuildingKey[]).map((key) => {
    const cfg = BUILDINGS.facilities[key];
    const perDay = volume[key] / days;
    let ownerPerDay = perDay * (cfg.share ?? 0) + perDay * (cfg.fee ?? 0);
    if (key === "bank") ownerPerDay = depositInterestPerDay * (cfg.share ?? 0) + perDay * (cfg.fee ?? 0);
    const raw = ownerPerDay * paybackDays;
    const unit = raw > 0 ? 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1) : 1; // 앞 두 자리로 반올림
    return {
      facility: key,
      label: cfg.label,
      volumePerDay: Math.round(perDay),
      ownerIncomePerDay: Math.round(ownerPerDay),
      recommendedPrice: raw > 0 ? Math.round(raw / unit) * unit : null, // 학교(지능)·거래 없음은 null
      currentPrice: cfg.price,
    };
  });

  const users = db
    .prepare("SELECT id, nickname FROM users WHERE is_guest = 0 AND COALESCE(last_seen_at, created_at) >= datetime('now', '-30 days')")
    .all() as { id: number; nickname: string }[];
  const top = users
    .map((u) => ({ ...u, ...getNetWorth(u.id) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  res.json({ days, paybackDays, activeUsers: users.length, depositInterestPerDay: Math.round(depositInterestPerDay), top, buildings });
});
