// README 8~10장: 자동차/아파트/명품샵. /api/catalog, /api/owned-items, /api/luxury 세 라우터를 함께 관리한다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireGraduatedHighSchool } from "../middleware/socialGate.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import {
  giftLuxuryItem,
  listCatalog,
  listOwnedItems,
  purchaseItem,
  setDisplayed,
} from "../social/catalog.js";

function guard(router: Router) {
  router.use(requireAuth);
  router.use(requireGraduatedHighSchool);
}

export const catalogRouter = Router();
guard(catalogRouter);

catalogRouter.get("/", (req, res) => {
  res.json(listCatalog(req.query.category as string | undefined));
});

catalogRouter.get("/owned", (req, res) => {
  res.json(listOwnedItems(req.userId!));
});

catalogRouter.post("/:itemId/purchase", (req, res) => {
  try {
    res.json(purchaseItem(req.userId!, Number(req.params.itemId)));
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
