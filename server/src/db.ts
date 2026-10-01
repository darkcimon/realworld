// Phase 1 데이터 저장소.
// node:sqlite(실험적 기능)를 사용해 별도 네이티브 빌드 도구 없이 Windows에서도 바로 동작하게 한다.
// Phase 2 이후 필요하면 Postgres 등으로 교체 가능하도록 이 파일만 바꾸면 되게 접근을 한곳에 모은다.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 배포 환경(Railway 등)에서는 컨테이너 파일시스템이 재배포 때 초기화되므로
// DB_PATH로 영구 볼륨 안의 경로(예: /data/data.sqlite)를 지정한다.
const dbPath = process.env.DB_PATH ?? path.join(__dirname, "..", "data.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password_hash TEXT,
  nickname TEXT NOT NULL,
  avatar_url TEXT,
  is_guest INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_profile (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  school_level TEXT NOT NULL DEFAULT 'elementary',
  grade INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'enrolled',
  elementary_tier TEXT,
  middle_tier TEXT,
  high_tier TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_level TEXT NOT NULL,
  grade INTEGER NOT NULL,
  order_index INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  current_topic TEXT,      -- 지금 진행 중인 학습 주제(세션 시작 시 1회 결정, 같은 세션 내내 유지)
  topic_set_at TEXT
);

-- 실제 LLM(Gemini/Claude) 호출 비용 누적치. 월 예산 상한을 넘으면 AI 선생님이 실제 호출을
-- 건너뛰고 고정 답변(MockAIProvider)으로만 동작하게 하기 위한 기록이다(ai/GeminiAIProvider.ts,
-- ai/ClaudeAIProvider.ts 참고). period는 'YYYY-MM' 형식이라 달이 바뀌면 자동으로 새로 시작된다.
CREATE TABLE IF NOT EXISTS ai_usage (
  period TEXT PRIMARY KEY,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 이 방에서 지금까지 다룬 학습 주제 이력. AI가 주제를 새로 고를 때 최근 주제를 피하게 해서
-- (README 4.2 개선) "받침 없는 낱말 읽기" 같은 특정 주제만 계속 반복되는 걸 막는 데 쓴다.
CREATE TABLE IF NOT EXISTS room_topic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  topic TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai', -- 'ai' | 'vote'
  set_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_participation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  exam_eligible INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  sender_type TEXT NOT NULL, -- 'user' | 'ai_teacher' | 'system'
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  context TEXT NOT NULL, -- 'school' | 'jail'
  reason TEXT NOT NULL,
  level INTEGER NOT NULL, -- 이 위반이 발생한 시점의 누적 차수
  consumed_at TEXT, -- 감옥/독방행으로 이어져 카운터가 리셋된 시각
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jail_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- 'jail' | 'solitary'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS exam_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  question_no INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  correct INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exam_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  correct_count INTEGER NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  decision TEXT, -- 'advance' | 'stay' | null(미결정)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 배치고사(학교급별 10문항, 8개 이상 정답 시 해당 학교급 졸업장 + 고정 보상)
CREATE TABLE IF NOT EXISTS placement_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  school_level TEXT NOT NULL,
  question_no INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  correct INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS placement_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  school_level TEXT NOT NULL,
  correct_count INTEGER NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 리텐션: 출석 / 일일 퀘스트 / 알림 ─────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL, -- KST 기준 YYYY-MM-DD
  streak INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS quest_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL, -- KST 기준 YYYY-MM-DD
  quest_key TEXT NOT NULL,
  reward INTEGER NOT NULL,
  UNIQUE (user_id, date, quest_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- 'lottery' | 'salary' | 'heart' | 'match'
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── NPC(점장) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS npc_state (
  user_id INTEGER NOT NULL REFERENCES users(id),
  npc TEXT NOT NULL, -- 'manager'
  trust INTEGER NOT NULL DEFAULT 50, -- 0~100
  warnings INTEGER NOT NULL DEFAULT 0, -- 연속 경고 횟수(칭찬받으면 0으로 리셋)
  gain_date TEXT,
  gain_today INTEGER NOT NULL DEFAULT 0,
  task_kind TEXT, -- 진행 중인 특별 근무('rush') 또는 NULL
  task_remaining INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, npc)
);

CREATE TABLE IF NOT EXISTS npc_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  npc TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  choices TEXT NOT NULL, -- 제시된 선택지 키 목록(JSON). 서버는 이 목록 안의 키만 받아들인다.
  shift_id INTEGER,
  resolved INTEGER NOT NULL DEFAULT 0,
  choice_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 직장 상사: 직업(job)별 직급/평가 상태
CREATE TABLE IF NOT EXISTS boss_state (
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  rank INTEGER NOT NULL DEFAULT 1, -- 1=사원 ... 4=부장
  good_streak INTEGER NOT NULL DEFAULT 0, -- S/A 평가 연속 횟수
  bad_streak INTEGER NOT NULL DEFAULT 0, -- C 평가 연속 횟수
  attitude INTEGER NOT NULL DEFAULT 0, -- 면담 태도 점수(다음 평가에 1회 반영)
  last_review_date TEXT NOT NULL, -- KST 기준 YYYY-MM-DD (이 날짜부터의 근무가 다음 평가 대상)
  PRIMARY KEY (user_id, job_id)
);

-- NPC 랜덤 이벤트: 하루 1회 판정 기록 / 이벤트 선택으로 걸리는 임시 효과(modifier)
CREATE TABLE IF NOT EXISTS npc_event_rolls (
  user_id INTEGER NOT NULL REFERENCES users(id),
  npc TEXT NOT NULL,
  date TEXT NOT NULL, -- KST 기준 YYYY-MM-DD
  PRIMARY KEY (user_id, npc, date)
);

CREATE TABLE IF NOT EXISTS npc_modifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, -- 'wage_scale' | 'penalty_scale' (알바 거래에 곱해지는 배수)
  remaining INTEGER NOT NULL, -- 앞으로 적용될 거래 건수
  value REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS jail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jail_session_id INTEGER NOT NULL REFERENCES jail_sessions(id),
  user_id INTEGER REFERENCES users(id),
  sender_type TEXT NOT NULL, -- 'user' | 'system'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graduations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  school_level TEXT NOT NULL,
  average_score REAL NOT NULL,
  tier TEXT NOT NULL,
  graduated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 2: 지갑/원장 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- '자산판매' | '장보기' | '주유' | '일급' | '알바정산' | '알바오차차감' | '로또구매' | '로또당첨' | '매너초기화' | '승진축하금' | '직장보너스' …
  amount INTEGER NOT NULL, -- +(지급)/-(차감)
  ref_id INTEGER,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 2: 직업/근무 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tier TEXT NOT NULL, -- 'S'(S등급 졸업생 전용) | 'all'
  pay_min INTEGER NOT NULL,
  pay_max INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS work_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  correct_count INTEGER NOT NULL DEFAULT 0,
  awaiting_decision INTEGER NOT NULL DEFAULT 0, -- 5문제 배치 완료 후 잔업/퇴근 선택 대기 중
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  paid INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES work_sessions(id),
  batch_no INTEGER NOT NULL,
  question_no INTEGER NOT NULL, -- 배치 내 1~5
  question TEXT NOT NULL,
  answer TEXT,
  correct INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 2: 알바 — 마트 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mart_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  per_minute_wage INTEGER NOT NULL,
  penalty_total INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mart_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES mart_shifts(id),
  correct_amount INTEGER NOT NULL,
  entered_amount INTEGER NOT NULL,
  error_amount INTEGER NOT NULL,
  penalty INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 2: 로또 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lottery_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  round_date TEXT NOT NULL, -- 회차 키: "YYYY-MM-DD HH:00"(KST 추첨 시각). 예전 하루 1회 시절 회차는 "YYYY-MM-DD"
  amount INTEGER NOT NULL, -- 게임머니(원)
  slot INTEGER NOT NULL, -- 해당 유저의 그 회차 몇 번째 구매인지(1~3)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lottery_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_date TEXT NOT NULL UNIQUE,
  participant_count INTEGER,
  tier1_min INTEGER,
  tier1_max INTEGER,
  drawn_at TEXT
);

CREATE TABLE IF NOT EXISTS lottery_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES lottery_rounds(id),
  ticket_id INTEGER NOT NULL REFERENCES lottery_tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  tier TEXT NOT NULL, -- '1' | '2' | '3' | '4' | '낙첨'
  prize_amount INTEGER NOT NULL DEFAULT 0
);

