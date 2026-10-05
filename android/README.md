# Google Play 배포 (TWA)

게임은 웹앱 그대로 두고, **TWA(Trusted Web Activity)** 로 감싸서 Play 스토어 앱으로 올린다.
앱은 Chrome 엔진으로 `https://내도메인/`을 전체 화면으로 띄우는 얇은 껍데기라서:

- 게임을 고쳐서 서버에 배포하면 **스토어 재심사 없이 바로** 앱에 반영된다
  (앱 이름·아이콘·패키지 설정을 바꿀 때만 새로 빌드해서 올린다)
- 휴대폰 알림은 웹 푸시(`server/src/social/push.ts`)로 보내고, TWA의 **알림 위임**으로 안드로이드 앱 알림이 된다

배포 도메인: **`real-world.up.railway.app`** (Railway 기본 도메인. 바꾸면 비회원 계정·알림 구독이 끊기고 앱도 다시 빌드해야 하니 그대로 쓴다)

---

## 0. 미리 확인

- [ ] `https://real-world.up.railway.app/manifest.webmanifest` 가 열린다(클라이언트를 새로 빌드해 배포해야 생긴다)
- [ ] `https://real-world.up.railway.app/sw.js` 가 열린다
- [ ] 서버 환경변수에 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`를 고정했다 (`npx web-push generate-vapid-keys`로 생성, `server/.env.example` 참고)
  — 비워 두면 DB에 자동 저장되지만, DB를 새로 만들면 키가 바뀌어 모든 구독이 끊긴다
- [ ] Google Play Console 개발자 계정(등록비 25달러, 1회)

## 1. Bubblewrap으로 앱 프로젝트 만들기

```bash
npm i -g @bubblewrap/cli
cd android
bubblewrap init --manifest https://real-world.up.railway.app/manifest.webmanifest
```

처음 실행하면 JDK와 Android SDK를 내려받을지 묻는다 → **Yes**(직접 설치할 필요 없음).

질문에 답할 때:

| 질문 | 답 |
|---|---|
| Domain / URL path | `real-world.up.railway.app` / `/` |
| Application name / Short name | 매니페스트에서 자동으로 채워짐(인생 시뮬레이션 게임 (가칭) / 인생시뮬) |
| Application ID (패키지 이름) | 예: `com.yourname.lifesim` — **한 번 올리면 바꿀 수 없다** |
| Display mode | `standalone` |
| Orientation | `portrait` |
| Status bar / splash color | `#0f1115` |
| Icon / Maskable icon | 자동 (`/icons/icon-512.png`, `/icons/maskable-512.png`) |
| **Include support for Play Billing?** | No (캐시샵을 붙일 때 다시) |
| **Request permission for location delegation?** | Yes (인연찾기 내 위치 설정에 쓴다) |
| **Enable notifications / notification delegation?** | **Yes** ← 휴대폰 알림에 꼭 필요 |
| Signing key | 새로 만들기(`android.keystore`) — 비밀번호를 잊지 말 것 |

끝나면 `twa-manifest.json`이 생긴다. 열어서 다음이 맞는지 확인한다:

```json
"enableNotifications": true,
"fallbackType": "customtabs",
"host": "real-world.up.railway.app",
"startUrl": "/"
```

> ⚠️ `android.keystore`(서명 키)는 **절대 커밋하지 말고** 안전한 곳에 따로 백업한다.
> 잃어버리면 업로드 키 재설정을 Play 고객센터에 요청해야 한다. (`android/.gitignore`에 이미 빠져 있다)

## 2. 빌드

```bash
bubblewrap build
```

- `app-release-bundle.aab` → Play Console에 올리는 파일
- `app-release-signed.apk` → 내 폰에 바로 설치해서 시험해 보는 파일 (`adb install app-release-signed.apk`)

## 3. 도메인 인증 (주소창 숨기기 + 알림을 앱 이름으로)

앱이 이 도메인의 주인임을 증명해야 위쪽 주소창이 사라진다. 서버가 `/.well-known/assetlinks.json`을 환경변수로 만들어 준다.

1. 업로드 키 지문:
   ```bash
   keytool -list -v -keystore android.keystore -alias android
   ```
   에서 `SHA256:` 줄을 복사
2. Play Console에 앱을 만들고 `.aab`를 한 번 올린 뒤, **설정 → 앱 무결성 → 앱 서명**에서
   **앱 서명 키 인증서의 SHA-256** 을 복사 (Play가 이 키로 다시 서명해서 배포하므로 이게 꼭 필요하다)
3. 서버 환경변수(Railway 등)에 넣고 재배포:
   ```
   TWA_PACKAGE_NAME=com.yourname.lifesim
   TWA_SHA256_FINGERPRINTS=<앱 서명 키 SHA-256>,<업로드 키 SHA-256>
   ```
4. 확인: `https://real-world.up.railway.app/.well-known/assetlinks.json` 이 JSON으로 열리는지,
   그리고 [Statement List Tester](https://developers.google.com/digital-asset-links/tools/generator)로 패키지·지문을 넣어 통과하는지

주소창이 계속 보이면 거의 항상 지문 불일치다(특히 앱 서명 키 지문을 빠뜨린 경우).

## 4. 휴대폰 알림 동작 확인

1. 앱 설치 → 로그인 → 사이드 메뉴 **"🔕 휴대폰 알림 받기"** (또는 🔔 알림창의 "📲 휴대폰으로도 알림 받기")
2. 안드로이드 13 이상이면 시스템 알림 권한 창이 뜬다 → 허용
3. 다른 계정에서 하트나 메시지를 보내면, 앱을 꺼 둔 상태에서도 알림이 온다
4. 알림을 누르면 메시지는 그 사람과의 대화로, 하트·맞하트·선물은 인연찾기로 간다

보내는 알림: 로또 결과 / 월급 / 하트 / 맞하트 / 선물 / 메시지.
NPC(상사·점장·동료) 말은 시끄러워서 게임 안 알림으로만 남긴다(`server/src/social/notifications.ts`의 `PUSH_TITLES`).

## 5. Play Console 심사 때 챙길 것

- **콘텐츠 등급 설문**: 이용 연령 만 18세 이상(연애·만남 기능, 로또 같은 확률형 요소) — 사실대로 답한다
- **데이터 보안 양식**: 수집하는 것 — 위치(인연찾기), 사진(프로필), 메시지(1:1 대화), 기기 식별자 아님(푸시 구독 주소만)
- **개인정보처리방침 URL**: 필수. 웹에 올려 두고 주소를 넣는다
- **대상 API 수준**: Bubblewrap 최신 버전으로 빌드하면 맞춰진다. 매년 요구 수준이 오르므로 `bubblewrap update` 후 다시 빌드한다

## 앱 껍데기를 다시 빌드해야 할 때

앱 이름·아이콘·색·알림/위치 위임 설정을 바꿀 때만:

```bash
cd android
bubblewrap update   # twa-manifest.json 반영, appVersionCode 올림
bubblewrap build
```

게임 내용(화면·규칙·서버)은 서버 배포만 하면 된다.
