// README 6.4~6.5: 매너 점수 / 클린 체크 / 사회인 감옥
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { applyLedgerEntry, InsufficientBalanceError } from "../wallet/ledger.js";
import {
  checkSocialContent,
  getManner,
  MANNER_RESET_COST,
  resetManner,
  setCleanCheck,
} from "../social/manner.js";

export const mannerRouter = Router();
mannerRouter.use(requireAuth);
mannerRouter.use(requireNotJailed);

mannerRouter.get("/me", (req, res) => {
  const row = getManner(req.userId!);
  res.json({ userId: row.user_id, score: row.score, cleanCheck: !!row.clean_check });
});

mannerRouter.get("/:userId", (req, res) => {
  const row = getManner(Number(req.params.userId));
  res.json({ userId: row.user_id, score: row.score });
});

mannerRouter.post("/clean-check", (req, res) => {
  setCleanCheck(req.userId!, !!req.body?.enabled);
  res.json({ ok: true, cleanCheck: !!req.body?.enabled });
});

mannerRouter.post("/reset", (req, res) => {
  try {
    const { balance } = applyLedgerEntry(req.userId!, "매너초기화", -MANNER_RESET_COST);
    resetManner(req.userId!);
    res.json({ ok: true, balance });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
});

// 사회 콘텐츠(직장 대화, 사회인 채팅 등)에서 자유 텍스트가 오갈 때 재사용할 공용 훅.
// Phase 2에는 아직 전용 채팅 화면이 없어 이 엔드포인트로 직접 호출해 검증한다.
mannerRouter.post("/violation-check", (req, res) => {
  const content = String(req.body?.content ?? "");
  res.json(checkSocialContent(req.userId!, content));
});
