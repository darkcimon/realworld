// README 11.2: 위치 & 주변 사람 찾기. /api/location, /api/nearby 두 라우터를 함께 관리한다.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { listNearby, updateGpsLocation, updateManualLocation } from "../social/location.js";
import { checkLatLng } from "../util/validate.js";

function guard(router: Router) {
  router.use(requireAuth);
  router.use(requireNotJailed);
}

export const locationRouter = Router();
guard(locationRouter);

locationRouter.put("/", (req, res) => {
  try {
    const { lat, lng } = checkLatLng(req.body?.lat, req.body?.lng);
    res.json(updateGpsLocation(req.userId!, lat, lng));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

locationRouter.put("/manual", (req, res) => {
  try {
    const { lat, lng } = checkLatLng(req.body?.lat, req.body?.lng);
    res.json(updateManualLocation(req.userId!, lat, lng));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

export const nearbyRouter = Router();
guard(nearbyRouter);

nearbyRouter.get("/", (req, res) => {
  try {
    res.json(listNearby(req.userId!));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});
