// README 6.3: 알바 — 마트
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { endMartShift, recordMartTransaction, skipTimedOutCustomer, startMartShift } from "../social/mart.js";

export const albaRouter = Router();
albaRouter.use(requireAuth);
albaRouter.use(requireNotJailed);

albaRouter.post("/mart/shift/start", (req, res) => {
  try {
    res.json(startMartShift(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

albaRouter.post("/mart/transaction", (req, res) => {
  try {
    res.json(recordMartTransaction(req.userId!, Number(req.body?.enteredAmount)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error", timedOut: !!e.timedOut });
  }
});

albaRouter.post("/mart/timeout", (req, res) => {
  try {
    res.json(skipTimedOutCustomer(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

albaRouter.post("/mart/shift/end", (req, res) => {
  try {
    res.json(endMartShift(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});
