// README 8~10장: 자동차/아파트/명품샵. /api/catalog, /api/owned-items, /api/luxury 세 라우터를 함께 관리한다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import {
  getNetWorth,
  giftLuxuryItem,
  listCatalog,
  listOwnedItems,
  purchaseItem,
  sellOwnedItem,
  sellOwnedItems,
  setDisplayed,
  currentMarketSlot,
} from "../social/catalog.js";

function guard(router: Router) {
  router.use(requireAuth);
}

export const catalogRouter = Router();
guard(catalogRouter);

catalogRouter.get("/", (req, res) => {
  res.json(listCatalog(req.query.category as string | undefined));
});

catalogRouter.get("/owned", (req, res) => {
  res.json(listOwnedItems(req.userId!));
});

// 내 자산 합계(프로필 미리보기의 "X억원대 자산가")
catalogRouter.get("/net-worth", (req, res) => {
  res.json(getNetWorth(req.userId!));
});

// 아파트·명품 시세가 다음에 바뀌는 시각(KST 9·12·15·18시)
catalogRouter.get("/market", (_req, res) => {
  res.json(currentMarketSlot());
});

catalogRouter.post("/:itemId/purchase", (req, res) => {
  try {
    res.json(purchaseItem(req.userId!, Number(req.params.itemId), Number(req.body?.quantity ?? 1)));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const ownedItemsRouter = Router();
guard(ownedItemsRouter);

ownedItemsRouter.patch("/:id", (req, res) => {
  try {
    setDisplayed(req.userId!, Number(req.params.id), !!req.body?.displayed);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// 여러 개를 한꺼번에 판다: { ids: number[] }
ownedItemsRouter.post("/sell-many", (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    res.json(sellOwnedItems(req.userId!, ids));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

ownedItemsRouter.post("/:id/sell", (req, res) => {
  try {
    res.json(sellOwnedItem(req.userId!, Number(req.params.id)));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const luxuryRouter = Router();
guard(luxuryRouter);

luxuryRouter.post("/:itemId/gift", (req, res) => {
  try {
    const receiverId = Number(req.body?.receiverId ?? req.body?.targetId);
    res.json(giftLuxuryItem(req.userId!, receiverId, Number(req.params.itemId)));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});
