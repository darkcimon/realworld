// 리텐션 루프(출석/일일 퀘스트) 보상 수치. 밸런스를 조정할 때는 이 파일만 수정하면 된다.

// 연속 출석 1~7일차 보상(7일차 다음은 다시 1일차로 순환, 하루라도 빠지면 1일차부터 다시 시작).
export const ATTENDANCE_REWARDS = [200_000, 200_000, 300_000, 300_000, 400_000, 500_000, 1_000_000];

export type QuestKey = "lesson_ask" | "exam_try" | "work_batch" | "alba_tx";

// phase: school = 졸업 전 학생에게, adult = 고등학교 졸업 후 사회인에게 보이는 퀘스트.
export const QUESTS: {
  key: QuestKey;
  label: string;
  goal: number;
  reward: number;
  phase: "school" | "adult";
}[] = [
  { key: "lesson_ask", label: "AI 선생님께 질문하기", goal: 1, reward: 100_000, phase: "school" },
  { key: "exam_try", label: "시험(승급/배치고사) 1회 끝까지 응시하기", goal: 1, reward: 100_000, phase: "school" },
  { key: "work_batch", label: "직장 근무 5문제 풀기", goal: 5, reward: 500_000, phase: "adult" },
  { key: "alba_tx", label: "마트 계산 10건 처리하기", goal: 10, reward: 300_000, phase: "adult" },
];

// ── 점장 NPC(마트 알바) ────────────────────────────────────────────────
// 점장은 근무 기록(정확도)을 보고 신뢰도를 올리거나 내리고, 신뢰도 등급에 따라 시급 배수와
// 제안(특별 근무)이 달라진다. 점장이 줄 수 있는 돈/효과의 상한은 전부 여기서 정해지며,
// 서버가 이 범위 안에서만 실행한다(NPC의 판단이 경제를 흔들지 못하게 하는 안전 장치).
export const MANAGER = {
  minTxToEvaluate: 5, // 이 건수 미만의 짧은 근무는 평가하지 않는다(즉시 종료로 신뢰도 파밍 방지)
  minTxForBonus: 10, // 보너스는 10건 이상 근무 + 정확도 90% 이상일 때만
  bonusPerTx: 1_000,
  bonusMax: 30_000, // 하루 1회, 이 금액이 상한
  dailyTrustGainCap: 12, // 하루에 올릴 수 있는 신뢰도 상한(음수 변화는 제한 없음)
  trustedAt: 70, // 이상이면 "믿음직한 직원"
  watchBelow: 30, // 미만이면 "요주의 직원"
  trustedWageMultiplier: 1.2,
  watchWageMultiplier: 0.8,
  rushOfferMinTrust: 50, // 이 이상일 때만 특별 근무를 제안받을 수 있다
  rushTx: 10, // 특별 근무: 다음 10건
  rushWageMultiplier: 2,
};

// ── 직장 상사 NPC(직장 근무) ───────────────────────────────────────────
// 상사는 주 1회 근무 기록으로 평가(S/A/B/C)하고, 좋은 평가가 연속되면 승진 심사를 받을 수 있다.
// 직급은 직업(job)별로 따로 쌓이며, 직급에 따라 일급 배수가 올라간다.
// 직급 보상 상한(승진 축하금, 배수)은 전부 여기서 정해지고 서버가 이 범위 안에서만 실행한다.
export const BOSS = {
  ranks: [
    { title: "사원", payMultiplier: 1 },
    { title: "대리", payMultiplier: 1.15 },
    { title: "과장", payMultiplier: 1.3 },
    { title: "부장", payMultiplier: 1.5 },
  ],
  reviewPeriodDays: 7, // 평가 주기(일)
  minWorkDays: 2, // 평가 기간 중 이 일수 이상 근무해야 평가(미달이면 보류)
  minAttempts: 10, // 평가 기간 중 이 문제 수 이상 풀어야 평가
  gradeS: 90,
  gradeA: 75,
  gradeB: 55, // 미만은 C
  promotionStreak: 2, // 승진 심사: S/A 평가 연속 횟수
  demotionStreak: 3, // C 평가 연속 횟수 → 강등
  promotionBonusPerRank: 100_000, // 승진 축하금 = 이 값 × 새 직급 단계(1부터)
  attitude: { apologize: 5, ask: 3, excuse: -5 }, // 면담 태도가 다음 평가 점수에 더해진다(1회성)
};

// ── NPC 랜덤 이벤트 / NPC 간 평판 ─────────────────────────────────────
// 이벤트는 NPC별로 하루 1회만 판정하고(chance 확률로 발생), 상태(신뢰도/직급)에 맞는 후보 중 하나가 뽑힌다.
// 선택지에는 위험/보상이 함께 있으며, 효과는 전부 아래 상한 안에서 서버가 실행한다.
export const EVENTS = {
  // 하루 1회 판정 시 이벤트가 발생할 확률. 테스트에서는 NPC_EVENT_CHANCE 환경변수로 고정할 수 있다.
  chance: Number(process.env.NPC_EVENT_CHANCE ?? 0.5),
  angryTx: 3, // 진상 손님 대응 "침착하게": 다음 3건
  angryWageScale: 2, // 시급 ×2 (고위험 고보상)
  angryPenaltyScale: 2, // 오차 페널티도 ×2
  stockTx: 2, // 재고 정리를 돕는 동안(다음 2건) 시급 0
  stockTrust: 4,
  stockMinTrust: 40, // 이 이상일 때만 점장이 재고 정리를 부탁한다
  dinnerCost: 50_000, // 회식비(게임머니)
  projectGoal: 2, // 긴급 프로젝트: 이번 평가 기간 잔업 목표(배치 수)
  projectSuccessBonus: 6, // 목표 달성 시 평가 점수 가산
  projectFailPenalty: 4, // 미달성 시 평가 점수 감산
  reputationAdjust: 3, // 점장 신뢰도 ↔ 직장 평가 보정(±)
  rumorMinBossRank: 2, // 직장에서 대리 이상이면 점장이 소문을 듣는다
};

// ── NPC 대사 LLM 말투(4단계) ──────────────────────────────────────────
// 대사 표현만 LLM이 바꾸고 판단/금액은 규칙이 정한다. NPC_VOICE_ENABLED=0이면 항상 원문을 쓴다.
export const NPC_VOICE = {
  enabled: process.env.NPC_VOICE_ENABLED !== "0",
  dailyCallsPerUser: 30, // 유저당 하루 LLM 호출 상한(비용 상한)
  maxLenRatio: 2, // 원문 길이의 2배까지만 허용
  minMaxLen: 80, // 원문이 아주 짧아도 최소 이만큼은 허용
};
