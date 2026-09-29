// AI 선생님 / 승급 시험 출제를 담당하는 인터페이스.
// Phase 1은 MockAIProvider(캔드 문제은행)로 구현하고, 추후 실제 LLM(Claude API 등)으로
// 교체할 때 이 인터페이스만 만족시키면 되도록 분리해둔다.
export interface ExamQuestion {
  questionNo: number; // 1~10
  question: string;
  answer: string; // 정답 판정 기준(느슨한 문자열 비교)
  explanation: string; // 왜 이 답이 정답인지 — 오답 시 학생에게 보여준다.
  choices?: string[]; // 정해진 보기(없으면 choices.ts가 정답에서 만들어낸다)
  choiceOnly?: boolean; // 보기 중에서만 답할 수 있는 문제(상황 판단형 — 서술형 입력으로는 맞히기 어렵다)
}

// ── 근무 상황 판단 문제(LLM 생성 → 다른 호출로 검증) ───────────────────
export interface WorkScenario {
  question: string;
  choices: string[]; // 4개
  answerIndex: number; // 0~3
  explanation: string;
}

export interface WorkJobContext {
  jobName: string;
  company: string;
}

export interface StudentUtterance {
  nickname: string;
  content: string;
}

// 대화가 길어질수록 매번 전체 히스토리를 프롬프트에 다 실으면 컨텍스트가 계속 커진다.
// summary는 오래된 대화를 압축한 요약(없으면 null), recentHistory는 그 요약 이후 ~ 이번에
// 새로 답할 학생 발화(utterances) 이전까지의 최근 원문 대화(시간순)다. nickname은 speaker가
// 'student'일 때만 의미 있다 — 단체 수업(여러 학생)에서 누가 말했는지 구분하기 위함이고,
// 개인 수업(1:1)에서는 굳이 채우지 않아도 된다.
export interface ConversationTurn {
  speaker: "student" | "teacher";
  nickname?: string;
  content: string;
}

export interface ConversationMemory {
  summary: string | null;
  recentHistory: ConversationTurn[];
}

// 개인 수업의 그리기 명령 하나. 좌표(x/y/x1/y1/x2/y2/w/h/r)는 모두 0~100 사이의 상대값이다 —
// 클라이언트가 실제 canvas 픽셀 크기에 맞춰 스케일하므로, 화면 크기가 달라도 항상 같은 비율로
// 그려진다. color/size/width/fill은 선택값이며 없으면 클라이언트가 기본값을 쓴다.
export type BoardCommand =
  | { type: "clear" }
  | { type: "text"; x: number; y: number; text: string; size?: number; color?: string }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; color?: string; fill?: boolean }
  | { type: "circle"; x: number; y: number; r: number; color?: string; fill?: boolean }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number; color?: string };

export interface LessonStart {
  topic: string;
  message: string;
  board: BoardCommand[];
}

export interface LessonReply {
  message: string;
  /** 칠판을 바꿀 필요가 없으면 생략 — 클라이언트/서버 모두 이전 칠판 상태를 그대로 유지한다. */
  board?: BoardCommand[];
}

// ── 직장 동료 NPC(LLM 자유 대화) ────────────────────────────────────
// NPC는 대사와 함께 "하고 싶은 행동"을 제안할 뿐이고, 실제 반영 여부와 크기는 서버
// (social/workplace.ts)가 economy.ts WORKPLACE 상한 안에서 결정한다.
export interface ColleagueProfile {
  name: string;
  title: string; // 직함(사장/대리/과장…)
  company: string;
  persona: string; // 성격·말투·관심사
  relation: string; // 플레이어와의 관계(직속 상사/사수/윗선…)
}

export interface ColleagueChatTurn {
  speaker: "player" | "npc";
  content: string;
}

export interface ColleagueContext {
  colleague: ColleagueProfile;
  player: { nickname: string; rankTitle: string; jobName: string };
  trust: number; // 0~100, 이 동료가 플레이어를 얼마나 믿는지
  workSummary: string; // 이번 평가 기간 근무 기록 요약(서버가 계산한 사실)
  memory: string | null; // 지금까지의 관계/대화 요약
  hearsay: string[]; // 다른 동료에게 전해 들은 플레이어 이야기(사내 소문/보고)
  recentHistory: ColleagueChatTurn[];
  message: string; // 이번 플레이어 발화
  // 지금 쓸 수 있는 권한. reportTo: 윗선 보고를 받을 바로 위 상사 이름(보고 불가면 null)
  allowed: { praise: boolean; warning: boolean; evalAdjustMax: number; bonusMax: number; reportTo: string | null };
}

export type ColleagueAction =
  | { type: "none" }
  | { type: "praise" | "warning"; reason: string }
  | { type: "eval_adjust" | "bonus" | "report"; value: number; reason: string };

export interface ColleagueTurn {
  reply: string;
  action: ColleagueAction;
  trustDelta: number;
}

export interface AIProvider {
  /**
   * 단체 수업(학년 채팅방)에서 다룰 학습 주제를 고른다 (README 4.2.4: AI 선정 또는 참여자
   * 의견 반영). recentMessages는 이 방에서 최근에 오간 학생 발화(있다면)로, 실제 LLM
   * 구현체가 학생들의 관심사/의견을 반영해 후보 주제 중 하나를 고르거나 살짝 변형하는 데
   * 참고한다. avoidTopics는 이 방에서 최근에 이미 다룬 주제로, 같은 주제가 매번 반복
   * 선정되는 걸 막기 위해 후보에서 제외하도록 힌트를 준다.
   */
  pickDiscussionTopic(
    schoolLevel: string,
    grade: number,
    recentMessages: StudentUtterance[],
    avoidTopics?: string[]
  ): Promise<string>;

