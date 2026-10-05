// README 4.4: 화면 상단 프로필(아바타, 학력·학교 진도), 4.5: 졸업장/등급 표시, 11.1: 사진첩(Phase 3)
import { Router } from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireNotJailed } from "../middleware/jailGate.js";
import { getActiveJail } from "../school/jail.js";
import { InsufficientBalanceError } from "../wallet/ledger.js";
import { addPhoto, purchasePhotoAlbum } from "../social/photos.js";
import { listDisplayedItems } from "../social/catalog.js";
import { educationOf } from "../social/education.js";
import { buyStyleItem, getCharacter, listStyleShop, listUnlocks, saveCharacter } from "../social/character.js";

export const profileRouter = Router();
profileRouter.use(requireAuth);

// 학교급당 1건(최근 응시 결과)을 초 → 중 → 고 순서로 보여준다.
const GRADUATIONS_SQL =
  "SELECT * FROM graduations WHERE user_id = ? ORDER BY CASE school_level WHEN 'elementary' THEN 0 WHEN 'middle' THEN 1 ELSE 2 END";

const LEVEL_LABEL: Record<string, string> = {
  elementary: "초등학교",
  middle: "중학교",
  high: "고등학교",
};

profileRouter.get("/", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId) as any;
  const profile = db
    .prepare("SELECT * FROM student_profile WHERE user_id = ?")
    .get(req.userId) as any;
  const graduations = db
    .prepare(GRADUATIONS_SQL)
    .all(req.userId);
  const jail = getActiveJail(req.userId!);

  res.json({
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    isGuest: !!user.is_guest,
    email: user.email,
    school: {
      level: profile.school_level,
      levelLabel: LEVEL_LABEL[profile.school_level],
      grade: profile.grade,
      status: profile.status,
      label: schoolLabel(profile),
    },
    education: educationOf(user.id),
    graduations,
    // 다른 사람이 내 프로필을 열면 보이는 전시 물건 — 내 프로필 헤더에도 뱃지로 보여준다.
    displayedItems: listDisplayedItems(user.id),
    character: getCharacter(user.id), // 아직 안 만들었으면 null → 첫 시작 때 꾸미기 창을 띄운다
    jail: jail ? { type: jail.type, endsAt: jail.ends_at } : null,
  });
});

// 학교 진도. 학교는 사회인이 다니는 "학력 올리기" 과정이라 "N학년 과정"으로 보여준다.
// 졸업생은 "고등학교 졸업" — 배치고사로 졸업하면 grade가 1로 남고, 고3 승급 시험으로 졸업해도 grade가
// 3으로 남아서 학년을 그대로 붙이면 아직 다니는 중처럼 보인다.
function schoolLabel(profile: { school_level: string; grade: number; status: string }): string {
  return profile.status === "graduated"
    ? `${LEVEL_LABEL.high} 졸업` // 졸업(status)은 고등학교 졸업으로만 생긴다 — 재응시로 school_level이 바뀌어도 최종 학력 기준
    : `${LEVEL_LABEL[profile.school_level]} ${profile.grade}학년 과정`;
}

// 채팅(학교 단체 채팅/1:1 채팅) 메시지의 프로필 사진 아이콘을 눌렀을 때 조회하는 공개 프로필.
// PersonPanel(11절, 300만원 열람권이 필요한 상세 프로필/소셜 콘텐츠)과 달리 비용 없이
// 누구나 볼 수 있는 정보(닉네임/사진/학력/졸업 등급)만 돌려준다.
profileRouter.get("/public/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const user = db
    .prepare("SELECT id, nickname, avatar_url, is_guest FROM users WHERE id = ?")
    .get(userId) as any;
  if (!user) {
    res.status(404).json({ error: "존재하지 않는 유저입니다." });
    return;
  }
  const profile = db
    .prepare("SELECT * FROM student_profile WHERE user_id = ?")
    .get(userId) as any;
  const graduations = db
    .prepare(GRADUATIONS_SQL)
    .all(userId);

  res.json({
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    isGuest: !!user.is_guest,
    school: profile
      ? {
          level: profile.school_level,
          levelLabel: LEVEL_LABEL[profile.school_level],
          grade: profile.grade,
          status: profile.status,
          label: schoolLabel(profile),
        }
      : null,
    education: educationOf(userId),
    graduations,
  });
});

profileRouter.put("/character", (req, res) => {
  try {
    res.json({ character: saveCharacter(req.userId!, req.body?.character) });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

// 꾸미기 창의 잠금 표시용
profileRouter.get("/character/unlocks", (req, res) => {
  res.json(listUnlocks(req.userId!));
});

// 스타일샵(마을 시설): 다른 매장처럼 수감 중에는 막는다.
profileRouter.get("/style-shop", requireNotJailed, (req, res) => {
  res.json(listStyleShop(req.userId!));
});

profileRouter.post("/style-shop/buy", requireNotJailed, (req, res) => {
  try {
    res.json(buyStyleItem(req.userId!, String(req.body?.key ?? "")));
  } catch (e: any) {
    if (e instanceof InsufficientBalanceError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
  }
});

profileRouter.patch("/", (req, res) => {
  const { avatarUrl, nickname } = req.body ?? {};
  db.prepare(
    "UPDATE users SET avatar_url = COALESCE(?, avatar_url), nickname = COALESCE(?, nickname) WHERE id = ?"
  ).run(avatarUrl ?? null, nickname ?? null, req.userId);
  res.json({ ok: true });
});

// README 11.1: 사진첩 — 사회 콘텐츠이므로 이 두 라우트는 수감 중에 막는다.
profileRouter.post(
  "/photos",
  requireNotJailed,
  (req, res) => {
    try {
      const url = String(req.body?.url ?? "").trim();
      if (!url) {
        res.status(400).json({ error: "url은 필수입니다." });
        return;
      }
      res.json(addPhoto(req.userId!, url));
    } catch (e: any) {
      res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
    }
  }
);

profileRouter.post(
  "/photo-album/purchase",
  requireNotJailed,
  (req, res) => {
    try {
      res.json(purchasePhotoAlbum(req.userId!));
    } catch (e: any) {
      if (e instanceof InsufficientBalanceError) {
        res.status(400).json({ error: e.message });
        return;
      }
      res.status(e.status ?? 500).json({ error: e.message ?? "unknown error" });
    }
  }
);
