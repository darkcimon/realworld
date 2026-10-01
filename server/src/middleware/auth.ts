import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { db } from "../db.js";

export const JWT_SECRET = process.env.JWT_SECRET ?? "dev-only-secret-change-me";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: number;
    }
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "30d" });
}

// 토큰은 30일짜리지만, 발급된 지 하루가 지난 토큰으로 요청이 오면 새 30일 토큰을 응답 헤더로
// 내려준다(클라이언트 api.ts가 받아서 교체). 그래서 한 달 안에 한 번이라도 들어오는 유저는
// 만료로 계정을 잃지 않는다 — 비회원은 이 토큰이 계정에 접근하는 유일한 열쇠라 특히 중요하다.
// 같은 시점에 마지막 접속 시각도 남긴다(오래 버려진 비회원 정리용, social/guestCleanup.ts).
export const REFRESH_TOKEN_HEADER = "X-Refresh-Token";
const REFRESH_AFTER_SEC = 24 * 60 * 60;

function maybeRefresh(res: Response, payload: { sub: number; iat?: number }) {
  if (!payload.iat || Date.now() / 1000 - payload.iat < REFRESH_AFTER_SEC) return;
  res.setHeader(REFRESH_TOKEN_HEADER, signToken(payload.sub));
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(payload.sub);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number; iat?: number };
    req.userId = payload.sub;
    maybeRefresh(res, payload);
    next();
  } catch {
    res.status(401).json({ error: "유효하지 않은 토큰입니다." });
  }
}
