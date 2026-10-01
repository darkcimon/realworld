// 리텐션 루프 라우트: 출석/일일 퀘스트(/api/daily), 알림(/api/notifications).
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { checkIn, claimAllClear, claimQuest, getDailyStatus } from "../social/daily.js";
import { listNotifications, markAllRead, unreadCount } from "../social/notifications.js";

export const dailyRouter = Router();
dailyRouter.use(requireAuth);
dailyRouter.use(requireNotJailed);

dailyRouter.get("/", (req, res) => {
  res.json(getDailyStatus(req.userId!));
});

dailyRouter.post("/checkin", (req, res) => {
  try {
    res.json(checkIn(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

dailyRouter.post("/quests/:key/claim", (req, res) => {
  try {
    res.json(claimQuest(req.userId!, String(req.params.key)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

dailyRouter.post("/all-clear/claim", (req, res) => {
  try {
    res.json(claimAllClear(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", (req, res) => {
  res.json({ unread: unreadCount(req.userId!), items: listNotifications(req.userId!) });
});

notificationsRouter.post("/read-all", (req, res) => {
  markAllRead(req.userId!);
  res.json({ ok: true });
});
