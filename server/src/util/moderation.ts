// README 4.6: 학교 내 금지 행위(욕설, 음담패설) 감지.
// 실제 서비스라면 정교한 분류기가 필요하지만, Phase 1에서는 키워드 기반 스텁으로
// "위반 감지 → 경고 누적 → 3차 감옥행" 파이프라인 자체를 검증하는 데 집중한다.
const BANNED_KEYWORDS = [
  "씨발",
  "개새끼",
  "병신",
  "지랄",
  "섹스",
  "야동",
];

export function detectViolation(content: string): string | null {
  const normalized = content.replace(/\s+/g, "");
  for (const word of BANNED_KEYWORDS) {
    if (normalized.includes(word)) return word;
  }
  return null;
}
