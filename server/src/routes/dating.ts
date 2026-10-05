// README 11.2~11.5: 프로필 열람권/채팅 개시, 선물, 하트/맞하트, 차단.
// /api/profile-view, /api/chat, /api/gifts, /api/hearts, /api/blocks 다섯 라우터를 함께 관리한다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import {
  block,
  getProfileDetail,
  heartStatus,
  listConversations,
  listIncomingHearts,
  listMatches,
  listSocialMessages,
  purchaseProfileView,
  reciprocateHeart,
  requestChat,
  sendGift,
  sendHeart,
  sendSocialMessage,
  unblock,
} from "../social/dating.js";

function guard(router: Router) {
  router.use(requireAuth);
  router.use(requireNotJailed);
}

export const profileViewRouter = Router();
guard(profileViewRouter);

profileViewRouter.post("/:targetId/purchase", (req, res) => {
  try {
    res.json(purchaseProfileView(req.userId!, Number(req.params.targetId)));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

profileViewRouter.get("/:targetId", (req, res) => {
  try {
    res.json(getProfileDetail(req.userId!, Number(req.params.targetId)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const chatRouter = Router();
guard(chatRouter);

chatRouter.post("/request/:targetId", (req, res) => {
  try {
    res.json(requestChat(req.userId!, Number(req.params.targetId)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

chatRouter.get("/conversations", (req, res) => {
  res.json(listConversations(req.userId!));
});

chatRouter.get("/messages/:targetId", (req, res) => {
  try {
    res.json(listSocialMessages(req.userId!, Number(req.params.targetId)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

chatRouter.post("/messages/:targetId", (req, res) => {
  try {
    res.json(sendSocialMessage(req.userId!, Number(req.params.targetId), req.body?.content));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const matchesRouter = Router();
guard(matchesRouter);

matchesRouter.get("/", (req, res) => {
  res.json(listMatches(req.userId!));
});

export const giftsRouter = Router();
guard(giftsRouter);

giftsRouter.post("/:targetId", (req, res) => {
  try {
    res.json(sendGift(req.userId!, Number(req.params.targetId), Number(req.body?.ownedItemId)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const heartsRouter = Router();
guard(heartsRouter);

heartsRouter.get("/incoming", (req, res) => {
  res.json(listIncomingHearts(req.userId!));
});

heartsRouter.get("/status/:targetId", (req, res) => {
  res.json(heartStatus(req.userId!, Number(req.params.targetId)));
});

heartsRouter.post("/:targetId", (req, res) => {
  try {
    res.json(sendHeart(req.userId!, Number(req.params.targetId)));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

heartsRouter.post("/:targetId/reciprocate", (req, res) => {
  try {
    res.json(reciprocateHeart(req.userId!, Number(req.params.targetId)));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const blocksRouter = Router();
guard(blocksRouter);

blocksRouter.post("/:targetId", (req, res) => {
  block(req.userId!, Number(req.params.targetId));
  res.json({ ok: true });
});

blocksRouter.delete("/:targetId", (req, res) => {
  unblock(req.userId!, Number(req.params.targetId));
  res.json({ ok: true });
});
