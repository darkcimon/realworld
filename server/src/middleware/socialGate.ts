// Phase 2 사회 진입 게이트: 고등학교 3학년(고등학교 전체 과정) 졸업 여부를 확인해
// README 6장(사회 생활)/7장(로또) 라우트를 잠금 해제한다.
import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";

export function requireGraduatedHighSchool(req: Request, res: Response, next: NextFunction) {
  const profile = db
    .prepare("SELECT status FROM student_profile WHERE user_id = ?")
    .get(req.userId) as { status: string } | undefined;
  if (!profile || profile.status !== "graduated") {
    res.status(403).json({ error: "고등학교 졸업 후 이용할 수 있는 콘텐츠입니다." });
    return;
  }
  next();
}

/** 고3 졸업 시 부여된 등급(S/A/B/C)이 'S'인지 확인한다 — S등급 전용 직업 배정용. */
export function isSTier(userId: number): boolean {
  const row = db
    .prepare("SELECT tier FROM graduations WHERE user_id = ? AND school_level = 'high'")
    .get(userId) as { tier: string } | undefined;
  return row?.tier === "S";
}