-- ── Phase 2: 매너 / 사회인 감옥 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS manner_scores (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 100,
  clean_check INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manner_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  delta INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 3: 자산 카탈로그(자동차/아파트/명품) ──────────────────────
CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL, -- 'car' | 'apartment' | 'luxury'
  brand TEXT, -- 명품 브랜드(현재 품목은 브랜드 없음, NULL)
  name TEXT NOT NULL,
  price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owned_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id),
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  displayed INTEGER NOT NULL DEFAULT 0
);

-- ── 마을 이동: 체력 / 연료 (economy.ts VITALS) ─────────────────────
CREATE TABLE IF NOT EXISTS user_vitals (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  stamina INTEGER NOT NULL,
  stamina_at INTEGER NOT NULL, -- 자연 회복 계산 기준 시각(epoch ms)
  fuel INTEGER NOT NULL, -- 남은 연료(칸). 차가 있을 때만 쓰임
  location TEXT, -- 마을에서 마지막으로 도착한 시설(연료를 이동한 칸 수만큼 빼기 위해 서버가 기억)
  slept_at INTEGER -- 마지막으로 내 집에서 잔 시각(epoch ms)
);

-- 아파트·명품 되팔기 시세(economy.ts ASSET_RESALE). 시세 구간(하루 4회)마다 품목별 배수를 처음 조회할 때 정해 저장한다.
CREATE TABLE IF NOT EXISTS market_prices (
  slot_key TEXT NOT NULL, -- "YYYY-MM-DD HH:00"(KST, 시세가 바뀐 시각)
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id),
  multiplier REAL NOT NULL,
  PRIMARY KEY (slot_key, catalog_item_id)
);

