// 계정 삭제(Play 정책: 계정을 만들 수 있는 앱은 앱 안에서 삭제할 수 있어야 한다).
// 그 유저를 가리키는 모든 행을 FK를 따라 지운다(guestCleanup.purge 재사용). 다른 유저와 주고받은
// 하트·선물·대화·매칭·차단 기록도 함께 지워진다 — 상대 화면에서도 그 사람이 사라진다.
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { purge } from "./guestCleanup.js";

export function deleteAccount(userId: number, password: unknown): { deletedRows: number } {
  const user = db.prepare("SELECT password_hash, is_guest FROM users WHERE id = ?").get(userId) as
    | { password_hash: string | null; is_guest: number }
    | undefined;
  if (!user) throw { status: 404, message: "이미 삭제된 계정이에요." };
  // 정식 회원은 토큰만으로 지울 수 없게 비밀번호를 한 번 더 확인한다(비회원은 비밀번호가 없다).
  if (!user.is_guest && user.password_hash && !bcrypt.compareSync(String(password ?? ""), user.password_hash)) {
    throw { status: 401, message: "비밀번호가 올바르지 않아요." };
  }
  try {
    db.exec("BEGIN");
    // FK 없이 이 유저를 가리키는 칸: 다른 사람 알림의 "보낸 사람"은 비워 둔다(알림 내용은 남는다).
    db.prepare("UPDATE notifications SET actor_id = NULL WHERE actor_id = ?").run(userId);
    const deletedRows = purge("users", "id", [userId]);
    db.exec("COMMIT");
    return { deletedRows };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
