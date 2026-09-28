# Phase 4 — 개인 수업(칠판) 모드

> 대상 README 섹션: 4.2(학습(수업) 진행) 전면 개정 — 개인별 1:1 수업 + 칠판(Blackboard) + 7분 강의/3분 토론
> 전제: Phase 1의 학교 인프라(방/입장/승급 시험/감옥)가 이미 존재. 4.2.4(단체 토론방)는 기존 구현을 그대로 두고 손대지 않는다.
> 목표: "학생이 방에 들어가면 그 학생만을 위한 주제가 정해지고, AI 선생님이 칠판에 그림을 그려가며 7분간 설명한 뒤 3분간 자유롭게 이야기하며, 10분이 지나면 승급 시험을 볼 수도, 계속 대화하거나 단체 토론방으로 옮겨 친구들과 이야기할 수도 있다"는 흐름을 완성한다.

## 설계 결정 (기획 논의에서 확정)

- **수업 단위**: 방(교실) 전체가 아니라 **학생 개인별 1:1**. 같은 방의 다른 학생과는 주제/칠판이 완전히 분리된다.
- **칠판 표현 방식**: 자유 손그림이 아니라 **구조화된 그리기 명령**(JSON) — `{type: "text"|"line"|"rect"|"circle"|"arrow"|"clear", ...}`. 좌표는 0~100 상대값이라 어떤 화면 크기에서도 동일하게 렌더링된다.
- **주제 목록**: 학년별로 고정된 20개 문항을 전부 미리 작성하지 않는다. 대신 학년별 "핵심 개념 예시 목록"(대표 6개 내외, `LESSON_TOPICS`)을 커리큘럼 범위 가이드로만 주고, 실제 주제는 AI가 그 범위 안에서 매번 동적으로 고른다(topic 선정 자체를 LLM 호출에 맡김). MockAIProvider는 이 예시 목록에서 순환 선택한다.
- **10분 이후 처리**: 강제 종료/선택 모달 없이, 그냥 시험 응시 버튼이 열릴 뿐 대화는 계속할 수 있게 한다. "친구들과 토론"은 기존 4.2.4 단체 채팅방(`ChatRoom`/`POST /api/school/rooms/:id/join`)으로 화면을 전환하는 것으로 재사용한다 — 새 그룹 채팅 기능을 따로 만들지 않는다.
- **참여 시간/승급 시험 자격**: 기존 `room_participation` + `MIN_PARTICIPATION_SECONDS(600초)` 게이트를 그대로 재사용한다. 개인 수업 시작 시에도 동일하게 `room_participation` 행을 만들어(기존 `join` 핸들러의 로직을 `startRoomParticipation`으로 추출해 재사용), 강의(7분)+토론(3분)=10분이 지나면 기존 `POST /rooms/:roomId/exam/start`가 별도 수정 없이 그대로 동작한다.

## 데이터 모델 추가

- `lesson_sessions`: id, user_id, room_id, topic, started_at, ended_at(nullable), last_board(JSON, nullable) — 학생 1명의 개인 수업 세션 1회
- `lesson_messages`: id, session_id, sender_type('student'|'ai_teacher'), content, board(JSON, nullable — 이 발화 시점에 칠판이 바뀌었을 때만 채움), created_at
- `lesson_topic_log`: id, user_id, school_level, grade, topic, set_at — 같은 학생에게 최근 주제가 반복되지 않도록 회피 목록으로 사용

## AIProvider 확장

- `BoardCommand` 타입(`server/src/ai/AIProvider.ts`): text/line/rect/circle/arrow/clear, 좌표 0~100 상대값
- `startLesson(schoolLevel, grade, avoidTopics)` → `{ topic, message, board }` — 오늘 다룰 주제를 고르고 칠판을 이용한 도입 설명을 만든다
- `answerLessonQuestion(topic, schoolLevel, grade, phase, question, memory, currentBoard)` → `{ message, board? }` — 강의/토론 단계에 맞춰 질문에 답한다. board가 없으면 칠판은 그대로 유지
- `MockAIProvider`는 캔드 응답(그리고 각 학년 `LESSON_TOPICS` 순환 선택)으로 구현. `ClaudeAIProvider`/`GeminiAIProvider`는 JSON 형식으로만 응답하도록 프롬프트를 구성하고(`ai/promptHelpers.ts`), 파싱 실패 시 `ai/board.ts`의 안전한 폴백(원문을 메시지로, 칠판은 유지)으로 넘어간다 — 기존 Provider들의 "실패하면 조용히 MockAIProvider로 대체" 원칙을 그대로 따른다.