-- ── Phase 3: 프로필 사진첩 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photo_album_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 3: 위치 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_locations (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  source TEXT NOT NULL, -- 'gps' | 'manual'
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_manual_change_at TEXT
);

-- ── Phase 3: 프로필 열람권 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_view_passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_id INTEGER NOT NULL REFERENCES users(id),
  target_id INTEGER NOT NULL REFERENCES users(id),
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- ── Phase 3: 선물 / 하트 / 맞하트 / 차단 ────────────────────────────
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  item_ref INTEGER REFERENCES catalog_items(id), -- NULL이면 게임머니 선물
  amount INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hearts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  matched_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  blocked_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ── Phase 4: 개인 수업(1:1) + 칠판(Blackboard) ─────────────────────
-- README 4.2: 방(교실) 전체가 아니라 학생 개인별로 주제/칠판이 분리된 1:1 수업 세션.
-- last_board는 마지막으로 그려진 칠판 상태를 JSON 배열 문자열로 들고 있어, 새로고침 후에도
-- (GET /api/lesson/sessions/:id/state) 칠판을 복원할 수 있게 한다.
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  topic TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  last_board TEXT
);

CREATE TABLE IF NOT EXISTS lesson_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES lesson_sessions(id),
  sender_type TEXT NOT NULL, -- 'student' | 'ai_teacher'
  content TEXT NOT NULL,
  board TEXT, -- 이 발화 시점에 칠판이 바뀌었으면 그 새 상태(JSON), 안 바뀌었으면 NULL
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 이 학생에게 최근에 이미 다룬 개인 수업 주제 이력. room_topic_log(단체 토론방용)와 동일한
-- 목적이지만, 개인 수업은 방이 아니라 학생 단위로 반복을 피해야 해서 별도 테이블을 둔다.
CREATE TABLE IF NOT EXISTS lesson_topic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  school_level TEXT NOT NULL,
  grade INTEGER NOT NULL,
  topic TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 3: 1:1 채팅(맞하트/열람권으로 열린 채팅의 실제 메시지) ──────
