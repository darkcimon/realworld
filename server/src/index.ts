// 다른 모든 import보다 먼저 .env를 읽어야, ANTHROPIC_API_KEY 등이 이후 모듈(ai/ClaudeAIProvider)이
// 평가될 때 이미 process.env에 채워져 있다. .env 파일이 없으면 조용히 아무 효과 없이 넘어간다.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.js";
import { profileRouter } from "./routes/profile.js";
import { schoolRouter } from "./routes/school.js";
import { lessonRouter } from "./routes/lesson.js";
import { jailRouter } from "./routes/jail.js";
import { walletRouter } from "./routes/wallet.js";
import { jobsRouter, workRouter } from "./routes/jobs.js";
import { albaRouter } from "./routes/alba.js";
import { dailyRouter, notificationsRouter } from "./routes/daily.js";
import { npcRouter } from "./routes/npc.js";
import { mannerRouter } from "./routes/manner.js";
import { lotteryRouter } from "./routes/lottery.js";
import { townRouter } from "./routes/town.js";
import { catalogRouter, luxuryRouter, ownedItemsRouter } from "./routes/catalog.js";
import { locationRouter, nearbyRouter } from "./routes/location.js";
import { financeRouter } from "./routes/finance.js";
import { rankingRouter } from "./routes/ranking.js";
import {
  blocksRouter,
  chatRouter,
  giftsRouter,
  heartsRouter,
  matchesRouter,
  profileViewRouter,
} from "./routes/dating.js";
import { attachSocket } from "./socket.js";
import { startLotteryScheduler } from "./social/lottery.js";
import { startGuestCleanupScheduler } from "./social/guestCleanup.js";

const app = express();
// 토큰 자동 연장 헤더(middleware/auth.ts)를 브라우저 JS가 읽을 수 있게 노출한다.
app.use(cors({ exposedHeaders: ["X-Refresh-Token"] }));
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/profile", profileRouter);
app.use("/api/school", schoolRouter);
// Phase 4: 개인 수업(칠판) — school.ts의 방 접근 권한/승급 시험 자격 로직을 재사용한다.
app.use("/api/lesson", lessonRouter);
app.use("/api/jail", jailRouter);
// Phase 2: 사회 생활 & 경제
app.use("/api/wallet", walletRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/work", workRouter);
app.use("/api/alba", albaRouter);
app.use("/api/manner", mannerRouter);
app.use("/api/lottery", lotteryRouter);
// 마을 이동(체력/연료), 내 집 잠자기, 마트 장보기·주유
app.use("/api/town", townRouter);
// Phase 3: 소비/과시 자산 & 소셜(연애) 시스템
app.use("/api/catalog", catalogRouter);
app.use("/api/owned-items", ownedItemsRouter);
app.use("/api/luxury", luxuryRouter);
app.use("/api/location", locationRouter);
app.use("/api/nearby", nearbyRouter);
// 금융 건물: 예금(시간당 1% 복리) / 주식(30분마다 변동) / 채권(1~7일물)
app.use("/api/finance", financeRouter);
app.use("/api/ranking", rankingRouter);
app.use("/api/profile-view", profileViewRouter);
app.use("/api/chat", chatRouter);
app.use("/api/gifts", giftsRouter);
app.use("/api/hearts", heartsRouter);
app.use("/api/blocks", blocksRouter);
app.use("/api/matches", matchesRouter);
app.use("/api/daily", dailyRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/npc", npcRouter);

// Play 스토어 앱(TWA)이 이 도메인의 앱임을 증명하는 파일. 이게 맞아야 앱 위쪽에 주소창이 안 보이고
// 알림도 앱 이름으로 뜬다. 패키지 이름과 앱 서명 인증서 SHA-256(Play Console > 앱 무결성)을 환경변수로 넣는다.
app.get("/.well-known/assetlinks.json", (_req, res) => {
  const pkg = process.env.TWA_PACKAGE_NAME;
  const fingerprints = (process.env.TWA_SHA256_FINGERPRINTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pkg || !fingerprints.length) {
    res.status(404).json({ error: "TWA_PACKAGE_NAME / TWA_SHA256_FINGERPRINTS 가 설정되지 않았습니다." });
    return;
  }
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints },
    },
  ]);
});

// 광고(AdSense) 판매자 인증 파일. AdSense 계정의 게시자 ID(pub-로 시작)를 환경변수로 넣으면 켜진다.
// 루트 도메인에 있어야 인정되므로 내 도메인으로 배포했을 때만 의미가 있다.
app.get("/ads.txt", (_req, res) => {
  const pub = process.env.ADSENSE_PUBLISHER_ID?.trim();
  if (!pub) {
    res.status(404).type("text/plain").send("");
    return;
  }
  res.type("text/plain").send(`google.com, ${pub.startsWith("pub-") ? pub : `pub-${pub}`}, DIRECT, f08c47fec0942fa0\n`);
});

// 운영 배포: 빌드된 클라이언트(client/dist)가 있으면 같은 서버·같은 도메인에서 함께 제공한다.
// 개발 중에는 Vite 개발 서버가 /api·/socket.io를 이 서버로 프록시하므로 이 블록은 쓰이지 않는다.
const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA: /api가 아닌 나머지 GET 요청은 index.html로 돌려 클라이언트 라우팅에 맡긴다.
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const httpServer = createServer(app);
attachSocket(httpServer);
startLotteryScheduler();
startGuestCleanupScheduler();

const PORT = Number(process.env.PORT ?? 4000);
httpServer.listen(PORT, () => {
  console.log(`realworld server listening on http://localhost:${PORT}`);
});
