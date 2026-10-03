// 마을 이동(체력/연료), 내 집 잠자기, 마트 장보기·주유.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { requireGraduatedHighSchool } from "../middleware/socialGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import {
  eat,
  eatStoredMeal,
  finishCooking,
  getVitals,
  move,
  refuel,
  selectCar,
  shopMenu,
  sleep,
  startCooking,
} from "../social/vitals.js";

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
townRouter.post("/move", requireNotJailed, (req, res) =>
  handle(res, () => move(req.userId!, String(req.body?.to ?? "")))
);
// 운행할 차 고르기(사이드 메뉴)
townRouter.post("/car", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () => selectCar(req.userId!, Number(req.body?.ownedItemId)))
);
// 내 집 요리(리듬게임): 채보 받기 → 끝나면 판정 수 제출
townRouter.post("/cook/start", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () => startCooking(req.userId!))
);
townRouter.post("/cook/finish", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () =>
    finishCooking(req.userId!, String(req.body?.sessionId ?? ""), Number(req.body?.perfect), Number(req.body?.good))
  )
);
// 냉장고에 넣어 둔 음식 꺼내 먹기
townRouter.post("/meals/:id/eat", requireGraduatedHighSchool, requireNotJailed, (req, res) =>
  handle(res, () => eatStoredMeal(req.userId!, Number(req.params.id)))
);
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