-- Phase3.md에는 "채팅 개시 허용" 게이트(POST /api/chat/request)까지만 정의돼 있고
-- 실제 메시지를 주고받는 저장소는 없었다. 게이트만 있고 대화가 안 되면 기능이 죽어
-- 있는 것과 같아서, 학교 채팅(chat_messages)과 동일한 패턴으로 메시지 테이블을 추가한다.
CREATE TABLE IF NOT EXISTS social_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// rooms.current_topic/topic_set_at는 나중에 추가된 컬럼이라, 이미 만들어져 있던 기존 DB
// 파일에는 CREATE TABLE IF NOT EXISTS로 새로 안 생긴다 — 없으면 직접 추가해준다.
const roomColumns = db.prepare("PRAGMA table_info(rooms)").all() as { name: string }[];
if (!roomColumns.some((c) => c.name === "current_topic")) {
  db.exec("ALTER TABLE rooms ADD COLUMN current_topic TEXT");
}
if (!roomColumns.some((c) => c.name === "topic_set_at")) {
  db.exec("ALTER TABLE rooms ADD COLUMN topic_set_at TEXT");
}
// 대화가 길어질수록 AI 프롬프트에 매번 전체 히스토리를 다 실어보내면 컨텍스트가 계속 커진다.
// conversation_summary(오래된 대화를 압축한 요약)와 summary_through_id(어디까지 요약에
// 반영됐는지)를 둬서, 그 이후(=아직 요약 안 된) 메시지만 원문으로 들고 있으면 되게 한다
// (school/roomMemory.ts 참고).
if (!roomColumns.some((c) => c.name === "conversation_summary")) {
  db.exec("ALTER TABLE rooms ADD COLUMN conversation_summary TEXT");
}
if (!roomColumns.some((c) => c.name === "summary_through_id")) {
  db.exec("ALTER TABLE rooms ADD COLUMN summary_through_id INTEGER NOT NULL DEFAULT 0");
}

// 마을 이동: 연료를 이동 거리(칸)로 계산하려고 현재 위치를 서버에 둔다.
const vitalsColumns = db.prepare("PRAGMA table_info(user_vitals)").all() as { name: string }[];
if (!vitalsColumns.some((c) => c.name === "location")) {
  db.exec("ALTER TABLE user_vitals ADD COLUMN location TEXT");
}
// 집에 도착하면 연료를 조금 채워 준다(쿨타임 기준 시각, epoch ms).
if (!vitalsColumns.some((c) => c.name === "home_refuel_at")) {
  db.exec("ALTER TABLE user_vitals ADD COLUMN home_refuel_at INTEGER");
}
// 운행할 차 선택(owned_items.id). 없거나 팔았으면 가장 비싼 차를 탄다.
if (!vitalsColumns.some((c) => c.name === "active_car_id")) {
  db.exec("ALTER TABLE user_vitals ADD COLUMN active_car_id INTEGER");
}
// 박스집 요리(리듬게임) 쿨타임 기준 시각(epoch ms).
if (!vitalsColumns.some((c) => c.name === "cooked_at")) {
  db.exec("ALTER TABLE user_vitals ADD COLUMN cooked_at INTEGER");
}

// 자산 되팔기: 아파트·명품은 시세대로 사므로 실제로 낸 금액을 따로 기록한다(예전 행은 NULL = 정가).
const ownedItemColumns = db.prepare("PRAGMA table_info(owned_items)").all() as { name: string }[];
if (!ownedItemColumns.some((c) => c.name === "paid_price")) {
  db.exec("ALTER TABLE owned_items ADD COLUMN paid_price INTEGER");
}
// 차마다 따로 남은 연료(칸). NULL이면 아직 한 번도 안 탄 차 — 처음 탈 때 정해진다(social/vitals.ts).
if (!ownedItemColumns.some((c) => c.name === "fuel")) {
  db.exec("ALTER TABLE owned_items ADD COLUMN fuel INTEGER");
}

// 마트 알바: 손님 카트(정답 금액)를 서버가 발급/보관해 클라이언트가 정답을 조작하지 못하게 한다.
const martShiftColumns = db.prepare("PRAGMA table_info(mart_shifts)").all() as { name: string }[];
if (!martShiftColumns.some((c) => c.name === "pending_cart")) {
  db.exec("ALTER TABLE mart_shifts ADD COLUMN pending_cart TEXT");
}

// 마트 알바: 근무 중 실제로 지급한 분급 합계(점장 신뢰도 배수/특별 근무로 거래마다 시급이 달라진다).
if (!martShiftColumns.some((c) => c.name === "wage_total")) {
  db.exec("ALTER TABLE mart_shifts ADD COLUMN wage_total INTEGER NOT NULL DEFAULT 0");
}

// 마트 알바 스피드 보너스: 지금 손님 카트를 낸 시각(ms). 계산 속도는 서버가 이 값으로 잰다.
if (!martShiftColumns.some((c) => c.name === "cart_issued_at")) {
  db.exec("ALTER TABLE mart_shifts ADD COLUMN cart_issued_at INTEGER");
}

