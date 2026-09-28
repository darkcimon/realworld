# Phase 1 — 기반 시스템 & 학교

> 대상 README 섹션: 1(계정 시스템), 2~3(시설/진행 순서), 4(학교 시스템), 5(감옥 시스템)
> 목표: "비회원으로 초등학교 1학년 교실에 들어가 AI 선생님과 대화하고, 10분 채우면 승급 시험을 보고, 규칙을 어기면 감옥에 갇힌다"는 한 사이클이 실제로 동작하는 수직 슬라이스(vertical slice)를 만든다. 사회 진입(6장 이후)은 Phase 2에서 다룬다.

## 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 서버 | Node.js + TypeScript + Express | 팀 규모 대비 학습 비용 낮음, REST+WS 혼용 용이 |
| 실시간 채팅 | Socket.IO | 룸(room) 단위 브로드캐스트가 채팅방/감옥 구조에 그대로 대응 |
| DB | SQLite (better-sqlite3) | 로컬 파일 기반, 별도 서버 설치 없이 Windows에서 바로 동작. Phase 2 이후 필요 시 Postgres로 교체 |
| 프론트 | React + TypeScript + Vite | 빠른 개발 루프, 채팅/모달 UI에 적합 |
| 인증 | JWT + 게임머니/세션은 서버 DB에 귀속 | 비회원(guest) 토큰과 회원 토큰을 같은 미들웨어로 처리 |
| AI 선생님 / 시험 출제 | `AIProvider` 인터페이스 뒤에 `MockAIProvider`(캔드 문제은행) 배치 | 외부 LLM API 키 없이도 전체 플로우 검증 가능. 추후 실제 LLM(Claude API 등) 연동 시 Provider만 교체 |

## 데이터 모델 (SQLite)

- `users`: id, email(nullable, 비회원=null), password_hash(nullable), nickname, avatar_url, is_guest, created_at
- `student_profile`: user_id, school_level(초/중/고), grade(1~6 or 1~3), status(재학/졸업), elementary_grade_tier, middle_grade_tier, high_grade_tier
- `rooms`: id, school_level, grade (초1~고3까지 12개 고정 로우, 시드 데이터)
- `room_participation`: user_id, room_id, joined_at, elapsed_seconds, exam_eligible(bool)
- `chat_messages`: id, room_id, sender_type(user/ai_teacher/system), user_id(nullable), content, created_at
- `violations`: id, user_id, room_id, reason, created_at, level(1~3차)
- `jail_sessions`: id, user_id, type(감옥/독방), started_at, ends_at
- `exam_attempts`: id, user_id, room_id, question_no(1~10), question, answer, correct(bool), created_at
- `graduations`: user_id, school_level, average_score, tier(S/A/B/C), graduated_at

## API (REST)

- `POST /api/auth/guest` — 게스트 세션 발급 (닉네임만 입력)
- `POST /api/auth/register`, `POST /api/auth/login` — 정식 회원 전환/로그인
- `GET /api/profile`, `PATCH /api/profile` (아바타 변경)
- `GET /api/school/rooms` — 12개 방 목록 + 잠금 여부(현재 학년만 해제)
- `POST /api/school/rooms/:roomId/join` — 입장, `room_participation` 시작
- `POST /api/school/rooms/:roomId/leave` — 퇴장 (10분 미만이면 시험 자격 없음으로 종료)
- `POST /api/school/rooms/:roomId/exam/start` — 10분 이상 참여 확인 후 1번 문제 발급
- `POST /api/school/rooms/:roomId/exam/answer` — 정답 판정, 다음 문제 또는 최종 결과(7개 이상 시 승급/유급 선택 UI로 전환)
- `POST /api/school/rooms/:roomId/promote` — `{advance: boolean}`
- `GET /api/school/graduation/:level` — 졸업 시 평균 점수 기반 등급(S/A/B/C) 계산·저장

## WebSocket (Socket.IO)

- `room:{roomId}` 네임스페이스: 입장/퇴장, 메시지 송수신, AI 선생님 발화(주제 선정 결과 또는 참여자 투표 결과 브로드캐스트)
- `jail:{sessionId}` 네임스페이스: 감옥 채팅. 독방은 별도 UI(검은 화면+타이머)로 소켓 메시지 자체를 서버에서 차단

## 핵심 규칙 구현 체크리스트 (README 대응)

- [ ] 비회원 플레이 가능, 저장 시도 시 "계정을 생성해야 저장할 수 있습니다" 안내 (1절)
- [ ] 최초 입장은 초등학교 1학년 방만 가능, 상위 학년 잠금 (3절, 4.1)
- [ ] AI 선생님 주제 선정 또는 참여자 투표 (4.2) — Phase 1에서는 두 방식 모두 스텁으로 구현(투표 UI는 최소 형태)
- [ ] 10분 미만 퇴장 시 시험 자격 없음 (4.3)
- [ ] 승급 시험 10문제 중 7개 이상 → 승급 여부 본인 선택 (4.3)
- [ ] 아바타 등록/변경, 현재 학년 프로필 표시 (4.4)
- [ ] 졸업장 + 등급(S/A/B/C) 산정 (4.5)
- [ ] 욕설/음담패설 금지어 필터 → 경고 2회 → 3차 감옥행 (4.6)
- [ ] 감옥 3시간 구금, 감옥 내 3회 위반 시 독방 1일 (5절)
- [ ] 감옥/독방 중에는 다른 콘텐츠 접근 불가 (5절 — Phase 2 이후 사회 콘텐츠가 생기면 함께 검증)

