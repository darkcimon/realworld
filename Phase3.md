# Phase 3 — 소비/과시 자산 & 소셜(연애) 시스템

> 대상 README 섹션: 8(자동차), 9(아파트), 10(명품샵), 11(프로필 & 소셜)
> 전제: Phase 2의 지갑/원장, 매너/감옥 인프라가 이미 존재.
> 목표: 번 돈으로 자산을 사서 프로필에 전시하고, 주변 사람을 찾아 하트를 주고받아 맞하트가 성립하면 자유롭게 대화할 수 있는, 이 게임의 핵심 차별화 루프(연애 시뮬레이션)를 완성한다.

## 데이터 모델 추가

- `catalog_items`: id, category(자동차/아파트/명품), brand(명품 전용: 루이비통/에르메스/샤넬/구찌/디올), name, price (8~10장 표 데이터를 시드로 적재)
- `owned_items`: user_id, catalog_item_id, purchased_at, displayed(bool) — 프로필 전시 여부 토글
- `profile_photos`: user_id, url, sort_order (기본 1장, 사진첩 구매 시 최대 5장)
- `photo_album_purchases`: user_id, purchased_at
- `user_locations`: user_id, lat, lng, source(gps/manual), updated_at, last_manual_change_at (하루 1회 제한 검증용)
- `profile_view_passes`: id, viewer_id, target_id, purchased_at, expires_at (구매 후 1시간)
- `gifts`: id, sender_id, receiver_id, item_ref(명품샵 품목 또는 게임머니), sent_at
- `hearts`: id, sender_id, receiver_id, sent_at (50만 게임머니 차감)
- `matches`: id, user_a, user_b, matched_at (양방향 하트 성립 시 생성)
- `blocks`: blocker_id, blocked_id, created_at

## API

### 자동차/아파트/명품샵 (8~10장)
- `GET /api/catalog?category=car|apartment|luxury`
- `POST /api/catalog/:itemId/purchase` — 지갑 잔액 검증 후 ledger 차감 + `owned_items` 추가
- `PATCH /api/owned-items/:id` — 프로필 전시 on/off
- `POST /api/luxury/:itemId/gift` — 명품을 상대에게 선물 (10.용도: 선물 목적)

### 프로필 & 사진첩 (11.1)
- `POST /api/profile/photos` — 사진 업로드 (기본 1장 제한, 사진첩 미구매 시 2번째부터 거부)
- `POST /api/profile/photo-album/purchase` — 2,000만 게임머니 차감 → 최대 5장으로 제한 상향

### 주변 사람 찾기 & 위치 (11.2)
- `PUT /api/location` — GPS 좌표 갱신 (자동, 매 세션)
- `PUT /api/location/manual` — 수동 위치 설정, `last_manual_change_at` 기준 24시간 내 재요청 시 거부
- `GET /api/nearby?radiusKm=50` — 목록(요약 카드만, 상세 비공개)
- `POST /api/profile-view/:targetId/purchase` — 300만 게임머니 차감, 1시간 열람권 발급
- `GET /api/profile-view/:targetId` — 열람권 유효성 검증 후 상세 프로필 반환
- `POST /api/chat/request/:targetId` — 열람권 유효 시간 내에서만 채팅 개시 허용

### 선물 / 하트 / 맞하트 / 차단 (11.3~11.5)
- `POST /api/gifts/:targetId` — 100만 게임머니 차감 + 선물 발송
- `POST /api/hearts/:targetId` — 50만 게임머니 차감, 하트 발송. 수신자는 발신자 프로필 자동 무료 열람권 부여
- `POST /api/hearts/:targetId/reciprocate` — 맞하트 → `matches` 생성, 이후 채팅 제한 해제
- `POST /api/blocks/:targetId`, `DELETE /api/blocks/:targetId` — 차단/해제. 차단 시 상호 채팅 요청/하트/프로필 열람 API 모두 403

## 핵심 규칙 구현 체크리스트

