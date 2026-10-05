// Phase 2: 지갑(wallet) / 원장(ledger) 인프라.
// 모든 재화 이동(일급, 알바 정산/오차차감, 로또 구매/당첨, 매너 초기화 결제 등)은
// 반드시 이 모듈을 거쳐 wallets.balance 갱신 + ledger_entries 기록을 하나의 트랜잭션으로 묶는다.
// "화폐 붕괴" 리스크(잔액과 원장 합계가 어긋나는 상황)를 막기 위한 단일 진입점이다.
import { db } from "../db.js";

export class InsufficientBalanceError extends Error {
  constructor(message = "잔액이 부족합니다.") {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

export function withTransaction<T>(fn: () => T): T {
  // 이미 바깥 트랜잭션 안이면 그 일부로 실행한다(구매처럼 "돈 빼기 + 물건 넣기"를 한 번에 묶을 수 있게).
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function ensureWallet(userId: number): void {
  db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)").run(userId);
}

export function getBalance(userId: number): number {
  ensureWallet(userId);
  const row = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(userId) as {
    balance: number;
  };
  return row.balance;
}

export interface LedgerEntry {
  id: number;
  user_id: number;
  type: string;
  amount: number;
  ref_id: number | null;
  balance_after: number;
  created_at: string;
}

export function listLedger(userId: number, limit = 50): LedgerEntry[] {
  return db
    .prepare("SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as unknown as LedgerEntry[];
}

/**
 * 지갑 잔액을 변경하고 ledger_entries에 기록한다. amount는 +(지급)/-(차감) 모두 가능하며
 * 잔액 갱신과 원장 기록이 하나의 트랜잭션으로 묶여 항상 balance == sum(ledger amount)를 보장한다.
 *
 * - floorAtZero: true면 차감액이 잔액을 초과해도 에러 없이 잔액을 0원에서 멈추고,
 *   실제로 적용된 금액만큼만 원장에 기록한다(README: 알바 오차 차감 등 "하한 0원" 규칙용).
 * - floorAtZero가 false(기본)인데 잔액이 부족하면 InsufficientBalanceError를 던진다
 *   (로또 구매, 매너 초기화 등 "잔액이 없으면 그냥 실패해야 하는" 결제용).
 */
export function applyLedgerEntry(
  userId: number,
  type: string,
  amount: number,
  refId?: number,
  opts: { floorAtZero?: boolean } = {}
): { balance: number; amountApplied: number } {
  // 변조 방어: NaN·무한대·터무니없이 큰 값이 들어오면 잔액이 깨지므로 여기서 한 번 더 막는다.
  // 배수 계산(급여 ×1.2 등)으로 생긴 소수는 원 단위로 반올림한다.
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) {
    throw { status: 400, message: "금액이 올바르지 않아요." };
  }
  amount = Math.round(amount);
  return withTransaction(() => {
    ensureWallet(userId);
    const current = (
      db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(userId) as {
        balance: number;
      }
    ).balance;

    let applied = amount;
    let next = current + amount;
    if (next < 0) {
      if (!opts.floorAtZero) {
        throw new InsufficientBalanceError();
      }
      applied = -current;
      next = 0;
    }

    db.prepare("UPDATE wallets SET balance = ? WHERE user_id = ?").run(next, userId);
    db.prepare(
      "INSERT INTO ledger_entries (user_id, type, amount, ref_id, balance_after) VALUES (?, ?, ?, ?, ?)"
    ).run(userId, type, applied, refId ?? null, next);

    return { balance: next, amountApplied: applied };
  });
}
