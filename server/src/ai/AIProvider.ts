// AI 선생님 / 승급 시험 출제를 담당하는 인터페이스.
// Phase 1은 MockAIProvider(캔드 문제은행)로 구현하고, 추후 실제 LLM(Claude API 등)으로
// 교체할 때 이 인터페이스만 만족시키면 되도록 분리해둔다.
export interface ExamQuestion {
  questionNo: number; // 1~10
  question: string;
  answer: string; // 정답 판정 기준(느슨한 문자열 비교)
  explanation: string; // 왜 이 답이 정답인지 — 오답 시 학생에게 보여준다.
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

  /** 제출한 답이 정답인지 판정한다. */
  gradeAnswer(question: ExamQuestion, submittedAnswer: string): boolean;
}
