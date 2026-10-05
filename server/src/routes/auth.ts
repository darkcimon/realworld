// README 1절: 비회원 플레이 가능, 저장하려면 계정 생성 유도.
// guest로 시작한 유저가 회원가입하면 같은 user row를 "승격"시켜 진행 데이터(학년, 위반 이력 등)를
// 그대로 이어가게 한다 — 비회원 데이터가 통째로 날아가지 않도록 하는 것이 이 라우트의 핵심.
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { JWT_SECRET, signToken } from "../middleware/auth.js";

export const authRouter = Router();

interface UserRow {
  id: number;
  email: string | null;
  password_hash: string | null;
  nickname: string;
  avatar_url: string | null;
  is_guest: number;
}

function currentGuestUserId(req: import("express").Request): number | null {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub) as
      | UserRow
      | undefined;
    return row && row.is_guest ? row.id : null;
  } catch {
    return null;
  }
}

// 성인(만 18세 이상) 대상 게임이라 새 계정을 만들 때는 이용 연령 확인을 받는다.
function adultConfirmed(req: import("express").Request, res: import("express").Response): boolean {
  if (req.body?.adultConfirmed === true) return true;
  res.status(400).json({ error: "만 18세 이상만 이용할 수 있어요. 연령 확인에 체크해 주세요." });
  return false;
}

authRouter.post("/guest", (req, res) => {
  if (!adultConfirmed(req, res)) return;
  const nickname = String(req.body?.nickname ?? "").trim() || `게스트${Date.now() % 10000}`;
  // 최초 게임 시작 시 고른 기본 아바타 또는 잘라낸 사진(데이터 URL)을 그대로 avatar_url에 저장한다.
  const avatarUrl = req.body?.avatarUrl ? String(req.body.avatarUrl) : null;
  const result = db
    .prepare(
      "INSERT INTO users (nickname, avatar_url, is_guest, last_seen_at, adult_confirmed_at) VALUES (?, ?, 1, datetime('now'), datetime('now'))"
    )
    .run(nickname, avatarUrl);
  const userId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO student_profile (user_id) VALUES (?)").run(userId);
  res.json({ token: signToken(userId), user: { id: userId, nickname, isGuest: true } });
});

authRouter.post("/register", (req, res) => {
  const { email, password, nickname, avatarUrl } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: "email, password는 필수입니다." });
    return;
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    res.status(409).json({ error: "이미 가입된 이메일입니다." });
    return;
  }
  const passwordHash = bcrypt.hashSync(String(password), 10);
  const guestId = currentGuestUserId(req);

  if (guestId) {
    // 비회원 진행 데이터를 그대로 유지한 채 정식 회원으로 승격. avatarUrl은 이 화면에서 새로
    // 고른 경우에만 덮어쓰고, 안 골랐으면 게스트 시절 아바타(COALESCE)를 그대로 둔다.
    db.prepare(
      "UPDATE users SET email = ?, password_hash = ?, is_guest = 0, nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url) WHERE id = ?"
    ).run(email, passwordHash, nickname ?? null, avatarUrl ?? null, guestId);
    res.json({
      token: signToken(guestId),
      user: { id: guestId, nickname: nickname ?? undefined, isGuest: false },
      upgraded: true,
    });
    return;
  }

  // 비회원 승격은 게스트로 시작할 때 이미 연령 확인을 받았다. 새로 가입할 때만 확인한다.
  if (!adultConfirmed(req, res)) return;
  const result = db
    .prepare(
      "INSERT INTO users (email, password_hash, nickname, avatar_url, is_guest, adult_confirmed_at) VALUES (?, ?, ?, ?, 0, datetime('now'))"
    )
    .run(email, passwordHash, nickname ?? email, avatarUrl ? String(avatarUrl) : null);
  const userId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO student_profile (user_id) VALUES (?)").run(userId);
  res.json({ token: signToken(userId), user: { id: userId, nickname, isGuest: false } });
});

authRouter.post("/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | UserRow
    | undefined;
  if (!row || !row.password_hash || !bcrypt.compareSync(String(password ?? ""), row.password_hash)) {
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }
  res.json({
    token: signToken(row.id),
    user: { id: row.id, nickname: row.nickname, isGuest: !!row.is_guest },
  });
});