## API

- `POST /api/lesson/rooms/:roomId/start` — 방 접근 권한 확인(기존 `assertRoomAccessible` 재사용) 후 개인 수업 세션 시작(활성 세션이 있으면 이어서 재사용, 1시간 넘게 방치된 세션은 자동 만료 처리). `room_participation`도 함께 생성해 기존 승급 시험 자격 로직과 연결
- `POST /api/lesson/sessions/:sessionId/ask` — `{question}` → AI 응답(+ 칠판 갱신) 생성, 현재 단계(lecture/discussion/free)와 경과 시간 반환
- `GET /api/lesson/sessions/:sessionId/state` — 현재 단계/경과 시간/시험 응시 가능 여부/현재 칠판 상태 조회(새로고침 대응)
- `GET /api/lesson/sessions/:sessionId/messages` — 대화 이력
- `POST /api/lesson/sessions/:sessionId/end` — 세션 종료(나가기, 단체 토론방으로 이동 시 호출)

## 핵심 규칙 구현 체크리스트

- [x] 방 입장 시 학생 개인별로 분리된 주제 + 칠판이 시작됨
- [x] 강의 단계(0~7분)와 토론 단계(7~10분) 구분, 언제든 질문하면 즉시 답변
- [x] 10분 경과 시 기존 승급 시험(`/exam/start`) 자격이 자동으로 열림(별도 게이트 로직 추가 없이 `room_participation` 재사용으로 검증)
- [x] 10분이 지나도 시험을 보지 않고 계속 1:1 대화를 이어갈 수 있음(강제 종료 없음)
- [x] 언제든 기존 단체 토론방(4.2.4)으로 전환해 다른 학생들과 이야기할 수 있음
- [x] 칠판 명령이 손상되거나 LLM이 JSON 형식을 어겨도 채팅 자체는 항상 정상 동작(안전한 폴백)

## 이번 단계에서 하지 않는 것

- 4.2.4 단체 토론방 자체의 로직 변경 (Phase 1 구현 그대로 유지)
- 학년별 20개 주제를 전부 고정 문항으로 미리 작성하는 것(위 설계 결정 참고 — 대표 예시만 유지)
- 칠판에 학생이 직접 그림을 그리는 기능(현재는 AI 선생님만 그림)
- 퀵리플라이 칩(README 4.2.4에 이미 존재하는 오픈 아이템, 이번 단계와 무관)

## 완료 기준 (Acceptance)

1. 게스트로 학년 방에 입장하면 그 학생만을 위한 주제가 정해지고 칠판에 도입 내용이 그려짐
2. 강의 단계 중 질문을 보내면 AI가 그 자리에서 답하고, 필요하면 칠판이 갱신됨
3. 10분이 지나면 승급 시험 버튼이 활성화되지만, 누르지 않고 계속 대화해도 세션이 끊기지 않음
4. "친구들과 토론하기" 버튼을 누르면 기존 단체 채팅방으로 정상 전환되어 다른 학생과 대화 가능
5. LLM 키가 없거나 응답이 JSON 형식을 어겨도 서버가 죽지 않고 MockAIProvider 수준의 응답으로 안전하게 대체됨

## 구현 현황

`server/`에 `lesson_sessions`/`lesson_messages`/`lesson_topic_log` 테이블과 `routes/lesson.ts`, `client/`에 `Blackboard.tsx`/`LessonRoom.tsx`를 추가해 구현 완료.

- [x] 개인 수업 시작/질문 응답/상태 조회/이력 조회/종료 API
- [x] `AIProvider`에 `startLesson`/`answerLessonQuestion` 추가, Mock/Claude/Gemini 세 Provider 모두 구현
- [x] 칠판 캔버스 컴포넌트(`Blackboard.tsx`) — text/line/rect/circle/arrow/clear 렌더링, 반응형(0~100 상대좌표)
- [x] `LessonRoom.tsx` — 강의/토론/자유 단계 타이머 표시, 질문 입력, 승급 시험 응시 버튼(10분 후 활성화), 단체 토론방 전환 버튼, 나가기
- [x] `App.tsx`에 `lesson` 뷰 추가, 방 목록에서 선택 시 기존 단체 채팅 대신 개인 수업으로 먼저 진입하도록 변경
