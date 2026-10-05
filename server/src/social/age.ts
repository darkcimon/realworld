// 이용 연령: 만 14세 이상. 성인(만 19세 이상, 청소년보호법 기준)과 미성년자는 서로 1:1로 만날 수 없다
// (하트·대화·선물·프로필 열람·내 주변 목록 모두 같은 연령대끼리만).
// 나이는 가입할 때 받은 출생 연월(자기 신고)로 정한다. 연령 확인 전에 만든 계정은:
//   예전 "만 18세 이상" 확인을 받았으면 성인으로, 아무 확인도 없으면 "unknown"(다음 접속 때 출생 연월을 묻는다).
import { db } from "../db.js";

export const AGE = { min: 14, adult: 19 };

export type AgeGroup = "adult" | "minor" | "unknown";

/** "YYYY-MM" 검증. 미래·너무 먼 과거는 거부. */
export function parseBirthYm(raw: unknown): { year: number; month: number } {
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})$/.exec(raw) : null;
  const year = m ? Number(m[1]) : NaN;
  const month = m ? Number(m[2]) : NaN;
  const now = new Date();
  if (!m || month < 1 || month > 12 || year < 1900 || year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1)) {
    throw { status: 400, message: "태어난 해와 달을 골라 주세요." };
  }
  return { year, month };
}

/** 만 나이. 일(日)은 받지 않으므로 태어난 달이 지나야 한 살 더한다(보수적으로 생일이 그달 말일이라고 본다). */
export function ageFrom(year: number, month: number, now = new Date()): number {
  const nowMonth = now.getMonth() + 1;
  let age = now.getFullYear() - year;
  if (nowMonth <= month) age -= 1; // 태어난 달이 아직 안 지났거나 그달이면 생일 전으로 본다
  return age;
}

export function ageGroupOf(userId: number): AgeGroup {
  const row = db.prepare("SELECT birth_ym, adult_confirmed_at FROM users WHERE id = ?").get(userId) as
    | { birth_ym: string | null; adult_confirmed_at: string | null }
    | undefined;
  if (!row) return "unknown";
  if (row.birth_ym) {
    const { year, month } = parseBirthYm(row.birth_ym);
    return ageFrom(year, month) >= AGE.adult ? "adult" : "minor";
  }
  return row.adult_confirmed_at ? "adult" : "unknown";
}

/** 가입·연령 입력 공통: 만 14세 미만이면 거부, 아니면 저장할 값과 연령대를 돌려준다. */
export function checkBirthYm(raw: unknown): { birthYm: string; group: "adult" | "minor" } {
  const { year, month } = parseBirthYm(raw);
  const age = ageFrom(year, month);
  if (age < AGE.min) {
    throw { status: 403, code: "underage", message: `만 ${AGE.min}세 이상부터 이용할 수 있어요.` };
  }
  return { birthYm: `${year}-${String(month).padStart(2, "0")}`, group: age >= AGE.adult ? "adult" : "minor" };
}

/** 연령 확인을 아직 안 한 예전 계정이 한 번만 출생 연월을 넣는다(이미 정해졌으면 바꿀 수 없다 — 문의로만). */
export function setBirthYmOnce(userId: number, raw: unknown): AgeGroup {
  if (ageGroupOf(userId) !== "unknown") throw { status: 409, message: "이미 연령 확인을 했어요. 바꾸려면 문의해 주세요." };
  const { birthYm } = checkBirthYm(raw);
  db.prepare("UPDATE users SET birth_ym = ? WHERE id = ?").run(birthYm, userId);
  return ageGroupOf(userId);
}

/** 1:1 상호작용 가능 여부: 둘 다 연령 확인을 했고, 같은 연령대여야 한다. */
export function assertSameAgeGroup(a: number, b: number): void {
  const ga = ageGroupOf(a);
  const gb = ageGroupOf(b);
  if (ga === "unknown") throw { status: 403, code: "age_required", message: "먼저 연령 확인을 해 주세요." };
  if (ga !== gb) throw { status: 403, message: "이 사용자와는 연결할 수 없어요." };
}
