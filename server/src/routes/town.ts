// 마을 이동(체력/연료), 내 집 잠자기, 마트 장보기·주유.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { requireGraduatedHighSchool } from "../middleware/socialGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import { eat, getVitals, move, refuel, shopMenu, sleep } from "../social/vitals.js";

export const townRouter = Router();
townRouter.use(requireAuth);

function handle(res: any, fn: () => unknown) {
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

townRouter.get("/vitals", (req, res) => handle(res, () => getVitals(req.userId!)));
townRouter.post("/move", requireNotJailed, (req, res) => handle(res, () => move(req.userId!)));
townRouter.post("/sleep", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () => sleep(req.userId!))
);
townRouter.get("/shop", requireGraduatedHighSchool, (req, res) => handle(res, () => shopMenu(req.userId!)));
townRouter.post("/shop/food", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () => eat(req.userId!, String(req.body?.key ?? "")))
);
townRouter.post("/shop/fuel", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () => refuel(req.userId!))
);
