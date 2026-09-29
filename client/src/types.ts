export interface Profile {
  id: number;
  nickname: string;
  avatarUrl: string | null;
  isGuest: boolean;
  email: string | null;
  school: {
    level: "elementary" | "middle" | "high";
    levelLabel: string;
    grade: number;
    status: string;
    label: string;
  };
  graduations: Array<{
    school_level: string;
    average_score: number;
    tier: string;
    graduated_at: string;
  }>;
  displayedItems: { id: number; category: string; brand: string | null; name: string }[];
  jail: { type: "jail" | "solitary"; endsAt: string } | null;
}

export interface RoomSummary {
  id: number;
  schoolLevel: "elementary" | "middle" | "high";
  grade: number;
  label: string;
  unlocked: boolean;
  isCurrent: boolean;
}

export interface ChatMessage {
  id: number;
  roomId?: number;
  senderType: "user" | "ai_teacher" | "system";
  userId?: number | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  content: string;
  created_at?: string;
}

// 채팅에서 프로필 사진 아이콘을 눌렀을 때 보여주는 공개 프로필(README 4.4/11: 트위터 아이콘처럼
// 클릭해서 조회 — PersonDetail(11.3 유료 상세 프로필)과 달리 누구나 무료로 볼 수 있는 정보만 담는다).
export interface PublicProfile {
  id: number;
  nickname: string;
  avatarUrl: string | null;
  isGuest: boolean;
  school: {
    level: "elementary" | "middle" | "high";
    levelLabel: string;
    grade: number;
    status: string;
    label: string;
  } | null;
  graduations: Array<{
    school_level: string;
    average_score: number;
    tier: string;
    graduated_at: string;
  }>;
}

// ── 개인 수업(칠판) ────────────────────────────────────────────────
// 진급은 승급 시험 결과만으로 결정된다 — 수업 참여 자체에는 강의/토론 단계나 최소 시간
// 제한이 없고, 학생은 언제든 승급 시험에 응시할 수 있다.
export type BoardCommand =
  | { type: "clear" }
  | { type: "text"; x: number; y: number; text: string; size?: number; color?: string }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; color?: string; fill?: boolean }
  | { type: "circle"; x: number; y: number; r: number; color?: string; fill?: boolean }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number; color?: string };

export interface LessonMessage {
  id: number;
  senderType: "student" | "ai_teacher";
  content: string;
  board?: BoardCommand[];
}

export interface LessonStartResp {
  sessionId: number;
  topic: string;
  resumed: boolean;
  board: BoardCommand[];
  messages: LessonMessage[];
}

export interface LessonAskResp {
  reply: string;
  board?: BoardCommand[];
}

// ── 승급 시험 ────────────────────────────────────────────────────
export interface ExamWrongAnswer {
  questionNo: number;
  question: string;
  yourAnswer: string;
  correctAnswer: string;
  explanation: string;
}

// ── Phase 2: 지갑/직업/알바/로또/매너 ─────────────────────────────
export interface LedgerEntry {
  id: number;
  type: string;
  amount: number;
  balance_after: number;
  created_at: string;
}

export interface Job {
  id: number;
  name: string;
  tier: "S" | "all";
  pay_min: number;
  pay_max: number;
}

export interface WorkStartResp {
  sessionId: number;
  questionNo: number;
  batchNo: number;
  question: string;
  choices?: string[];
}

export interface WorkAnswerResp {
  correct: boolean;
  questionNo: number;
  batchNo: number;
  batchComplete: boolean;
  nextQuestion?: string;
  nextChoices?: string[];
}

export interface MartCartItem {
  name: string;
  price: number;
}

export interface MartTxResp {
  nextCart: MartCartItem[];
  errorAmount: number;
  penalty: number;
  wagePaid: number;
  wageMultiplier: number;
  rushRemaining: number | null;
  penaltyApplied: number;
  balance: number;
}

export interface LotteryTicket {
  id: number;
  round_date: string;
  amount: number;
  slot: number;
}

export interface LotteryToday {
  roundDate: string;
  tickets: LotteryTicket[];
  remaining: number;
  round: { drawn_at: string | null; tier1_min: number | null; tier1_max: number | null } | null;
}

export interface MannerMe {
  userId: number;
  score: number;
  cleanCheck: boolean;
}

// ── Phase 3: 자산/위치/데이팅 ────────────────────────────────────
export interface CatalogItem {
  id: number;
  category: "car" | "apartment" | "luxury";
  brand: string | null;
  name: string;
  price: number;
}

export interface OwnedItem {
  id: number;
  displayed: boolean;
  purchased_at: string;
  category: "car" | "apartment" | "luxury";
  brand: string | null;
  name: string;
  price: number;
}

export interface NearbyUser {
  userId: number;
  nickname: string;
  avatarUrl: string | null;
  distanceKm: number;
}

export interface PersonDetail {
  id: number;
  nickname: string;
  avatarUrl: string | null;
  photos: { url: string; sort_order: number }[];
  displayedItems: { id: number; category: string; brand: string | null; name: string }[];
}

export interface IncomingHeart {
  senderId: number;
  nickname: string;
  avatarUrl: string | null;
  sentAt: string;
}

export interface MatchSummary {
  userId: number;
  nickname: string;
  avatarUrl: string | null;
  matchedAt: string;
}

export interface DmMessage {
  id: number;
  fromId?: number;
  from_id?: number;
  toId?: number;
  to_id?: number;
  nickname?: string;
  avatarUrl?: string | null;
  content: string;
  createdAt?: string;
  created_at?: string;
}

