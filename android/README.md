# Google Play 배포 (TWA)

게임은 웹앱 그대로 두고, **TWA(Trusted Web Activity)** 로 감싸서 Play 스토어 앱으로 올린다.
앱은 Chrome 엔진으로 `https://real-world.up.railway.app/`을 전체 화면으로 띄우는 얇은 껍데기라서
**게임을 고쳐서 서버에 배포하면 스토어 재심사 없이 바로 앱에 반영된다**
(앱 이름·아이콘·패키지 설정을 바꿀 때만 새로 빌드해서 올린다).

---

## 지금 상태 (이미 끝난 것)

- [x] 배포 도메인 **`real-world.up.railway.app`** — 바꾸면 비회원 계정·알림 구독이 끊기고 앱도 다시 빌드해야 하니 그대로 쓴다
- [x] 패키지 이름 **`com.realworld.app`** (한 번 올리면 바꿀 수 없음)
- [x] Android 프로젝트 생성·빌드 완료 — 알림 위임·위치 위임 켜짐
  - **`android/app-release-bundle.aab`** ← Play Console에 올릴 파일
- [x] 서명 키 `android/android.keystore`, 비밀번호 `android/keystore-password.txt` (커밋 안 됨 — **USB·클라우드에 따로 백업했는지 꼭 확인**)
- [x] 업로드 키 SHA-256: `0E:C4:8B:C1:08:21:B0:59:C4:B5:11:81:B7:9D:89:F7:6D:74:23:C9:44:AF:9B:ED:39:A6:03:75:50:79:83:B6`
- [x] Railway 환경변수 `TWA_PACKAGE_NAME`, `TWA_SHA256_FINGERPRINTS`(업로드 키) — `/.well-known/assetlinks.json` 열림
- [x] 개인정보처리방침 https://real-world.up.railway.app/privacy · 계정 삭제 안내 https://real-world.up.railway.app/account-deletion
- [x] 스토어 이미지·문구·설문 답안: **`android/store-pub/`** (`listing.md`에 전부 정리)

---

## 내일 할 일 (순서대로)

### 1. Play Console 계정
- [ ] https://play.google.com/console 개발자 계정 (등록비 25달러, 1회). 본인 확인에 며칠 걸릴 수 있다
- [ ] 계정 유형이 **개인**이면 → 정식 출시 전에 **비공개 테스트 12명 × 14일**이 필수 (아래 6번). 테스터로 부탁할 지인 12명의 구글 계정 이메일을 미리 모아 둔다

### 2. 앱 만들기
- [ ] **앱 만들기** → 앱 이름 `인생시뮬: 박스집에서 펜트하우스까지` (`listing.md`의 다른 후보도 가능) / 기본 언어 한국어 / **게임** / **무료**
- [ ] 선언(개발자 프로그램 정책, 미국 수출법) 체크

### 3. 스토어 등록정보 (`store-pub/listing.md` 보고 붙여 넣기)
- [ ] 간단한 설명 · 자세한 설명
- [ ] 앱 아이콘 `store-pub/app-icon-512.png`
- [ ] 그래픽 이미지 `store-pub/feature-graphic.png`
- [ ] 휴대전화 스크린샷 `store-pub/screenshots/01~07.png` (순서대로)
- [ ] 카테고리 **시뮬레이션**, 이메일 `cimon7157@gmail.com`, 웹사이트 `https://real-world.up.railway.app/`

### 4. 앱 콘텐츠 (정책 설문 — 답은 `listing.md`의 "앱 콘텐츠" 표 그대로)
- [ ] 개인정보처리방침 URL: `https://real-world.up.railway.app/privacy`
- [ ] 광고: **없음**
- [ ] 앱 액세스 권한: 로그인 없이 사용 가능 (첫 화면에서 태어난 해·달을 성인으로 고르고 비회원으로 시작)
- [ ] 콘텐츠 등급 설문 (IARC) — 로또는 무료 응모라 **시뮬레이션 도박: 아니요**, 사용자 간 소통·위치 공유: **예**
- [ ] 타겟층: **13~15세, 16~17세, 18세 이상** (실제 가입은 만 14세부터)
- [ ] 데이터 보안: `listing.md`의 수집 항목 표대로 (위치·이메일·사용자 ID·사진·메시지·앱 활동, 공유 없음, 전송 암호화, 삭제 요청 가능)
- [ ] 계정 삭제: URL `https://real-world.up.railway.app/account-deletion`, 앱 안 사이드 메뉴 → 계정 삭제
- [ ] 아동 안전 표준(사람끼리 소통하는 앱이면 요구됨): 정책 URL은 개인정보처리방침 주소, 담당 연락처 `cimon7157@gmail.com`
- [ ] 뉴스·정부·금융·건강 앱: 모두 **아니요**