- [x] 자동차/아파트/명품 구매 시 잔액 검증 → ledger 차감 → 프로필에 전시 가능 상태로 저장
- [x] 프로필 사진 기본 1장, 사진첩(2,000만) 구매 시 최대 5장
- [x] 위치는 기본 GPS, 수동 설정 시 우선 적용 + 수동 변경 24시간에 1회 제한
- [x] 반경 50km 목록 조회는 무료(요약만), 상세 프로필은 300만 + 1시간 유효
- [x] 열람권 유효 시간 내에서만 해당 상대에게 채팅 개시 가능
- [x] 선물 100만, 하트 50만 차감 정상 동작
- [x] 하트 수신자는 발신자 프로필을 무료로 열람 가능 (자동 view-pass 발급)
- [x] 맞하트 성립 시 이후 무제한 자유 메시지 가능
- [x] 차단 시 채팅 요청/하트/프로필 열람 모두 차단됨
- [x] 감옥/독방 상태(Phase 1·2 인프라)에서는 11장 API 전체가 잠김(기존 콘텐츠 락 재사용)

## 이번 단계에서 하지 않는 것

- 실제 결제(현금)-게임머니 환전 캐시샵 (README 오픈 이슈, 별도 논의 필요)
- 실시간 위치 정확도/배터리 최적화 등 모바일 GPS 세부 처리
- 차단 시 기존 맞하트/대화 이력 처리 정책 (README 오픈 이슈로 남아 있어 우선 "매칭 해제 + 대화 비활성화"로 최소 구현하고, 정책 확정되면 조정)

## 완료 기준 (Acceptance)

1. 유저가 명품(예: 샤넬 가방)을 구매해 프로필에 전시하면 상대방 프로필 조회 화면에 노출됨
2. 위치를 하루 안에 두 번 수동 변경 시도하면 두 번째 요청은 거부됨
3. 프로필 열람권 구매 후 1시간이 지나면 해당 상대에게 채팅 요청이 거부됨
4. 서로 하트를 주고받으면 매칭이 성립되고, 이후 열람권 없이도 자유롭게 메시지를 보낼 수 있음
5. 한쪽이 상대를 차단하면 이후 모든 상호작용(채팅/하트/열람 요청)이 양방향으로 차단됨

## 구현 현황

서버 API는 자동화 스크립트로 전부 검증 완료. 처음에는 **클라이언트 화면이 없어** API만 동작했는데,
이후 아래 화면을 추가해 브라우저에서 직접 플레이 가능하다(고3 졸업 후 "🏙️ 사회" 탭 → 자산/주변사람).

- [x] `CatalogPanel` — 자동차/아파트/명품 구매, 내 소유 자산 프로필 전시 토글, 명품 선물
- [x] `NearbyPanel` — GPS/수동 위치 설정, 반경 50km 목록, 받은 하트·맞하트 목록(신규 `GET /hearts/incoming`, `GET /matches`)
- [x] `PersonPanel` — 상대 상세 프로필(열람권 구매 포함), 하트/선물/차단, 채팅 개시

### 범위 추가: 1:1 채팅의 실제 메시지 송수신

이 문서의 API 설계에는 `POST /api/chat/request/:targetId`(채팅을 시작해도 되는지 권한만 확인)만
있고, 정작 메시지를 저장·전달하는 기능은 없었다 — 게이트만 있고 대화가 안 되는 상태였다. 그래서
아래를 추가로 구현했다(README 11.3~11.5 범위 내의 자연스러운 연장):

- [x] `social_messages` 테이블, `GET/POST /api/chat/messages/:targetId`(REST, 내역 조회/전송)
- [x] Socket.IO `dm:join`/`dm:message`(`dm:{minId}-{maxId}` 룸)로 실시간 송수신 — 학교 채팅과 동일한 소켓 인증 재사용
- [x] `dm:join` 시에도 REST와 동일하게 차단/열람권/맞하트 여부를 검사 — 그렇지 않으면 상대 id만 알아도 방에 join해 대화를 엿들을 수 있는 구멍이 생김(자동화 스크립트로 도청 불가 확인)
- [x] 메시지 내용은 매너 위반 검사(`checkSocialContent`, README 6.4에서 이미 "사회인 채팅 등"으로 예정돼 있던 훅)를 통과 — 금지어 3회 누적 시 사회인 감옥행까지 동일하게 적용
- [x] 클라이언트 `DmChat` 컴포넌트로 실제 대화 UI 제공
- [x] 새 자동화 스크립트로 REST 전송/내역, 소켓 실시간 송수신, 무관한 제3자의 접근 차단(REST 403 + 소켓 join 거부 + 도청 불가)까지 확인
