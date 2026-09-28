// Phase 2 지갑 조회. Phase2.md의 API 목록에는 없지만, ledger_entries 기반 잔액 검증
// ("모든 재화 이동이 ledger_entries에 기록되어 잔액 합산 검증 가능")을 실제로 확인하려면
// 클라이언트가 잔액/원장을 조회할 방법이 있어야 하므로 최소 조회 API만 둔다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getBalance, listLedger } from "../wallet/ledger.js";

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get("/me", (req, res) => {
  res.json({ balance: getBalance(req.userId!) });
});

walletRouter.get("/ledger", (req, res) => {
  res.json(listLedger(req.userId!));
});