// ── 배치고사 ─────────────────────────────────────────────────────
export interface PlacementInfo {
  schoolLevel: RoomSummary["schoolLevel"];
  label: string;
  available: boolean;
  reward: number;
  passThreshold: number;
  total: number;
}

// ── 리텐션: 출석 / 일일 퀘스트 / 알림 ─────────────────────────────
export interface DailyQuest {
  key: string;
  label: string;
  goal: number;
  reward: number;
  progress: number;
  claimed: boolean;
  claimable: boolean;
}

export interface DailyStatus {
  date: string;
  attendance: {
    checkedInToday: boolean;
    streak: number;
    nextDay: number;
    nextReward: number;
    rewards: number[];
  };
  quests: DailyQuest[];
  pendingCount: number;
}

export interface AppNotification {
  id: number;
  type: "lottery" | "salary" | "heart" | "match" | "npc";
  message: string;
  read: number;
  created_at: string;
}

export interface NotificationsResp {
  unread: number;
  items: AppNotification[];
}

// ── 점장 NPC ─────────────────────────────────────────────────────
export interface ManagerEvent {
  id: number;
  kind:
    | "praise_bonus"
    | "praise"
    | "neutral"
    | "warn"
    | "interview"
    | "rush_offer"
    | "evt_angry"
    | "evt_stock"
    | "evt_rumor";
  message: string;
  choices: { key: string; label: string }[];
}

export interface ManagerPanelState {
  npc: { name: string; title: string };
  trust: number;
  tier: { key: "trusted" | "normal" | "watch"; label: string; wageMultiplier: number };
  rules: string[];
  greeting: string;
  modifiers: { kind: string; remaining: number; value: number }[];
  event: ManagerEvent | null;
  task: { kind: "rush"; remaining: number; wageMultiplier: number } | null;
}

export interface ManagerChooseResp {
  reply: string;
  trustChange: number;
  next: ManagerEvent | null;
  panel: ManagerPanelState;
}

// ── 직장 상사 NPC ────────────────────────────────────────────────
export interface BossEvent {
  id: number;
  kind:
    | "review_good"
    | "review_ok"
    | "review_bad"
    | "demotion"
    | "deferred"
    | "evt_project"
    | "evt_dinner"
    | "evt_rumor";
  message: string;
  choices: { key: string; label: string }[];
}

export type BossPanelState =
  | { assigned: false }
  | {
      assigned: true;
      job: { id: number; name: string; tier: string };
      npc: { name: string; title: string };
      rank: { level: number; title: string; payMultiplier: number; max: number };
      streaks: { good: number; bad: number };
      review: {
        nextDate: string;
        daysLeft: number;
        periodDays: number;
        progress: {
          attempts: number;
          accuracy: number;
          workDays: number;
          overtime: number;
          projectedScore: number;
          projectedGrade: "S" | "A" | "B" | "C" | null;
        };
      };
      reputation: { managerTrust: number; adjust: number };
      colleagueAdjust: number;
      peers: { avgTrust: number | null; adjust: number };
      project: { goal: number; overtime: number } | null;
      rules: string[];
      greeting: string;
      event: BossEvent | null;
    };

export interface BossChooseResp {
  reply: string;
  promoted: boolean;
  panel: BossPanelState;
}

// ── 직장 동료 NPC(LLM 자유 대화) ──────────────────────────────────
export interface ColleagueAction {
  type: "praise" | "warning" | "eval_adjust" | "bonus" | "report";
  value: number;
  reason: string;
}

export interface ColleagueSummary {
  key: string;
  name: string;
  title: string;
  avatar: string;
  relation: string;
  directBoss: boolean;
  trust: number;
  unread: number;
  records: { praise: number; warning: number };
  lastMessage: { sender: "player" | "npc"; content: string } | null;
}

export interface WorkTask {
  id: number;
  issuer: { key: string; name: string; title: string; avatar: string } | null;
  kind: "attempts" | "accuracy" | "overtime";
  description: string;
  goal: number;
  targetAccuracy: number;
  dueDate: string;
  progress: { attempts: number; accuracy: number; overtime: number };
}

export interface DisciplineStatus {
  level: number;
  label: string;
  netWarnings: number;
  warningsPerStep: number;
  nextLabel: string;
  payCutUntil: string | null;
  suspendedUntil: string | null;
}

export interface OfficeFeedItem {
  id: number;
  from: string;
  avatar: string;
  to: string[];
  content: string;
  tone: number;
  createdAt: string;
}

export type WorkplaceState =
  | { assigned: false; bans: { jobName: string; until: string }[] }
  | {
      assigned: true;
      job: { id: number; name: string };
      company: string;
      size: "small" | "medium" | "large" | "professional";
      colleagues: ColleagueSummary[];
      records: { praise: number; warning: number };
      evalAdjust: { current: number; cap: number };
      task: WorkTask | null;
      feed: OfficeFeedItem[];
      discipline: DisciplineStatus;
      bonusRoomToday: number;
      remainingToday: number;
      dailyLimit: number;
      rules: string[];
    };

export interface ColleagueMessage {
  id: number;
  sender: "player" | "npc";
  content: string;
  created_at: string;
}

export interface ColleagueMessagesResp {
  colleague: { key: string; name: string; title: string; avatar: string };
  trust: number;
  messages: ColleagueMessage[];
}

export interface ColleagueChatResp {
  reply: string;
  action: ColleagueAction | null;
  trust: number;
  violation: { level: number; jailed: boolean } | null;
  disciplined: { stage: number; label: string; by: string; fired: boolean } | null;
  reportedTo: string | null;
  remainingToday: number;
}