### 5. 내부 테스트에 올리기
- [ ] **테스트 및 출시 → 내부 테스트 → 새 버전 만들기**
- [ ] Play 앱 서명: **Google에서 생성한 키 사용(권장)** 그대로
- [ ] `android/app-release-bundle.aab` 업로드 → 출시 노트(`listing.md`) → 저장·검토·출시
- [ ] 테스터 목록에 내 구글 계정 추가 → 참여 링크로 내 폰에 설치

### 6. ⚠️ 앱 서명 키 지문 추가 (주소창 숨기기 — 빠뜨리면 앱 위에 주소창이 보인다)
Play가 업로드한 파일을 **자기 키로 다시 서명**해서 배포하므로, 그 키의 지문도 서버에 알려 줘야 한다.
- [ ] Play Console **설정 → 앱 무결성 → 앱 서명** → "앱 서명 키 인증서"의 **SHA-256** 복사
- [ ] Railway 환경변수 `TWA_SHA256_FINGERPRINTS` 를 **쉼표로 둘 다** 넣어 바꾸고 재배포:
  ```
  TWA_SHA256_FINGERPRINTS=<방금 복사한 앱 서명 키 SHA-256>,0E:C4:8B:C1:08:21:B0:59:C4:B5:11:81:B7:9D:89:F7:6D:74:23:C9:44:AF:9B:ED:39:A6:03:75:50:79:83:B6
  ```
- [ ] 확인: https://real-world.up.railway.app/.well-known/assetlinks.json 에 지문 2개가 보이는지
- [ ] Play에서 받은 앱을 열었을 때 **주소창이 안 보이면** 성공 (바로 안 바뀌면 앱 데이터 삭제 후 다시 열기)

### 7. 폰에서 확인
- [ ] 첫 화면 → 태어난 해·달 → 비회원 시작
- [ ] 사이드 메뉴 **"🔕 휴대폰 알림 받기"** → 알림 권한 허용 (안드로이드 13+)
- [ ] 다른 계정(웹 브라우저)으로 하트를 보내면 앱을 꺼 둔 상태에서도 알림이 오는지

### 8. 비공개 테스트 → 정식 출시 (개인 계정)
- [ ] **비공개 테스트** 트랙에 같은 `.aab`로 버전 만들기 → 테스터 12명 이상 이메일 등록 → 참여 링크 공유
- [ ] 12명 이상이 **14일 연속** 참여(설치 유지)
- [ ] 14일 뒤 **프로덕션 액세스 신청** (테스트 소감 몇 가지 질문에 답) → 심사(보통 며칠) → 출시

---

## 참고

### 앱 껍데기를 다시 빌드해야 할 때
앱 이름·아이콘·색·알림/위치 위임 설정을 바꿀 때만 (게임 내용은 서버 배포만 하면 된다). PowerShell:
```powershell
cd android
bubblewrap update   # twa-manifest.json 반영, appVersionCode 올림
$env:BUBBLEWRAP_KEYSTORE_PASSWORD = "<keystore-password.txt의 비밀번호>"; $env:BUBBLEWRAP_KEY_PASSWORD = $env:BUBBLEWRAP_KEYSTORE_PASSWORD
bubblewrap build
```
이 PC 빌드 환경: `~/.bubblewrap/config.json`의 JDK를 17(`C:/Users/PC_1M/jdk17` → Microsoft JDK 17 링크)로 맞춰 두었다.
JDK 24로는 Gradle이 실패하고, 경로에 공백(`Program Files`)이 있으면 Bubblewrap 서명 단계가 실패한다.
Play는 매년 대상 API 수준을 올리므로 1년에 한 번쯤 `bubblewrap update` 후 다시 빌드해 올린다.

### 휴대폰 알림
보내는 알림: 로또 결과 / 월급 / 하트 / 맞하트 / 선물 / 메시지. NPC(상사·점장·동료) 말은 게임 안 알림으로만 남긴다
(`server/src/social/notifications.ts`의 `PUSH_TITLES`). 알림을 누르면 메시지는 그 사람과의 대화로, 하트·맞하트·선물은 인연(친구)찾기로 간다.
알림 키(`VAPID_*`)는 비워 두면 서버가 DB에 만들어 저장한다 — DB를 새로 만들 일이 있으면 키를 환경변수로 고정할 것(`server/.env.example`).

### 주소창이 계속 보이면
거의 항상 지문 불일치다(특히 6번의 앱 서명 키 지문을 빠뜨린 경우). [Statement List Tester](https://developers.google.com/digital-asset-links/tools/generator)에
`real-world.up.railway.app`, `com.realworld.app`, 지문을 넣어 확인한다.
