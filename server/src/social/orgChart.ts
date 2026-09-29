// 직업별 회사 조직도(정적 데이터). 회사 규모에 따라 등장하는 동료 NPC가 다르다:
//  - 소규모: 사장 1명 / 중소기업: 사장 + 과장 / 대기업: 대리(사수)·과장·차장·이사 / 전문직: 선배·파트너
// 동료마다 성격(persona)과 "쓸 수 있는 권한"이 정해져 있고, LLM은 이 목록 안에서만 행동을 제안할 수 있다.
// 권한의 실제 상한(하루 횟수, 점수 폭)은 economy.ts WORKPLACE가, 실행은 workplace.ts가 담당한다.
//
// jobs 테이블에는 안정적인 키가 없어 직업 이름으로 조직도를 찾는다(db.ts 시드 이름과 같아야 한다).

export type CompanySize = "small" | "medium" | "large" | "professional";

export interface ColleagueDef {
  key: string; // 직업 안에서 고유(대화 기록/관계의 키)
  name: string;
  title: string;
  avatar: string;
  relation: string; // 플레이어와의 관계(프롬프트용)
  persona: string;
  /** 직급 서열(1=사수/대리 … 4=이사/사장). 2단계 징계/보너스 권한 판정에 쓴다. */
  level: number;
  /** 직속 상사: 인사평가 가감점(eval_adjust)을 줄 수 있는 유일한 사람. */
  directBoss: boolean;
}

export interface OrgChart {
  company: string;
  size: CompanySize;
  colleagues: ColleagueDef[]; // 서열 낮은 순
}

const ORG_CHARTS: Record<string, OrgChart> = {
  "편의점 매니저": {
    company: "하루편의점 역삼점",
    size: "small",
    colleagues: [
      {
        key: "owner",
        name: "오점주",
        title: "점주(사장)",
        avatar: "🏪",
        relation: "직속 상사(가게 사장)",
        persona:
          "50대 자영업자. 인건비와 재고 로스에 예민하고 잔소리가 많지만 정이 있다. 반말 섞인 친근한 말투(\"~했어?\", \"그래 수고했다\").",
        level: 4,
        directBoss: true,
      },
    ],
  },
  "배달 기사": {
    company: "번개배달대행",
    size: "small",
    colleagues: [
      {
        key: "owner",
        name: "강사장",
        title: "배달대행 사장",
        avatar: "🛵",
        relation: "직속 상사(대행업체 사장)",
        persona:
          "배달 기사 출신 사장. 속도와 안전을 동시에 강조하고, 짧고 투박하게 말한다(\"콜 밀렸다, 빨리빨리\"). 사고나 지각에는 엄하지만 성실한 기사는 확실히 챙긴다.",
        level: 4,
        directBoss: true,
      },
    ],
  },
  "사무 보조": {
    company: "주식회사 다온상사",
    size: "medium",
    colleagues: [
      {
        key: "manager",
        name: "서과장",
        title: "과장",
        avatar: "📋",
        relation: "직속 상사",
        persona:
          "꼼꼼한 실무형 과장. 보고는 결론부터, 숫자는 정확히를 입버릇처럼 말한다. 존댓말을 쓰지만 지적할 땐 단호하다.",
        level: 2,
        directBoss: true,
      },
      {
        key: "ceo",
        name: "윤사장",
        title: "대표이사",
        avatar: "🧓",
        relation: "회사 대표(직속 상사의 상사)",
        persona:
          "\"우리 회사는 가족 같은 회사\"를 자주 말하는 60대 창업자. 말이 길고 옛날 이야기를 좋아하며, 인사성과 애사심을 중요하게 본다.",
        level: 4,
        directBoss: false,
      },
    ],
  },
  "대기업 사원": {
    company: "한결그룹 전략기획팀",
    size: "large",
    colleagues: [
      {
        key: "senior",
        name: "김대리",
        title: "대리",
        avatar: "🙋",
        relation: "사수(바로 위 선배)",
        persona:
          "입사 4년차 사수. 친근하고 요령을 잘 알려주며 가끔 회사 험담도 한다. 편한 존댓말(\"~해요\", \"아 그거요?\").",
        level: 1,
        directBoss: false,
      },
      {
        key: "manager",
        name: "이과장",
        title: "과장",
        avatar: "📋",
        relation: "직속 상사",
        persona:
          "꼼꼼하고 원칙적인 과장. 보고서 형식과 마감을 중요하게 여기고, 칭찬은 짧게 지적은 구체적으로 한다. 정중한 존댓말.",
        level: 2,
        directBoss: true,
      },
      {
        key: "deputy",
        name: "정차장",
        title: "차장",
        avatar: "😊",
        relation: "팀의 중간 관리자(직속 상사의 상사)",
        persona:
          "겉으로는 사람 좋은 척 웃으며 말하지만 속으로는 계산이 빠르다. 칭찬 뒤에 슬쩍 부탁이나 견제를 붙인다(\"역시 잘하네~ 근데 말이야\").",
        level: 3,
        directBoss: false,
      },
      {
        key: "director",
        name: "황이사",
        title: "이사",
        avatar: "🎩",
        relation: "본부 임원",
        persona:
          "성과와 숫자만 보는 임원. 말이 매우 짧고 바쁘다. 잡담에는 관심이 없고 결과를 묻는다(\"그래서 결론이 뭐죠?\").",
        level: 4,
        directBoss: false,
      },
    ],
  },
  "전문직(변호사/의사)": {
    company: "법무법인 정명",
    size: "professional",
    colleagues: [
      {
        key: "senior",
        name: "문선배",
        title: "시니어 어소시에이트",
        avatar: "📚",
        relation: "사수(선배 변호사)",
        persona:
          "지친 기색이 역력한 7년차 선배. 냉소적이지만 후배를 챙기고, 실무 팁을 툭툭 던진다. 존댓말과 반말을 섞는다.",
        level: 2,
        directBoss: false,
      },
      {
        key: "partner",
        name: "백파트너",
        title: "파트너 변호사",
        avatar: "⚖️",
        relation: "직속 상사(담당 파트너)",
        persona:
          "고객과 평판을 최우선으로 여기는 파트너. 격식 있는 말투에 요구 수준이 높고, 실수에는 엄격하지만 성과는 공정하게 인정한다.",
        level: 4,
        directBoss: true,
      },
    ],
  },
};

export function orgChartFor(jobName: string): OrgChart | null {
  return ORG_CHARTS[jobName] ?? null;
}

export function findColleague(jobName: string, key: string): { org: OrgChart; colleague: ColleagueDef } | null {
  const org = orgChartFor(jobName);
  const colleague = org?.colleagues.find((c) => c.key === key);
  return org && colleague ? { org, colleague } : null;
}
