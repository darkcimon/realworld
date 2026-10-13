// 학력: 학교는 시작 관문이 아니라 언제든 다닐 수 있는 "학력 올리기" 콘텐츠다(README 4장).
// 가장 높은 졸업 학교급이 최종 학력이 되고, 학력이 높을수록 직장 일급 배수가 오른다(economy.ts EDUCATION).
// 고등학교를 S등급으로 졸업하면 S등급 전용 직업도 열린다.
// 졸업한 학교급의 수업을 더 듣거나 시험에 다시 합격하면 배수가 계속 오른다(economy.ts EDUCATION_BOOST).
import { db } from "../db.js";
import { EDUCATION, EDUCATION_BOOST, type EducationLevel } from "../economy.js";

const ORDER: Record<string, number> = { elementary: 1, middle: 2, high: 3 };

export function educationOf(userId: number): {
  level: EducationLevel;
  label: string;
  payMultiplier: number;
  boost: number;
} {
  const rows = db
    .prepare("SELECT school_level FROM graduations WHERE user_id = ?")
    .all(userId) as { school_level: string }[];
  let level: EducationLevel = "none";
  for (const r of rows) {
    if ((ORDER[r.school_level] ?? 0) > (ORDER[level] ?? 0)) level = r.school_level as EducationLevel;
  }
  const boost = educationBoost(userId);
  return { level, label: EDUCATION[level].label, payMultiplier: round2(EDUCATION[level].payMultiplier + boost), boost };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 졸업 후 수업·시험으로 쌓은 추가 일급 배수(학교급별 단위 수 × 단위당 배수). */
function educationBoost(userId: number): number {
  const rows = db
    .prepare("SELECT school_level, SUM(units) AS units FROM education_boosts WHERE user_id = ? GROUP BY school_level")
    .all(userId) as { school_level: string; units: number }[];
  return round2(rows.reduce((sum, r) => sum + (EDUCATION_BOOST.perUnit[r.school_level] ?? 0) * r.units, 0));
}

/**
 * 이미 졸업한 학교급에서 수업을 듣거나 시험에 합격했으면 학력 배수를 적립한다.
 * 아직 졸업 전인 학교급은 적립하지 않는다(졸업장 배수가 그 학교급 공부의 보상이다).
 * 같은 수업 세션/시험 결과(source + refId)는 한 번만 적립된다. 적립된 배수 증가분을 돌려준다.
 */
export function grantEducationBoost(
  userId: number,
  schoolLevel: string,
  source: "lesson" | "exam",
  refId: number,
  units: number
): number {
  if (units <= 0) return 0;
  const graduated = db
    .prepare("SELECT 1 FROM graduations WHERE user_id = ? AND school_level = ?")
    .get(userId, schoolLevel);
  if (!graduated) return 0;
  const r = db
    .prepare(
      "INSERT OR IGNORE INTO education_boosts (user_id, school_level, source, ref_id, units) VALUES (?, ?, ?, ?, ?)"
    )
    .run(userId, schoolLevel, source, refId, units);
  return r.changes ? round2((EDUCATION_BOOST.perUnit[schoolLevel] ?? 0) * units) : 0;
}

/** 고등학교 졸업 등급(S/A/B/C)이 'S'인지 확인한다 — S등급 전용 직업 배정용. */
export function isSTier(userId: number): boolean {
  const row = db
    .prepare("SELECT tier FROM graduations WHERE user_id = ? AND school_level = 'high'")
    .get(userId) as { tier: string } | undefined;
  return row?.tier === "S";
}
