// 내 연령대(서버 /profile의 ageGroup). 미성년자에게는 "연애" 표현 대신 "친구" 표현을 쓴다.
// App이 프로필을 받을 때 정해 두고, 화면은 렌더링할 때 읽기만 한다.
export type AgeGroup = "adult" | "minor" | "unknown";

let current: AgeGroup = "unknown";

export function setAgeGroup(g: AgeGroup) {
  current = g;
}

export function isMinor(): boolean {
  return current === "minor";
}

/** 연령대에 맞는 "인연/친구" 표현 */
export function matchWord(): "인연" | "친구" {
  return isMinor() ? "친구" : "인연";
}
