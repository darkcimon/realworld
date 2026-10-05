// 학력: 학교는 시작 관문이 아니라 언제든 다닐 수 있는 "학력 올리기" 콘텐츠다(README 4장).
// 가장 높은 졸업 학교급이 최종 학력이 되고, 학력이 높을수록 직장 일급 배수가 오른다(economy.ts EDUCATION).
// 고등학교를 S등급으로 졸업하면 S등급 전용 직업도 열린다.
import { db } from "../db.js";
import { EDUCATION, type EducationLevel } from "../economy.js";

const ORDER: Record<string, number> = { elementary: 1, middle: 2, high: 3 };

export function educationOf(userId: number): {
  level: EducationLevel;
  label: string;
  payMultiplier: number;
} {
  const rows = db
    .prepare("SELECT school_level FROM graduations WHERE user_id = ?")
    .all(userId) as { school_level: string }[];
  let level: EducationLevel = "none";
  for (const r of rows) {
    if ((ORDER[r.school_level] ?? 0) > (ORDER[level] ?? 0)) level = r.school_level as EducationLevel;
  }
  return { level, ...EDUCATION[level] };
}

/** 고등학교 졸업 등급(S/A/B/C)이 'S'인지 확인한다 — S등급 전용 직업 배정용. */
export function isSTier(userId: number): boolean {
  const row = db
    .prepare("SELECT tier FROM graduations WHERE user_id = ? AND school_level = 'high'")
    .get(userId) as { tier: string } | undefined;
  return row?.tier === "S";
}
