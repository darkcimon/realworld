import type { NextFunction, Request, Response } from "express";
import { getActiveJail } from "../school/jail.js";

/**
 * README 5장: "구금 중에는 감옥(채팅) 외의 다른 콘텐츠에 접근할 수 없음".
 * 감옥/사회 콘텐츠 라우트 전반에 걸어 감옥에 있는 유저를 차단한다.
 */
export function requireNotJailed(req: Request, res: Response, next: NextFunction) {
  if (!req.userId) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return;
  }
  const jail = getActiveJail(req.userId);
  if (jail) {
    res.status(403).json({
      error: "감옥/독방에 구금 중에는 이용할 수 없습니다.",
      jail: { type: jail.type, endsAt: jail.ends_at },
    });
    return;
  }
  next();
}
