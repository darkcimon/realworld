// 점장 NPC 라우트(선택지형). 플레이어는 서버가 내려준 선택지 키만 보낼 수 있다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { requireGraduatedHighSchool } from "../middleware/socialGate.js";
import { chooseOption, getManagerPanel } from "../social/npcManager.js";
import { voiceGreeting, voiceLine } from "../social/npcVoice.js";
import { chooseBossOption, getBossPanel } from "../social/npcBoss.js";
import { chatWithColleague, getColleagueMessages, getWorkplace } from "../social/workplace.js";

export const npcRouter = Router();
npcRouter.use(requireAuth);
npcRouter.use(requireGraduatedHighSchool);
npcRouter.use(requireNotJailed);

npcRouter.get("/manager", async (req, res) => {
  const panel = getManagerPanel(req.userId!);
  panel.greeting = await voiceGreeting(req.userId!, "manager", panel.greeting);
  res.json(panel);
});

npcRouter.post("/manager/choose", async (req, res) => {
  try {
    const { eventId, choiceKey } = req.body ?? {};
    const result = chooseOption(req.userId!, Number(eventId), String(choiceKey ?? ""));
    result.reply = await voiceLine(req.userId!, "manager", "플레이어가 선택지를 골랐을 때의 점장 반응", result.reply);
    res.json({ ...result, panel: getManagerPanel(req.userId!) });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// 직장 상사(주간 평가 + 승진). 응답은 점장과 같은 방식으로 서버가 내려준 선택지 키만 받는다.
npcRouter.get("/boss", async (req, res) => {
  const panel = getBossPanel(req.userId!);
  if (panel.assigned) panel.greeting = await voiceGreeting(req.userId!, "boss", panel.greeting);
  res.json(panel);
});

npcRouter.post("/boss/choose", async (req, res) => {
  try {
    const { eventId, choiceKey } = req.body ?? {};
    const result = chooseBossOption(req.userId!, Number(eventId), String(choiceKey ?? ""));
    result.reply = await voiceLine(req.userId!, "boss", "플레이어가 선택지를 골랐을 때의 직장 상사 반응", result.reply);
    res.json({ ...result, panel: getBossPanel(req.userId!) });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// 직장 동료(LLM 자유 대화). 대사는 LLM이, 칭찬/경고/평가 가감점은 서버가 권한·상한 안에서만 실행한다.
npcRouter.get("/colleagues", (req, res) => {
  res.json(getWorkplace(req.userId!));
});

npcRouter.get("/colleagues/:key/messages", (req, res) => {
  try {
    res.json(getColleagueMessages(req.userId!, String(req.params.key)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

npcRouter.post("/colleagues/:key/chat", async (req, res) => {
  try {
    const result = await chatWithColleague(req.userId!, String(req.params.key), String(req.body?.message ?? ""));
    res.json(result);
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});
