// 자산 랭킹(전체/내 주변)과 자랑 카드: /api/ranking
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getRanking, getShareCard } from "../social/ranking.js";

export const rankingRouter = Router();
rankingRouter.use(requireAuth);

rankingRouter.get("/", (req, res) => {
  try {
    res.json(getRanking(req.userId!, req.query.scope === "nearby" ? "nearby" : "all"));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

rankingRouter.get("/me", (req, res) => {
  res.json(getShareCard(req.userId!));
});
