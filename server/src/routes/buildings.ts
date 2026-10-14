// 시설 인수(건물주): /api/buildings. 다른 사회 시설처럼 수감 중에는 막는다(조회는 허용).
import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import {
  buyBuilding,
  cancelOffer,
  collectVault,
  listBuildings,
  makeOffer,
  respondOffer,
  takeoverBuilding,
} from "../social/buildings.js";

export const buildingsRouter = Router();
buildingsRouter.use(requireAuth);

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

buildingsRouter.get("/", (req, res) => handle(res, () => listBuildings(req.userId!)));
buildingsRouter.post("/:facility/buy", requireNotJailed, (req, res) =>
  handle(res, () => buyBuilding(req.userId!, req.params.facility))
);
buildingsRouter.post("/:facility/takeover", requireNotJailed, (req, res) =>
  handle(res, () => takeoverBuilding(req.userId!, req.params.facility))
);
buildingsRouter.post("/:facility/offer", requireNotJailed, (req, res) =>
  handle(res, () => makeOffer(req.userId!, req.params.facility, req.body?.amount))
);
buildingsRouter.post("/:facility/collect", requireNotJailed, (req, res) =>
  handle(res, () => collectVault(req.userId!, req.params.facility))
);
buildingsRouter.post("/offers/:id/cancel", requireNotJailed, (req, res) =>
  handle(res, () => cancelOffer(req.userId!, Number(req.params.id)))
);
buildingsRouter.post("/offers/:id/accept", requireNotJailed, (req, res) =>
  handle(res, () => respondOffer(req.userId!, Number(req.params.id), true))
);
buildingsRouter.post("/offers/:id/reject", requireNotJailed, (req, res) =>
  handle(res, () => respondOffer(req.userId!, Number(req.params.id), false))
);