// 직장 상사 "긴급 프로젝트": 이번 평가 기간에 달성해야 할 잔업 배치 수(0이면 없음).
const bossStateColumns = db.prepare("PRAGMA table_info(boss_state)").all() as { name: string }[];
if (!bossStateColumns.some((c) => c.name === "project_goal")) {
  db.exec("ALTER TABLE boss_state ADD COLUMN project_goal INTEGER NOT NULL DEFAULT 0");
}

// 직장 동료 대화로 쌓인 평가 가감점(다음 주간 평가에 1회 반영, 상한은 economy.ts WORKPLACE).
if (!bossStateColumns.some((c) => c.name === "colleague_adjust")) {
  db.exec("ALTER TABLE boss_state ADD COLUMN colleague_adjust INTEGER NOT NULL DEFAULT 0");
}

// ── 직장 동료 NPC(LLM 자유 대화) ─────────────────────────────────────
// 관계(신뢰도)와 기억(대화 요약)은 직업(job_id)별 — 회사를 옮기면 새 동료들과 새로 시작한다.
db.exec(`
CREATE TABLE IF NOT EXISTS colleague_relations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  colleague_key TEXT NOT NULL,
  trust INTEGER NOT NULL DEFAULT 50,
  memory TEXT, -- 오래된 대화를 압축한 요약(없으면 NULL)
  summary_through_id INTEGER NOT NULL DEFAULT 0, -- 어디까지 요약에 반영됐는지(colleague_messages.id)
  PRIMARY KEY (user_id, job_id, colleague_key)
);
CREATE TABLE IF NOT EXISTS colleague_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  colleague_key TEXT NOT NULL,
  sender TEXT NOT NULL, -- 'player' | 'npc'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_colleague_messages ON colleague_messages (user_id, job_id, colleague_key, id);
-- NPC가 실행한 권한(칭찬/경고/평가 가감점/보너스). 징계 사다리(감봉/정직/강등/해고)의 근거 기록이 된다.
CREATE TABLE IF NOT EXISTS colleague_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  colleague_key TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'praise' | 'warning' | 'eval_adjust' | 'bonus' | 'report' | 'defense'
  value INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 동료가 먼저 건 말(업무 지시/징계 통보)을 "안 읽음"으로 보여주기 위한 읽음 위치.
const colleagueRelColumns = db.prepare("PRAGMA table_info(colleague_relations)").all() as { name: string }[];
if (!colleagueRelColumns.some((c) => c.name === "last_read_id")) {
  db.exec("ALTER TABLE colleague_relations ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0");
}

// 진행 중인 근무 배치(문제+정답)를 세션에 저장한다. 문제가 매번 무작위로 만들어지므로, 서버가 재시작돼도
// 유저가 보고 있던 바로 그 문제로 채점해야 한다(메모리 캐시만 믿으면 다른 문제로 채점될 수 있다).
const workSessionColumns = db.prepare("PRAGMA table_info(work_sessions)").all() as { name: string }[];
if (!workSessionColumns.some((c) => c.name === "pending_batch")) {
  db.exec("ALTER TABLE work_sessions ADD COLUMN pending_batch TEXT");
}

// ── 직장 2단계: 업무 지시 / 징계 ─────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS work_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  colleague_key TEXT NOT NULL, -- 지시한 사람
  kind TEXT NOT NULL, -- 'attempts' | 'accuracy' | 'overtime'
  goal INTEGER NOT NULL,
  accuracy REAL NOT NULL DEFAULT 0, -- kind='accuracy'일 때 목표 정답률(0~1)
  issued_at TEXT NOT NULL DEFAULT (datetime('now')), -- 이 시각 이후 근무 기록만 센다
  due_date TEXT NOT NULL, -- KST YYYY-MM-DD, 이 날까지
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done' | 'failed' | 'cancelled'
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_tasks_user ON work_tasks (user_id, status);
CREATE TABLE IF NOT EXISTS workplace_state (
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  discipline_level INTEGER NOT NULL DEFAULT 0, -- 0 정상, 1 감봉, 2 정직, 3 강등, 4 해고
  discipline_through_id INTEGER NOT NULL DEFAULT 0, -- 이 colleague_actions.id까지는 이미 징계에 반영됨
  last_discipline_date TEXT, -- 마지막으로 단계가 바뀐 날(KST)
  pay_cut_until TEXT, -- 이 날짜(포함)까지 감봉
  suspended_until TEXT, -- 이 날짜(포함)까지 정직
  PRIMARY KEY (user_id, job_id)
);
CREATE TABLE IF NOT EXISTS workplace_disciplines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  colleague_key TEXT NOT NULL, -- 통보한 사람
  stage INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 사내 소문(3단계): 동료 A의 행동/보고를 누가 전해 들었는지. audience는 ",manager,deputy," 형태.
CREATE TABLE IF NOT EXISTS colleague_hearsay (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  source_key TEXT NOT NULL, -- 소문의 출처(행동하거나 보고한 동료)
  audience TEXT NOT NULL,
  content TEXT NOT NULL,
  tone INTEGER NOT NULL DEFAULT 0, -- 플레이어에게 좋은 소식 +1 / 나쁜 소식 -1
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_colleague_hearsay ON colleague_hearsay (user_id, job_id, id);
-- 근무 상황 판단 문제 풀: 직업별로 LLM이 만들고 다른 호출이 똑같이 풀어낸 문제만 저장한다.
-- 유저마다 LLM을 부르지 않고 여기서 꺼내 쓰며, uses가 쌓이면 지우고 새로 채운다(workQuestions.ts).
CREATE TABLE IF NOT EXISTS work_question_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  question TEXT NOT NULL,
  choices TEXT NOT NULL, -- JSON 배열(4개)
  answer TEXT NOT NULL, -- 정답 보기 텍스트
  explanation TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_question_pool ON work_question_pool (job_id, uses);
CREATE TABLE IF NOT EXISTS job_bans (
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  until TEXT NOT NULL, -- KST YYYY-MM-DD(포함)까지 재입사 불가
  PRIMARY KEY (user_id, job_id)
);
`);

