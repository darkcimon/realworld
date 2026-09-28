# Phase 2 — 사회 생활 & 경제

> 대상 README 섹션: 6(사회 생활 — 직업/알바/매너/사회인 감옥), 7(로또)
> 전제: Phase 1의 계정 시스템, 감옥 인프라, 게임머니 개념(원 단위 = 게임머니)이 이미 존재한다고 가정.
> 목표: 고등학교 졸업 후 "일해서 돈을 벌고(직장/알바), 그 돈으로 로또를 사고, 규칙을 어기면 매너가 깎이고 감옥에 간다"는 경제 루프를 완성한다.

## 이번 단계에서 새로 필요한 것

- **지갑(wallet) / 원장(ledger) 인프라**: 모든 재화 이동(일급 지급, 알바 정산, 로또 구매/당첨, 매너 초기화 결제 등)을 하나의 `ledger_entries` 테이블에 기록해 잔액을 항상 합산으로 검증 가능하게 한다. (테스터 리뷰에서 지적된 "화폐 붕괴" 리스크에 대비해 모든 지급/차감은 서버 트랜잭션으로 원자적으로 처리)
- **사회 진입 게이트**: 고등학교 3학년 졸업 여부를 확인해 6장 이하 라우트를 잠금 해제

## 데이터 모델 추가

- `wallets`: user_id, balance
- `ledger_entries`: id, user_id, type(일급/알바정산/로또구매/로또당첨/매너초기화/...), amount(+/-), ref_id, created_at
- `jobs`: id, name, tier(S등급전용/전체), pay_min, pay_max
- `job_assignments`: user_id, job_id, assigned_at
- `work_sessions`: id, user_id, job_id, correct_count, started_at, ended_at, paid(bool)
- `mart_shifts`: id, user_id, started_at, per_minute_wage, penalty_total
- `mart_transactions`: id, shift_id, correct_amount, entered_amount, error_amount, penalty
- `lottery_tickets`: id, user_id, round_date, amount, numbers/slot
- `lottery_rounds`: id, round_date, participant_count, tier1_min, tier1_max, drawn_at
- `lottery_results`: round_id, user_id, tier(1~4/낙첨), prize_amount
- `manner_scores`: user_id, score(기본 100)
- `manner_violations`: id, user_id, reason, delta, created_at
- `adult_violations` / 기존 `violations` 테이블 재사용(4.6 규칙과 동일 로직 공유하도록 room_id 대신 context 컬럼 추가)

## API

### 직업/근무 (6.1~6.2)
- `GET /api/jobs` — 등급별 직업 목록 (본인 졸업 등급에 따라 S등급 전용 직업 노출 여부 결정)
- `POST /api/jobs/:jobId/assign`
- `POST /api/work/start` — 근무 세션 시작, 5문제 단위 출제(Phase 1의 `AIProvider` 재사용)
- `POST /api/work/answer`
- `POST /api/work/continue-or-leave` — 잔업 계속 / 퇴근
- `POST /api/work/settle` — 자정 배치(cron)에서 실제 근무 수행 여부 확인 후 일급 지급 (ledger 기록)

### 알바 — 마트 (6.3)
- `POST /api/alba/mart/shift/start`
- `POST /api/alba/mart/transaction` — `{correctAmount, enteredAmount}` → 오차 계산, 즉시 분급에서 페널티 차감(ledger 기록), 하한 0원
- `POST /api/alba/mart/shift/end` — 누적 분급 정산

### 매너 / 사회인 감옥 (6.4~6.5)
- `GET /api/manner/me`, `GET /api/manner/:userId` — 본인/타인 매너 점수 조회
- `POST /api/manner/clean-check` — 클린 체크 on/off (본인 검색 필터 아님, "내가 90점 이하인 상대를 안 본다"는 필터이므로 목록 API에 반영)
- `POST /api/manner/reset` — 5,000만 게임머니 차감 후 위반 누적 0으로 초기화 (ledger 기록)
- 위반 감지 시 Phase 1의 4.6 로직 재사용 → 3차 위반 시 감옥(5장) 세션 생성 + 콘텐츠 락 재사용

