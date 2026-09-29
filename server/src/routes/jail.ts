// README 5장: 감옥/독방
import { Router } from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getActiveJail, recordViolation } from "../school/jail.js";
import { detectViolation } from "../util/moderation.js";
import { chatLengthError } from "../util/chatLimit.js";

export const jailRouter = Router();
jailRouter.use(requireAuth);

jailRouter.get("/status", (req, res) => {
  const jail = getActiveJail(req.userId!);
  res.json(jail ? { type: jail.type, startedAt: jail.started_at, endsAt: jail.ends_at } : null);
});

jailRouter.get("/messages", (req, res) => {
  const jail = getActiveJail(req.userId!);
  if (!jail) {
    res.json([]);
    return;
  }
  if (jail.type === "solitary") {
    // 독방: 검은 화면 + 타이머만 존재, 대화 내역 자체가 없음
    res.json([]);
    return;
  }
  const rows = db
    .prepare(
      "SELECT jm.*, u.nickname FROM jail_messages jm LEFT JOIN users u ON u.id = jm.user_id WHERE jail_session_id = ? ORDER BY jm.id"
    )
    .all(jail.id);
  res.json(rows);
});

jailRouter.post("/message", (req, res) => {
  const jail = getActiveJail(req.userId!);
  if (!jail) {
    res.status(400).json({ error: "감옥에 있지 않습니다." });
    return;
  }
  if (jail.type === "solitary") {
    res.status(403).json({ error: "독방에서는 누구와도 소통할 수 없습니다." });
    return;
  }
  const content = String(req.body?.content ?? "").trim();
  const tooLong = chatLengthError(content);
  if (tooLong) {
    res.status(400).json({ error: tooLong });
    return;
  }
  if (!content) {
    res.status(400).json({ error: "내용을 입력해주세요." });
    return;
  }
  db.prepare(
    "INSERT INTO jail_messages (jail_session_id, user_id, sender_type, content) VALUES (?, ?, 'user', ?)"
  ).run(jail.id, req.userId, content);

  const badWord = detectViolation(content);
  if (badWord) {
    const violation = recordViolation(req.userId!, "jail", `금지어 감지: ${badWord}`);
    db.prepare(
      "INSERT INTO jail_messages (jail_session_id, sender_type, content) VALUES (?, 'system', ?)"
    ).run(
      jail.id,
      violation.jailed
        ? "감옥 내 금지 행위가 3회 누적되어 독방(1일)으로 이동합니다."
        : `감옥 내 금지 행위 경고 (${violation.level}/3)`
    );
    res.json({ ok: true, violation });
    return;
  }
  res.json({ ok: true });
});
