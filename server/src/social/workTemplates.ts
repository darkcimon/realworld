// 직업별 "계산형" 근무 문제 템플릿. 숫자는 매번 무작위로 바뀌지만 정답은 서버가 직접 계산하므로 항상 정확하다
// (근무 정답률이 일급/인사평가에 반영되기 때문에 정답이 틀리면 안 되는 문제는 LLM에게 맡기지 않는다).
// 오답 보기는 "실제로 자주 하는 실수"(할증 빼먹기, 부가세 역산을 10% 빼기로 착각 등)로 만든다.
// 상황 판단형 문제는 workQuestions.ts가 LLM 문제 풀에서 섞어 넣는다.
import type { ExamQuestion } from "../ai/AIProvider.js";

type Gen = () => Omit<ExamQuestion, "questionNo">;

const rint = (min: number, max: number, step = 1) => min + step * Math.floor(Math.random() * (Math.floor((max - min) / step) + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

/** 정답 + 실수 보기(중복/음수/정답과 같은 값은 빼고, 모자라면 근처 값으로 채움) 4개. */
function numChoices(answer: number, mistakes: number[], fmt: (n: number) => string, step: number, signed: boolean): string[] {
  const out = [answer];
  for (const m of [...mistakes, answer + step, answer - step, answer + 2 * step, answer - 2 * step, answer + 3 * step]) {
    if (out.length >= 4) break;
    if ((signed || m >= 0) && Number.isFinite(m) && !out.includes(m)) out.push(m);
  }
  return out.map(fmt);
}

/** signed: 증감률처럼 음수도 답이 될 수 있는 문제(기본은 금액/개수라 음수 보기를 뺀다). */
function q(
  question: string,
  answer: number,
  mistakes: number[],
  fmt: (n: number) => string,
  step: number,
  explanation: string,
  signed = false
) {
  return { question, answer: fmt(answer), choices: numChoices(answer, mistakes, fmt, step, signed), explanation };
}

// ── 날짜/시각(문자열 정답) ────────────────────────────────────────────
function dateStr(d: Date) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function randomDate() {
  return new Date(2026, rint(0, 11), rint(1, 28));
}
function dateQ(question: string, base: Date, days: number, explanation: string) {
  const ans = addDays(base, days);
  const choices = [ans, addDays(ans, -1), addDays(ans, 1), addDays(ans, -7)].map(dateStr);
  return { question, answer: dateStr(ans), choices, explanation };
}
function hm(total: number) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h}시 ${String(m).padStart(2, "0")}분`;
}
function timeQ(question: string, startMin: number, plus: number, explanation: string) {
  const ans = startMin + plus;
  const choices = [ans, ans - 30, ans + 30, ans + 60].map(hm);
  return { question, answer: hm(ans), choices, explanation };
}

// ── 직업별 템플릿 ────────────────────────────────────────────────────
const CONVENIENCE: Gen[] = [
  () => {
    const items = [rint(1200, 4800, 100), rint(900, 3500, 100), rint(1500, 6000, 100)];
    const total = items.reduce((a, b) => a + b, 0);
    const paid = total > 10000 ? 50000 : 10000;
    return q(
      `손님이 ${items.map(won).join(", ")}짜리 상품을 계산하고 ${won(paid)}을 냈습니다. 거스름돈은?`,
      paid - total,
      [paid - total + 1000, paid - total - 100],
      won,
      100,
      `합계 ${won(total)}, ${won(paid)} - ${won(total)} = ${won(paid - total)}`
    );
  },
  () => {
    const price = rint(1200, 2800, 100);
    const n = rint(3, 7);
    const pay = Math.ceil(n / 2);
    return q(
      `1+1 행사 중인 ${won(price)}짜리 음료를 손님이 ${n}개 가져왔습니다. 받아야 할 금액은?`,
      price * pay,
      [price * n, price * Math.floor(n / 2)],
      won,
      price,
      `1+1은 2개에 1개 값입니다. ${n}개면 ${pay}개 값을 받아 ${won(price)} × ${pay} = ${won(price * pay)}`
    );
  },
  () => {
    const d = randomDate();
    const days = pick([3, 5, 7, 10]);
    return dateQ(
      `${dateStr(d)}에 입고된 샌드위치의 소비기한이 입고일 포함 ${days}일입니다. 판매할 수 있는 마지막 날은?`,
      d,
      days - 1,
      `입고일을 1일째로 세면 ${days}일째는 ${dateStr(addDays(d, days - 1))}입니다.`
    );
  },
  () => {
    const box = pick([12, 20, 24]);
    const boxes = rint(3, 8);
    const loose = rint(2, 11);
    const sold = rint(10, box * 2);
    const ans = box * boxes + loose - sold;
    return q(
      `컵라면이 한 박스에 ${box}개씩 ${boxes}박스와 낱개 ${loose}개 있었고 오늘 ${sold}개가 팔렸습니다. 남은 재고는?`,
      ans,
      [box * boxes - sold, box * boxes + loose],
      (n) => `${n}개`,
      1,
      `${box} × ${boxes} + ${loose} - ${sold} = ${ans}개`
    );
  },
  () => {
    const start = rint(100000, 200000, 10000);
    const sales = rint(150000, 450000, 1000);
    const refund = rint(3000, 20000, 500);
    const ans = start + sales - refund;
    return q(
      `마감 시재 점검: 시작 시재 ${won(start)}, 현금 매출 ${won(sales)}, 현금 환불 ${won(refund)}. 금고에 있어야 할 현금은?`,
      ans,
      [start + sales + refund, sales - refund],
      won,
      1000,
      `시작 시재 + 현금 매출 - 환불 = ${won(ans)}`
    );
  },
  () => {
    const wage = rint(10100, 11000, 100);
    const night = rint(2, 4);
    const day = rint(3, 5);
    const ans = wage * day + Math.round(wage * 1.5) * night;
    return q(
      `시급 ${won(wage)}, 저녁 ${22 - day}시부터 ${(22 + night) % 24 || 24}시까지 근무했습니다. 22시 이후 야간근로는 1.5배일 때 오늘 일급은?`,
      ans,
      [wage * (day + night), wage * day + wage * 2 * night],
      won,
      wage,
      `주간 ${day}시간 × ${won(wage)} + 야간 ${night}시간 × ${won(Math.round(wage * 1.5))} = ${won(ans)}`
    );
  },
];

const DELIVERY: Gen[] = [
  () => {
    const speed = pick([24, 30, 36]);
    const minutes = pick([10, 20, 30, 40]); // 거리가 항상 정수 km가 되는 조합
    const km = (speed * minutes) / 60;
    return q(
      `목적지까지 ${km}km, 평균 시속 ${speed}km로 달리면 몇 분 걸릴까요?`,
      minutes,
      [Math.round((km / speed) * 100), minutes + 5],
      (n) => `${n}분`,
      5,
      `${km}km ÷ 시속 ${speed}km × 60 = ${minutes}분`
    );
  },
  () => {
    const km = rint(3, 8);
    const night = Math.random() < 0.5;
    const ans = 3000 + (km - 2) * 500 + (night ? 1000 : 0);
    return q(
      `배달비 규정: 기본 3,000원(2km까지), 2km 초과 시 1km당 500원${night ? ", 밤 10시 이후 할증 1,000원" : ""}. ${night ? "밤 11시에 " : ""}${km}km 배달의 배달비는?`,
      ans,
      [3000 + km * 500 + (night ? 1000 : 0), 3000 + (km - 2) * 500 + (night ? 0 : 1000)],
      won,
      500,
      `3,000 + (${km} - 2) × 500${night ? " + 1,000(할증)" : ""} = ${won(ans)}`
    );
  },
  () => {
    const per = rint(3500, 5000, 100);
    const n = rint(15, 30);
    const fuel = rint(8000, 20000, 1000);
    const ans = per * n - fuel;
    return q(
      `오늘 ${n}건 배달했고 건당 수입은 ${won(per)}, 기름값은 ${won(fuel)} 들었습니다. 순수입은?`,
      ans,
      [per * n, per * n + fuel],
      won,
      1000,
      `${won(per)} × ${n} - ${won(fuel)} = ${won(ans)}`
    );
  },
  () => {
    const start = rint(11 * 60, 20 * 60, 5);
    const ride = pick([12, 18, 25, 35, 40]);
    return timeQ(`${hm(start)}에 가게에서 출발해 ${ride}분 걸리는 곳에 배달합니다. 도착 예정 시각은?`, start, ride, `${hm(start)} + ${ride}분 = ${hm(start + ride)}`);
  },
  () => {
    const goal = rint(100000, 200000, 10000);
    const per = pick([3500, 4000, 4500, 5000]);
    const ans = Math.ceil(goal / per);
    return q(
      `오늘 목표 수입은 ${won(goal)}이고 건당 ${won(per)}을 받습니다. 목표를 채우려면 최소 몇 건?`,
      ans,
      [Math.floor(goal / per), ans + 2],
      (n) => `${n}건`,
      1,
      `${won(goal)} ÷ ${won(per)} = ${(goal / per).toFixed(1)} → 올림해서 ${ans}건`
    );
  },
];

const OFFICE: Gen[] = [
  () => {
    const supply = rint(120000, 980000, 10000);
    return q(
      `공급가액 ${won(supply)}짜리 세금계산서를 발행합니다. 부가세(10%)는?`,
      supply / 10,
      [supply / 100, Math.round(supply / 11)],
      won,
      1000,
      `공급가액 × 10% = ${won(supply / 10)}`
    );
  },
  () => {
    const supply = rint(50000, 900000, 10000);
    const total = (supply * 11) / 10; // supply * 1.1은 부동소수 오차가 난다
    return q(
      `부가세 포함 합계 ${won(total)}인 영수증의 공급가액은?`,
      supply,
      [Math.round(total * 0.9), Math.round(total / 1.2)],
      won,
      1000,
      `합계 ÷ 1.1 = ${won(supply)} (합계에서 10%를 빼는 것이 아닙니다)`
    );
  },
  () => {
    const start = rint(9 * 60, 16 * 60, 30);
    const len = pick([45, 60, 90, 120]);
    return timeQ(`${hm(start)}에 시작하는 회의가 ${len}분 동안 진행됩니다. 끝나는 시각은?`, start, len, `${hm(start)} + ${len}분 = ${hm(start + len)}`);
  },
  () => {
    const copies = rint(10, 40);
    const pages = rint(5, 15);
    const sheets = copies * Math.ceil(pages / 2);
    return q(
      `${pages}쪽짜리 회의 자료를 양면으로 ${copies}부 복사합니다. 필요한 종이는 몇 장?`,
      sheets,
      [copies * pages, copies * Math.floor(pages / 2)],
      (n) => `${n}장`,
      copies,
      `한 부에 ${Math.ceil(pages / 2)}장(양면, 홀수 쪽은 올림) × ${copies}부 = ${sheets}장`
    );
  },
  () => {
    const nights = rint(1, 3);
    const hotel = rint(70000, 120000, 5000);
    const train = rint(40000, 60000, 1000);
    const per = 30000;
    const ans = train * 2 + hotel * nights + per * (nights + 1);
    return q(
      `출장비 정산: KTX 편도 ${won(train)}(왕복), 숙박 1박 ${won(hotel)} × ${nights}박, 일비 하루 ${won(per)} × ${nights + 1}일. 총액은?`,
      ans,
      [train + hotel * nights + per * (nights + 1), train * 2 + hotel * nights + per * nights],
      won,
      10000,
      `왕복 ${won(train * 2)} + 숙박 ${won(hotel * nights)} + 일비 ${won(per * (nights + 1))} = ${won(ans)}`
    );
  },
];

const CORPORATE: Gen[] = [
  () => {
    const prev = rint(20, 80, 5) * 10;
    const rate = pick([-20, -10, -5, 5, 10, 15, 20, 25, 30]);
    const cur = prev + (prev * rate) / 100;
    return q(
      `작년 매출 ${prev}억 원, 올해 매출 ${cur}억 원입니다. 전년 대비 증감률은?`,
      rate,
      [Math.round(((cur - prev) / cur) * 100), -rate],
      (n) => `${n > 0 ? "+" : ""}${n}%`,
      5,
      `(${cur} - ${prev}) ÷ ${prev} × 100 = ${rate}% (기준은 작년 값)`,
      true
    );
  },
  () => {
    const target = rint(40, 120, 10) * 10;
    const pct = pick([80, 90, 95, 105, 110, 120]);
    const actual = (target * pct) / 100;
    return q(
      `이번 분기 목표 ${target}억 원, 실적 ${actual}억 원입니다. 목표 달성률은?`,
      pct,
      [Math.round((target / actual) * 100), pct - 100],
      (n) => `${n}%`,
      5,
      `실적 ÷ 목표 × 100 = ${actual} ÷ ${target} × 100 = ${pct}%`
    );
  },
  () => {
    const usd = rint(20, 90, 5) * 100;
    const fx = rint(1300, 1450, 10);
    return q(
      `해외 거래처에 ${usd.toLocaleString()}달러를 송금합니다. 환율 1달러 = ${won(fx)}일 때 원화 금액은?`,
      usd * fx,
      [usd * fx * 10, Math.round(usd * (fx + 10))],
      won,
      100000,
      `${usd.toLocaleString()} × ${fx.toLocaleString()} = ${won(usd * fx)}`
    );
  },
  () => {
    const budget = rint(5, 20) * 1000;
    const pct = pick([15, 20, 25, 30, 35, 40]);
    return q(
      `팀 예산 ${budget.toLocaleString()}만 원 중 ${pct}%를 마케팅에 배정합니다. 마케팅 예산은?`,
      (budget * pct) / 100,
      [budget - (budget * pct) / 100, (budget * pct) / 10],
      (n) => `${n.toLocaleString()}만 원`,
      100,
      `${budget.toLocaleString()} × ${pct}% = ${((budget * pct) / 100).toLocaleString()}만 원`
    );
  },
  () => {
    const qs = [rint(30, 90), rint(30, 90), rint(30, 90)];
    const sum = qs.reduce((a, b) => a + b, 0);
    const fix = sum % 3;
    qs[2] -= fix; // 평균이 정수가 되게
    const avg = (sum - fix) / 3;
    return q(
      `1~3분기 매출이 각각 ${qs.join("억, ")}억 원입니다. 분기 평균 매출은?`,
      avg,
      [sum - fix, Math.round((qs[0] + qs[2]) / 2)],
      (n) => `${n}억 원`,
      1,
      `(${qs.join(" + ")}) ÷ 3 = ${avg}억 원`
    );
  },
];

const PROFESSIONAL: Gen[] = [
  () => {
    const kg = rint(40, 90);
    const dose = pick([5, 10, 15]);
    return q(
      `체중 ${kg}kg 환자에게 ${dose}mg/kg 용량으로 약을 투여합니다. 총 투여량은?`,
      kg * dose,
      [kg * dose * 10, kg + dose],
      (n) => `${n}mg`,
      dose * 5,
      `${kg}kg × ${dose}mg/kg = ${kg * dose}mg`
    );
  },
  () => {
    const hours = pick([4, 5, 8, 10, 12]);
    const rate = pick([50, 60, 80, 100, 125]);
    return q(
      `수액 ${rate * hours}mL를 ${hours}시간 동안 일정하게 주입합니다. 시간당 주입 속도는?`,
      rate,
      [rate * 2, Math.round((rate * hours) / 60)],
      (n) => `${n}mL/h`,
      10,
      `${rate * hours}mL ÷ ${hours}시간 = ${rate}mL/h`
    );
  },
  () => {
    const principal = rint(10, 90) * 1000000;
    const years = rint(1, 4);
    const ans = (principal * 5 * years) / 100;
    return q(
      `대여금 ${won(principal)}에 대해 연 5%(단리)의 지연이자를 ${years}년 치 청구합니다. 이자는?`,
      ans,
      [(principal * 5) / 100, Math.round(principal * (1.05 ** years - 1))],
      won,
      100000,
      `${won(principal)} × 5% × ${years}년 = ${won(ans)} (단리)`
    );
  },
  () => {
    const d = randomDate();
    return dateQ(
      `판결문을 ${dateStr(d)}에 송달받았습니다. 항소기간이 송달일로부터 2주(초일 불산입)일 때 항소장 제출 마지막 날은? (공휴일 없음)`,
      d,
      14,
      `초일은 빼고 다음 날부터 14일째인 ${dateStr(addDays(d, 14))}까지입니다.`
    );
  },
  () => {
    const claim = rint(5, 50) * 10000000;
    const start = rint(3, 11) * 1000000;
    const pct = pick([5, 10, 15]);
    const ans = start + (claim * pct) / 100;
    return q(
      `착수금 ${won(start)}, 성공보수는 승소가액의 ${pct}%입니다. ${won(claim)}을 승소했다면 총 수임료는?`,
      ans,
      [(claim * pct) / 100, start + (claim * pct) / 1000],
      won,
      1000000,
      `${won(start)} + ${won(claim)} × ${pct}% = ${won(ans)}`
    );
  },
];

const BY_JOB: Record<string, Gen[]> = {
  "편의점 매니저": CONVENIENCE,
  "배달 기사": DELIVERY,
  "사무 보조": OFFICE,
  "대기업 사원": CORPORATE,
  "전문직(변호사/의사)": PROFESSIONAL,
};

/** 이 직업의 계산형 문제 n개(같은 템플릿이 연달아 나오지 않게 섞어서). 템플릿이 없는 직업이면 null. */
export function templateQuestions(jobName: string, n: number): Omit<ExamQuestion, "questionNo">[] | null {
  const gens = BY_JOB[jobName];
  if (!gens) return null;
  const order = [...gens].sort(() => Math.random() - 0.5);
  return Array.from({ length: n }, (_, i) => order[i % order.length]());
}