  /**
   * 단체 수업에서 학생들의 발화 묶음(일정 시간 조용해질 때까지 쌓인 메시지들)에 대한
   * AI 선생님의 응답을 생성한다. 다인원 채팅에서 메시지마다 매번 응답하지 않고, 잠잠해진
   * 시점에 그 사이 오간 대화를 한 번에 읽고 반영하기 위함이다.
   */
  teacherReplyToBatch(
    topic: string,
    utterances: StudentUtterance[],
    schoolLevel: string,
    grade: number,
    memory?: ConversationMemory | null
  ): Promise<string>;

  /**
   * 단체 수업의 요약 이후 쌓인 원문 대화(turns)를 이전 요약(previousSummary, 없으면 null)과
   * 합쳐 하나의 새 요약으로 압축한다. school/roomMemory.ts가 원문 대화가 일정량 넘게 쌓일
   * 때마다 호출해서, 이후 teacherReplyToBatch에 매번 실어보내는 컨텍스트 크기를 일정하게
   * 유지한다.
   */
  summarizeConversation(
    schoolLevel: string,
    grade: number,
    topic: string,
    previousSummary: string | null,
    turns: ConversationTurn[]
  ): Promise<string>;

  /**
   * 학생 개인별 1:1 수업을 시작한다 — 이 학년 커리큘럼 범위 안에서 오늘 다룰 주제를
   * 하나 고르고, 짧은 도입 설명을 만든다.
   * avoidTopics는 이 학생에게 최근에 이미 다룬 주제로, 반복 선정을 피하기 위한 힌트다.
   */
  startLesson(
    schoolLevel: string,
    grade: number,
    avoidTopics?: string[]
  ): Promise<LessonStart>;

  /**
   * 개인 수업 중 학생의 질문/발언에 답한다.
   * currentBoard는 지금 칠판에 그려진 내용으로, 이어서 그리거나 지우고 새로 그릴 때 참고한다.
   */
  answerLessonQuestion(
    topic: string,
    schoolLevel: string,
    grade: number,
    question: string,
    memory: ConversationMemory | null,
    currentBoard: BoardCommand[]
  ): Promise<LessonReply>;

  /** 승급 시험 10문제를 생성한다 (README 4.3). */
  getExamQuestions(schoolLevel: string, grade: number): ExamQuestion[];

  /** 학교급(초/중/고)별 배치고사 10문제를 생성한다. 8문제 이상 맞히면 해당 학교급을 한 번에 졸업한다. */
  getPlacementQuestions(schoolLevel: string): ExamQuestion[];

  /**
   * Phase 2 근무(README 6.1~6.2) 중 출제할 5문제를 생성한다.
   * 승급 시험과 마찬가지로 같은 AIProvider 추상화를 재사용하되, 학년과 무관한
   * 업무 상식/간단 연산 문제은행에서 뽑는다.
   */
  getWorkQuestions(): ExamQuestion[];

  /**
   * NPC(점장/상사)의 대사를 말투만 바꿔 다시 쓴다. 판단·금액·수치는 서버 규칙이 이미 정했고
   * baseLine이 그 결과를 담고 있으므로, 구현체는 baseLine의 의미와 숫자를 그대로 유지한 채 표현만
   * 바꿔야 한다. 호출 실패/예산 초과/키 없음이면 baseLine을 그대로 돌려준다(게임 진행에 영향 없음).
   */
  npcLine(npc: "manager" | "boss", situation: string, baseLine: string): Promise<string>;

  /**
   * 직장 동료 NPC가 플레이어 발화에 답한다. 반환한 action/trustDelta는 "제안"이며 서버가 상한으로
   * 다시 자른다. 호출 실패/예산 초과/키 없음이면 규칙 기반 응답(행동 없음)을 돌려준다.
   */
  colleagueReply(ctx: ColleagueContext): Promise<ColleagueTurn>;

  /** 직장 동료와의 오래된 대화를 이전 기억과 합쳐 짧은 관계 요약으로 압축한다. */
  summarizeColleagueMemory(
    colleague: ColleagueProfile,
    previousSummary: string | null,
    turns: ColleagueChatTurn[]
  ): Promise<string>;

  /**
   * 이 직업 현장에서 일어날 법한 상황 판단 4지선다 문제를 만든다(계산 문제 제외). 실패/예산 초과/키 없음이면 [].
   * 정답이 확실한지는 호출부가 solveWorkScenarios로 따로 풀어 보고 일치하는 것만 쓴다.
   */
  generateWorkScenarios(job: WorkJobContext, count: number, avoid: string[]): Promise<WorkScenario[]>;

  /** 문제들을 독립적으로 풀어 고른 보기 번호(0~3)를 돌려준다. 확신이 없거나 실패하면 null. */
  solveWorkScenarios(job: WorkJobContext, items: { question: string; choices: string[] }[]): Promise<(number | null)[]>;

  /** 제출한 답이 정답인지 판정한다. */
  gradeAnswer(question: ExamQuestion, submittedAnswer: string): boolean;
}
