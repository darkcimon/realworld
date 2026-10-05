// README 6.1~6.2: 직업 배정 및 근무. /api/jobs, /api/work 두 라우터를 이 파일에서 함께 관리한다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import {
  assignJob,
  continueOrLeaveWork,
  listJobsFor,
  settleUnpaidWork,
  startWork,
  submitWorkAnswer,
  workStatus,
} from "../social/jobs.js";

function guard(router: Router) {
  router.use(requireAuth);
  router.use(requireNotJailed);
}

export const jobsRouter = Router();
guard(jobsRouter);

jobsRouter.get("/", (req, res) => {
  res.json(listJobsFor(req.userId!));
});

jobsRouter.post("/:jobId/assign", (req, res) => {
  try {
    const job = assignJob(req.userId!, Number(req.params.jobId));
    res.json({ ok: true, job });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const workRouter = Router();
guard(workRouter);

workRouter.get("/status", (req, res) => {
  res.json(workStatus(req.userId!));
});

workRouter.post("/start", (req, res) => {
  try {
    res.json(startWork(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

workRouter.post("/answer", (req, res) => {
  try {
    const { sessionId, answer } = req.body ?? {};
    res.json(submitWorkAnswer(req.userId!, Number(sessionId), String(answer ?? "")));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

workRouter.post("/continue-or-leave", (req, res) => {
  try {
    const { sessionId, continueWork } = req.body ?? {};
    res.json(continueOrLeaveWork(req.userId!, Number(sessionId), !!continueWork));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

workRouter.post("/settle", (req, res) => {
  res.json(settleUnpaidWork(req.userId!));
});
