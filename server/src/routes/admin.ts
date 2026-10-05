// 관리자: 신고받은 이용자 확인, 이용 정지·감옥 해제. 환경변수 ADMIN_TOKEN이 있어야 켜진다(없으면 404).
// 화면은 client/public/admin.html(/admin) — 관리자 키를 X-Admin-Token 헤더로 보낸다.
import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { notify } from "../social/notifications.js";

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
