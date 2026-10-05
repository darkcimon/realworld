// 금융 건물: /api/finance — 예금, 주식, 채권. 다른 사회 시설처럼 수감 중에는 막는다.
import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import {
  buyBond,
  buyStock,
  depositMoney,
  getDeposit,
  listBonds,
  listStocks,
  sellStock,
  withdrawMoney,
} from "../social/finance.js";

export const financeRouter = Router();
financeRouter.use(requireAuth);
financeRouter.use(requireNotJailed);

function handle(res: Response, fn: () => unknown) {
  try {
    res.json(fn());
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
}

financeRouter.get("/deposit", (req, res) => handle(res, () => getDeposit(req.userId!)));
financeRouter.post("/deposit", (req, res) => handle(res, () => depositMoney(req.userId!, req.body?.amount)));
financeRouter.post("/withdraw", (req, res) => handle(res, () => withdrawMoney(req.userId!, req.body?.amount)));

financeRouter.get("/stocks", (req, res) => handle(res, () => listStocks(req.userId!)));
financeRouter.post("/stocks/:id/buy", (req, res) =>
  handle(res, () => buyStock(req.userId!, Number(req.params.id), req.body?.shares))
);
financeRouter.post("/stocks/:id/sell", (req, res) =>
  handle(res, () => sellStock(req.userId!, Number(req.params.id), req.body?.shares))
);

financeRouter.get("/bonds", (req, res) => handle(res, () => listBonds(req.userId!)));
financeRouter.post("/bonds/:id/buy", (req, res) =>
  handle(res, () => buyBond(req.userId!, Number(req.params.id), req.body?.qty))
);
