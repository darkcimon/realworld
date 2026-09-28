// README 7장: 로또
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { requireGraduatedHighSchool } from "../middleware/socialGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import { buyTicket, drawRound, getRound, getTodayStatus, todayKstDate } from "../social/lottery.js";

export const lotteryRouter = Router();
lotteryRouter.use(requireAuth);
lotteryRouter.use(requireGraduatedHighSchool);
lotteryRouter.use(requireNotJailed);

lotteryRouter.post("/buy", (req, res) => {
  try {
    const units = Number(req.body?.amount ?? req.body?.units);
    res.json(buyTicket(req.userId!, units));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

lotteryRouter.get("/today", (req, res) => {
  res.json(getTodayStatus(req.userId!));
});

lotteryRouter.get("/rounds/:date", (req, res) => {
  const round = getRound(req.params.date, req.userId!);
  if (!round) {
    res.status(404).json({ error: "존재하지 않는 회차입니다." });
    return;
  }
  res.json(round);
});

// 매일 19:00 자동 추첨을 실제로 기다리지 않고 검증할 수 있도록 하는 개발용 엔드포인트.
// (README 4.3의 dev/fast-forward와 동일한 취지)
// ?date=YYYY-MM-DD로 특정 회차를 지정할 수 있다 — 저녁 7시 이후(KST)에 구매하면
// buyTicket이 자동으로 "다음 회차"로 넘기므로(social/lottery.ts), 오늘 날짜만 추첨하면
// 방금 산 티켓이 걸린 회차를 영영 확인할 수 없는 경우가 생겨서 넣었다.
lotteryRouter.post("/dev/draw-today", (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : todayKstDate();
  res.json(drawRound(date));
});