## 이번 단계에서 하지 않는 것 (Out of scope)

- ~~실제 LLM 연동~~ → AI 선생님의 채팅 응답(`teacherReplyToBatch`)만 실제 Claude API로 연동함(아래
  "구현 현황" 참고). 승급 시험 출제/채점, 근무 문제는 여전히 고정 문제은행(Mock) — 게임 진행이
  LLM의 비결정적 출력에 좌우되지 않도록 의도적으로 유지.
- 사회 진입 이후 콘텐츠(6장 이후) 전체
- 결제/캐시샵, 실시간 다중 서버 배포, 모바일 앱

## 완료 기준 (Acceptance)

1. 게스트로 접속 → 초1 방 입장 → AI 선생님 메시지 수신 → 10분 경과 시뮬레이션 후 시험 응시 → 7문제 이상 정답 시 승급 선택 팝업 → "승급" 선택 시 초2 방 잠금 해제
2. 금지어 3회 발화 시 자동으로 감옥 세션 생성, 감옥 채팅방으로 강제 이동
3. 초등 6학년 졸업 처리 시 평균 점수 기반 등급이 프로필에 표시됨

## 구현 현황

`server/`(Express + Socket.IO + node:sqlite)와 `client/`(React + Vite)로 구현 완료. 아래 항목은 자동화 스크립트로 직접 실행해 검증했다.

- [x] 게스트 가입 → 프로필 조회
- [x] 방 목록 조회(잠금 상태 포함), 초1 입장 시 AI 선생님이 주제 메시지 전송
- [x] 10분 참여 확인(테스트 편의를 위한 `dev/fast-forward` 포함) 후 10문항 시험 → 7문제 이상 시 승급/유급 선택 → 승급 시 다음 방 잠금 해제
- [x] 초1~초6을 연속 승급하며 졸업 처리 시 평균 점수 기반 등급(S/A/B/C) 산정 및 다음 레벨(중1)로 전환
- [x] Socket.IO 채팅에서 금지어 3회 감지 → 감옥행 → 감옥 중 학교 입장(REST/소켓 모두) 403 차단 → 감옥 채팅 정상 동작
- [x] AI 선생님 응답 디바운스: 참여자가 여러 명이라 채팅이 활발할 때 메시지마다 응답하지 않고, **3초간 조용해지면** 그 사이 쌓인 발화를 한 번에 읽고 응답(`teacherReplyToBatch`). 대화가 끊이지 않는 경우를 대비해 **15초 강제 응답(max-wait)** 안전장치도 포함 — 두 시나리오 모두 자동화 스크립트로 타이밍까지 확인
- [ ] 독방행(감옥 내 3회 추가 위반) 로직은 구현했으나 자동화 검증은 아직 안 함(코드 경로는 감옥 위반과 동일 함수 재사용)

### AI 선생님 실제 LLM 연동 (`GeminiAIProvider` / `ClaudeAIProvider`)

`teacherReplyToBatch`가 캔드 응답 대신 실제 LLM을 호출하도록 Provider 두 개를 추가했다
(`AIProvider` 인터페이스만 만족하면 되도록 설계해둔 Phase 1의 원래 의도 그대로 Provider만 교체).

- `server/src/ai/GeminiAIProvider.ts` — Google Gemini API 무료 티어(`gemini-3.7-flash`, 요금 없음).
  `GEMINI_API_KEY`(`server/.env.example` 참고, aistudio.google.com에서 무료 발급)가 있으면
  `ai/index.ts`가 이 Provider를 **기본으로 우선 선택**한다.
- `server/src/ai/ClaudeAIProvider.ts` — Claude API(`claude-opus-5`, 유료). `GEMINI_API_KEY`가 없고
  `ANTHROPIC_API_KEY`만 있을 때만 대신 선택된다.
- [x] 시스템 프롬프트에 "이 방은 OO학년 학급"이라는 고정 컨텍스트를 담아 학년 수준에 맞는 어휘/난이도를 유지(두 Provider 공통)
- [x] 답변마다 학생 발화 묶음 전체(닉네임+내용)를 한 번에 전달하고, 학생에게 되묻는 질문을 포함하도록 지시
- [x] 키가 없거나 API 호출이 실패하면(무료 한도 초과 포함) 예외 없이 MockAIProvider의 캔드 응답으로 자동 대체 — 서버 기동 자체는 키 유무와 무관하게 항상 성공(자동화 스크립트로 "키 없음 → 폴백 → 정상 응답 수신"까지 확인)
- [x] 승급 시험(`getExamQuestions`)/근무 문제(`getWorkQuestions`)/채점(`gradeAnswer`)은 계속 MockAIProvider에 위임 — 채점 신뢰성이 승급/급여 지급에 직결되므로 의도적으로 LLM화하지 않음

### 실행 방법 (로컬)

```bash
# 1) 서버
cd server
npm install
npm run dev        # http://localhost:4000

# 2) 클라이언트 (새 터미널)
cd client
npm install
npm run dev         # http://localhost:5173 (Vite가 /api, /socket.io를 4000으로 프록시)
```

`server/data.sqlite` 파일이 자동 생성되며, 서버를 재시작해도 데이터가 유지된다(초기화하려면 파일 삭제).