### 로또 (7장)
- `POST /api/lottery/buy` — 만원 단위, 하루 3개 제한 검증
- `GET /api/lottery/today` — 오늘 회차 구매 현황(본인 몫)
- (서버 크론) 매일 19:00 KST 추첨 배치: `GET /api/lottery/rounds/:date` 결과 조회
  - 참여자 수 = 해당 회차 구매자 수(중복 인원 제외, 티켓 수 아님) 기준으로 10명 단위마다 1등 당첨금 범위 2배 보정
  - 등수 독립 추첨: 1등 5% / 2등 10% / 3등 20% / 4등 50%로 티켓마다 개별 판정

## 핵심 규칙 구현 체크리스트

- [x] 고3 졸업 확인 후 사회 콘텐츠 라우트 오픈
- [x] S등급 전용 직업은 S등급 졸업생에게만 노출/배정 가능
- [x] 근무: 5문제 맞춰야 잔업/퇴근 선택, 자정 정산은 실제 근무 수행 여부를 확인해야 지급
- [x] 알바 계산 오차 = 오차금액 × 100 즉시 차감, 분급 하한 0원 처리(마이너스 방지)
- [x] 매너 점수 위반 시 -1, 클린 체크 시 90점 이하 유저 검색/채팅요청 차단
- [x] 사회인도 4.6과 동일한 3단계 위반 규칙으로 감옥행, 감옥 중 콘텐츠 락(Phase 1 인프라 재사용)
- [x] 매너 초기화 5,000만 게임머니 차감 → 위반 누적 0
- [x] 로또 하루 3개 제한(계정 기준), 만원 단위 구매
- [x] 매일 19:00 자동 추첨, 해당 회차 구매자 수 기준 1등 당첨금 보정
- [x] 모든 재화 이동이 `ledger_entries`에 기록되어 잔액 합산 검증 가능

## 이번 단계에서 하지 않는 것

- 자동차/아파트/명품샵/소셜(연애) 시스템 전체 (Phase 3)
- 실제 결제(현금)로 게임머니 충전하는 캐시샵 (README 미정 사항, 별도 논의 후 착수)
- 멀티 계정 방지(디바이스 핑거프린팅 등 부정 방지 고도화) — 테스트 단계 오픈 이슈로 남김

## 완료 기준 (Acceptance)

1. 고3 졸업 유저가 마트 알바에서 계산을 틀리면 즉시 분급이 100배 차감되어 지갑 잔액에 반영됨
2. 동일 유저가 로또를 하루 4번째 구매 시도 시 거부됨
3. 저녁 7시 배치 실행 후 당첨 결과가 생성되고, 해당 회차 구매자 수에 따라 1등 당첨금 범위가 문서 규칙대로 보정됨
4. 금지어 3회 위반 시 사회인도 감옥에 갇히고 그 동안 알바/근무/로또 API가 모두 403으로 차단됨
5. 매너 점수가 90점 이하로 떨어진 유저는 클린 체크를 켠 다른 유저의 목록/채팅 요청에서 배제됨

## 구현 현황

서버 API는 자동화 스크립트로 전부 검증 완료. 처음에는 **클라이언트 화면이 없어** API만 동작하고
실제로 플레이할 방법이 없었는데, 이후 아래 화면을 추가해 브라우저에서 직접 플레이 가능하다
(`client/src/components/SocialHub.tsx` 기준, 고3 졸업 후 "🏙️ 사회" 탭에서 진입).

- [x] `WalletPanel` — 잔액 + 원장(ledger) 내역
- [x] `JobsPanel` — 직업 배정, 5문제 근무, 잔업/퇴근 선택, 정산
- [x] `AlbaPanel` — 마트 근무(랜덤 장바구니 계산), 오차 페널티/분급 즉시 반영
- [x] `LotteryPanel` — 만원 단위 구매, 하루 3개 제한, 회차 현황 표시
- [x] `MannerPanel` — 매너 점수, 클린 체크 토글, 초기화(5,000만원)