// NPC 이벤트에 근거 자료(평가 점수 세부 등)를 함께 저장해 선택지 답변이 상황에 맞게 나오게 한다.
const npcEventColumns = db.prepare("PRAGMA table_info(npc_events)").all() as { name: string }[];
if (!npcEventColumns.some((c) => c.name === "meta")) {
  db.exec("ALTER TABLE npc_events ADD COLUMN meta TEXT");
}

// 3D 캐릭터 꾸미기 설정(JSON, social/character.ts가 검증). 유저당 1행.
db.exec(`
CREATE TABLE IF NOT EXISTS user_characters (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 마지막 접속 시각(토큰 자동 연장 때 갱신, 하루 1회 정도). 오래 버려진 비회원 정리 기준이다.
// 컬럼을 처음 만들 때는 기존 유저 모두 "지금"으로 채워 정리 유예 기간을 처음부터 다시 준다.
const userColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userColumns.some((c) => c.name === "last_seen_at")) {
  db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
  db.exec("UPDATE users SET last_seen_at = datetime('now')");
}

// 졸업 기록은 학교급당 1건(재응시하면 최근 결과로 갱신). 예전에는 졸업할 때마다 행이 쌓여 프로필에
// "초졸S 초졸A …"처럼 중복 표시됐으므로 학교급별 가장 최근 행만 남기고 유니크 인덱스를 건다.
db.exec(`
DELETE FROM graduations WHERE id NOT IN (
  SELECT MAX(id) FROM graduations GROUP BY user_id, school_level
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_graduations_user_level ON graduations(user_id, school_level);
`);
// 고졸 후 낮은 학년 시험을 다시 보고 승급을 누르면 학교급이 뒤로 돌아가던 버그로 망가진 프로필 복구:
// 졸업생은 고등학교 졸업으로, 재학생은 최소한 "가장 높은 졸업 학교급의 다음 학교급"으로 되돌린다.
db.exec(`
UPDATE student_profile SET school_level = 'high', grade = 3
  WHERE status = 'graduated' AND school_level <> 'high';
UPDATE student_profile SET school_level = 'high', grade = 1
  WHERE status <> 'graduated' AND school_level IN ('elementary', 'middle')
    AND EXISTS (SELECT 1 FROM graduations g WHERE g.user_id = student_profile.user_id AND g.school_level = 'middle');
UPDATE student_profile SET school_level = 'middle', grade = 1
  WHERE status <> 'graduated' AND school_level = 'elementary'
    AND EXISTS (SELECT 1 FROM graduations g WHERE g.user_id = student_profile.user_id AND g.school_level = 'elementary');
`);

/** 학교급 졸업 기록을 남기거나, 이미 있으면 가장 최근 응시 결과로 갱신한다. */
export function recordGraduation(userId: number, schoolLevel: string, averageScore: number, tier: string): void {
  db.prepare(
    `INSERT INTO graduations (user_id, school_level, average_score, tier) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, school_level) DO UPDATE SET
       average_score = excluded.average_score, tier = excluded.tier, graduated_at = datetime('now')`
  ).run(userId, schoolLevel, averageScore, tier);
}

// 12개 학년 방 시드 데이터 (초1~초6, 중1~3, 고1~3) — README 4.1
const roomCount = db.prepare("SELECT COUNT(*) AS c FROM rooms").get() as { c: number };
if (roomCount.c === 0) {
  const insert = db.prepare(
    "INSERT INTO rooms (school_level, grade, order_index, label) VALUES (?, ?, ?, ?)"
  );
  let order = 0;
  for (let g = 1; g <= 6; g++) insert.run("elementary", g, order++, `초등학교 ${g}학년`);
  for (let g = 1; g <= 3; g++) insert.run("middle", g, order++, `중학교 ${g}학년`);
  for (let g = 1; g <= 3; g++) insert.run("high", g, order++, `고등학교 ${g}학년`);
}

export function roomOrderIndex(schoolLevel: string, grade: number): number {
  const row = db
    .prepare("SELECT order_index FROM rooms WHERE school_level = ? AND grade = ?")
    .get(schoolLevel, grade) as { order_index: number } | undefined;
  if (!row) throw new Error(`unknown room ${schoolLevel} ${grade}`);
  return row.order_index;
}

/** 이 방에서 최근에 다룬 주제 목록(최신순, 최대 limit개) — 주제를 새로 고를 때 반복을 피하는 데 쓴다. */
export function recentTopics(roomId: number, limit = 3): string[] {
  const rows = db
    .prepare("SELECT topic FROM room_topic_log WHERE room_id = ? ORDER BY id DESC LIMIT ?")
    .all(roomId, limit) as { topic: string }[];
  return rows.map((r) => r.topic);
}

/**
 * 방의 새 주제를 확정하고(rooms.current_topic 갱신) 이력에 남긴다.
 * source가 'ai'인 경우는 school.ts의 join 핸들러가 "아무도 없던 방에 새 세션을 시작"할 때만
 * 쓰는 값이라, 이전 세션의 대화 요약(conversation_summary)을 이어갈 이유가 없다 — 오히려
 * 다음 세션의 첫 AI 응답이 지난 세션 얘기를 섞어 쓰는 걸 막기 위해 여기서 초기화한다.
 * source가 'vote'인 경우는 같은 세션 참여자들이 주제만 바꾼 것이라 요약을 그대로 이어간다.
 */
export function setRoomTopic(roomId: number, topic: string, source: "ai" | "vote"): void {
  if (source === "ai") {
    const maxMsg = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE room_id = ?")
      .get(roomId) as { id: number };
    db.prepare(
      "UPDATE rooms SET current_topic = ?, topic_set_at = datetime('now'), conversation_summary = NULL, summary_through_id = ? WHERE id = ?"
    ).run(topic, maxMsg.id, roomId);
  } else {
    db.prepare("UPDATE rooms SET current_topic = ?, topic_set_at = datetime('now') WHERE id = ?").run(
      topic,
      roomId
    );
  }
  db.prepare("INSERT INTO room_topic_log (room_id, topic, source) VALUES (?, ?, ?)").run(
    roomId,
    topic,
    source
  );
}

function currentAiUsagePeriod(): string {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM' — 자정 넘어 달이 바뀌면 자동으로 새 행이 시작된다.
}

/** 이번 달 지금까지 누적된 실제 LLM 호출 비용(달러). */
export function getMonthlyAiCostUsd(): number {
  const row = db
    .prepare("SELECT cost_usd FROM ai_usage WHERE period = ?")
    .get(currentAiUsagePeriod()) as { cost_usd: number } | undefined;
  return row?.cost_usd ?? 0;
}

/** 방금 발생한 호출 비용(달러)을 이번 달 누적치에 더한다. */
export function addAiCostUsd(deltaUsd: number): void {
  if (!(deltaUsd > 0)) return;
  db.prepare(
    `INSERT INTO ai_usage (period, cost_usd) VALUES (?, ?)
     ON CONFLICT(period) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, updated_at = datetime('now')`
  ).run(currentAiUsagePeriod(), deltaUsd);
}

/** 이 학생에게 최근에 이미 다룬 개인 수업 주제(최신순, 최대 limit개) — 주제 반복 회피용. */
export function recentLessonTopics(
  userId: number,
  schoolLevel: string,
  grade: number,
  limit = 3
): string[] {
  const rows = db
    .prepare(
      "SELECT topic FROM lesson_topic_log WHERE user_id = ? AND school_level = ? AND grade = ? ORDER BY id DESC LIMIT ?"
    )
    .all(userId, schoolLevel, grade, limit) as { topic: string }[];
  return rows.map((r) => r.topic);
}

/** 방금 정해진 개인 수업 주제를 이력에 남긴다. */
export function logLessonTopic(userId: number, schoolLevel: string, grade: number, topic: string): void {
  db.prepare(
    "INSERT INTO lesson_topic_log (user_id, school_level, grade, topic) VALUES (?, ?, ?, ?)"
  ).run(userId, schoolLevel, grade, topic);
}

// 직업 시드 데이터 — README 6.1(직업). 정확한 급여표가 README에 없어
// 등급별로 합리적인 범위를 임의로 정해 시드한다(실제 값은 추후 기획 확정 시 조정).
const jobCount = db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number };
if (jobCount.c === 0) {
  const insert = db.prepare(
    "INSERT INTO jobs (name, tier, pay_min, pay_max) VALUES (?, ?, ?, ?)"
  );
  insert.run("편의점 매니저", "all", 30000, 60000);
  insert.run("사무 보조", "all", 40000, 80000);
  insert.run("배달 기사", "all", 35000, 70000);
  insert.run("대기업 사원", "S", 100000, 200000);
  insert.run("전문직(변호사/의사)", "S", 150000, 300000);
}

// 자산 카탈로그 시드 데이터 — README 8~10장(자동차/아파트/명품샵).
// 정확한 표가 README에 없어 등급별로 합리적인 가격대를 임의로 정해 시드한다.
const catalogCount = db.prepare("SELECT COUNT(*) AS c FROM catalog_items").get() as {
  c: number;
};
if (catalogCount.c === 0) {
  const insert = db.prepare(
    "INSERT INTO catalog_items (category, brand, name, price) VALUES (?, ?, ?, ?)"
  );
  // 자동차
  insert.run("car", null, "경차", 10_000_000);
  insert.run("car", null, "준중형 세단", 30_000_000);
  insert.run("car", null, "스포츠카", 150_000_000);
  insert.run("car", null, "슈퍼카", 500_000_000);
  // 아파트
  insert.run("apartment", null, "원룸", 50_000_000);
  insert.run("apartment", null, "84㎡ 아파트", 300_000_000);
  insert.run("apartment", null, "펜트하우스", 1_000_000_000);
  // 명품(실사 3D 모델이 있는 브랜드 없는 품목 — client/src/components/AssetViewer.tsx의 이름과 같아야 한다)
  insert.run("luxury", null, "명품 선글라스", 3_000_000);
  insert.run("luxury", null, "명품 가죽 소파", 15_000_000);
  insert.run("luxury", null, "명품 시계", 12_000_000);
  insert.run("luxury", null, "명품 운동화", 4_000_000);
  insert.run("luxury", null, "명품 스탠드 조명", 5_000_000);
}

// 명품 라인업 교체(브랜드 가방 5종 → 실사 3D 모델 품목). 이미 시드된 DB는 id/가격을 그대로 두고 이름만 바꿔서
// 유저가 가진 자산(owned_items)과 선물 기록이 그대로 새 품목으로 이어진다. 이미 바뀌었으면 아무 일도 없다.
{
  const rename = db.prepare("UPDATE catalog_items SET brand = NULL, name = ? WHERE category = 'luxury' AND name = ?");
  for (const [from, to] of [
    ["루이비통 가방", "명품 선글라스"],
    ["에르메스 가방", "명품 가죽 소파"],
    ["샤넬 가방", "명품 시계"],
    ["구찌 가방", "명품 운동화"],
    ["디올 가방", "명품 스탠드 조명"],
  ]) {
    rename.run(to, from);
  }
}
