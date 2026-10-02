// 금융 건물: 예금 / 주식 / 채권. 따로 돌아가는 타이머 없이, 누가 조회·거래할 때 밀린 만큼 한 번에 계산한다
// (예금 이자는 지난 시간만큼, 주가는 지난 30분 구간 수만큼, 채권은 만기 지난 것만 정산).
import { db } from "../db.js";
import { applyLedgerEntry, withTransaction } from "../wallet/ledger.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── 예금: 1시간마다 1% 복리 ─────────────────────────────────────────
const DEPOSIT_RATE_PER_HOUR = 0.01;

interface DepositRow {
  user_id: number;
  balance: number;
  accrued_at: number; // 마지막으로 이자를 붙인 시각(epoch ms). 다음 이자는 여기서 1시간 뒤
}

/** 밀린 이자를 붙이고 현재 예금 잔액을 돌려준다. 1시간이 다 차지 않은 시간은 다음으로 넘긴다. */
function accrueDeposit(userId: number, now = Date.now()): DepositRow {
  const row = db.prepare("SELECT * FROM deposits WHERE user_id = ?").get(userId) as unknown as DepositRow | undefined;
  if (!row) return { user_id: userId, balance: 0, accrued_at: now };
  const hours = Math.floor((now - row.accrued_at) / HOUR);
  if (hours <= 0) return row;
  const balance = Math.floor(row.balance * (1 + DEPOSIT_RATE_PER_HOUR) ** hours);
  const accruedAt = row.accrued_at + hours * HOUR;
  db.prepare("UPDATE deposits SET balance = ?, accrued_at = ? WHERE user_id = ?").run(balance, accruedAt, userId);
  return { ...row, balance, accrued_at: accruedAt };
}

export function getDeposit(userId: number) {
  const row = accrueDeposit(userId);
  return {
    balance: row.balance,
    ratePerHour: DEPOSIT_RATE_PER_HOUR,
    nextInterestAt: row.balance > 0 ? new Date(row.accrued_at + HOUR).toISOString() : null,
  };
}

function positiveInt(raw: unknown, what: string): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) throw { status: 400, message: `${what}을(를) 1 이상으로 입력하세요.` };
  return n;
}

export function depositMoney(userId: number, rawAmount: unknown) {
  const amount = positiveInt(rawAmount, "금액");
  const now = Date.now();
  const row = accrueDeposit(userId, now);
  applyLedgerEntry(userId, "예금입금", -amount);
  // 빈 통장에 처음 넣을 때부터 1시간을 센다. 이미 돈이 있으면 기존 이자 주기를 그대로 이어간다.
  const accruedAt = row.balance > 0 ? row.accrued_at : now;
  db.prepare(
    `INSERT INTO deposits (user_id, balance, accrued_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, accrued_at = excluded.accrued_at`
  ).run(userId, row.balance + amount, accruedAt);
  return getDeposit(userId);
}

export function withdrawMoney(userId: number, rawAmount: unknown) {
  const amount = positiveInt(rawAmount, "금액");
  const row = accrueDeposit(userId);
  if (amount > row.balance) throw { status: 400, message: "예금 잔액보다 많이 찾을 수 없습니다." };
  db.prepare("UPDATE deposits SET balance = balance - ? WHERE user_id = ?").run(amount, userId);
  applyLedgerEntry(userId, "예금출금", amount);
  return getDeposit(userId);
}

// ── 주식: 30분마다 가격 변동 ─────────────────────────────────────────
// 변동폭 안에서 크기는 고르게, 방향은 upChance 확률로 오른다. 같은 폭으로 오르내리면 복리 때문에
// 길게 보면 값이 계속 줄어서(+10% 뒤 -10%면 -1%) 대형·중소형주도 오를 확률을 반보다 살짝 높였다.
// 성장주는 중소형주보다 오를 확률이 높지만 -90%를 맞으면 회복이 어려워 장기적으로는 조금씩 빠진다.
type Tier = "large" | "mid" | "growth";
const TIERS: Record<Tier, { maxMove: number; upChance: number }> = {
  large: { maxMove: 0.1, upChance: 0.52 },
  mid: { maxMove: 0.2, upChance: 0.54 },
  growth: { maxMove: 0.9, upChance: 0.67 },
};
const STOCK_SLOT_MS = 30 * 60 * 1000;
const DELIST_RATIO = 0.01; // 상장가의 1% 밑으로 떨어지면 상장폐지 → 보유 주식은 휴지가 되고 상장가로 재상장
const HISTORY_KEEP = 48; // 가격 기록은 종목당 최근 48구간(24시간)만 남긴다
const MAX_CATCHUP_SLOTS = 48 * 14; // 서버가 오래 꺼져 있었으면 최근 2주치만 따라잡는다

const SEED_STOCKS: { name: string; tier: Tier; price: number }[] = [
  { name: "한빛전자", tier: "large", price: 180_000 },
  { name: "대한모터스", tier: "large", price: 120_000 },
  { name: "국민금융지주", tier: "large", price: 60_000 },
  { name: "새솔바이오", tier: "mid", price: 42_000 },
  { name: "청림식품", tier: "mid", price: 25_000 },
  { name: "온누리게임즈", tier: "mid", price: 33_000 },
  { name: "퀀텀AI", tier: "growth", price: 15_000 },
  { name: "스타로켓", tier: "growth", price: 9_000 },
  { name: "그린배터리", tier: "growth", price: 12_000 },
];

interface StockRow {
  id: number;
  name: string;
  tier: Tier;
  list_price: number;
  price: number;
  prev_price: number;
  slot: number; // 이 가격이 정해진 30분 구간 번호(epoch ms / 30분)
  delisted_count: number;
}

const slotOf = (ms: number) => Math.floor(ms / STOCK_SLOT_MS);

function seedStocks() {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM stocks").get() as { n: number }).n;
  if (n > 0) return;
  const slot = slotOf(Date.now());
  const ins = db.prepare(
    "INSERT INTO stocks (name, tier, list_price, price, prev_price, slot) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const s of SEED_STOCKS) ins.run(s.name, s.tier, s.price, s.price, s.price, slot);
}

/** 지난 구간 수만큼 가격을 한 칸씩 움직인다. 상장폐지되면 보유분을 지우고 상장가로 다시 시작한다. */
function advanceStocks(now = Date.now()) {
  seedStocks();
  const current = slotOf(now);
  const stocks = db.prepare("SELECT * FROM stocks").all() as unknown as StockRow[];
  if (stocks.every((s) => s.slot >= current)) return;
  withTransaction(() => {
    const save = db.prepare("UPDATE stocks SET price = ?, prev_price = ?, slot = ?, delisted_count = ? WHERE id = ?");
    const hist = db.prepare("INSERT OR REPLACE INTO stock_prices (stock_id, slot, price) VALUES (?, ?, ?)");
    for (const s of stocks) {
      if (s.slot >= current) continue;
      const { maxMove, upChance } = TIERS[s.tier];
      let price = s.price;
      let prev = s.prev_price;
      let delisted = s.delisted_count;
      for (let slot = Math.max(s.slot + 1, current - MAX_CATCHUP_SLOTS); slot <= current; slot++) {
        prev = price;
        const move = Math.random() * maxMove * (Math.random() < upChance ? 1 : -1);
        price = Math.max(1, Math.round(price * (1 + move)));
        if (price < s.list_price * DELIST_RATIO) {
          db.prepare("DELETE FROM stock_holdings WHERE stock_id = ?").run(s.id);
          delisted += 1;
          price = prev = s.list_price;
        }
        if (slot > current - HISTORY_KEEP) hist.run(s.id, slot, price);
      }
      save.run(price, prev, current, delisted, s.id);
      db.prepare("DELETE FROM stock_prices WHERE stock_id = ? AND slot <= ?").run(s.id, current - HISTORY_KEEP);
    }
  });
}

export function listStocks(userId: number) {
  advanceStocks();
  const stocks = db.prepare("SELECT * FROM stocks ORDER BY id").all() as unknown as StockRow[];
  const holdings = db.prepare("SELECT stock_id, shares, cost FROM stock_holdings WHERE user_id = ?").all(userId) as {
    stock_id: number;
    shares: number;
    cost: number;
  }[];
  const historyStmt = db.prepare("SELECT price FROM stock_prices WHERE stock_id = ? ORDER BY slot");
  const current = slotOf(Date.now());
  return {
    nextChangeAt: new Date((current + 1) * STOCK_SLOT_MS).toISOString(),
    stocks: stocks.map((s) => {
      const h = holdings.find((x) => x.stock_id === s.id);
      return {
        id: s.id,
        name: s.name,
        tier: s.tier,
        maxMovePct: TIERS[s.tier].maxMove * 100,
        price: s.price,
        prevPrice: s.prev_price,
        listPrice: s.list_price,
        delistedCount: s.delisted_count,
        history: (historyStmt.all(s.id) as { price: number }[]).map((r) => r.price),
        shares: h?.shares ?? 0,
        cost: h?.cost ?? 0, // 지금 들고 있는 주식을 사는 데 쓴 돈(평단가 = cost / shares)
      };
    }),
  };
}

function getStock(stockId: number): StockRow {
  advanceStocks();
  const s = db.prepare("SELECT * FROM stocks WHERE id = ?").get(stockId) as unknown as StockRow | undefined;
  if (!s) throw { status: 404, message: "없는 종목입니다." };
  return s;
}

export function buyStock(userId: number, stockId: number, rawShares: unknown) {
  const shares = positiveInt(rawShares, "수량");
  const s = getStock(stockId);
  const total = s.price * shares;
  applyLedgerEntry(userId, "주식매수", -total, s.id);
  db.prepare(
    `INSERT INTO stock_holdings (user_id, stock_id, shares, cost) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, stock_id) DO UPDATE SET shares = shares + excluded.shares, cost = cost + excluded.cost`
  ).run(userId, s.id, shares, total);
  return { price: s.price, shares, total };
}

export function sellStock(userId: number, stockId: number, rawShares: unknown) {
  const shares = positiveInt(rawShares, "수량");
  const s = getStock(stockId);
  const h = db.prepare("SELECT shares, cost FROM stock_holdings WHERE user_id = ? AND stock_id = ?").get(userId, s.id) as
    | { shares: number; cost: number }
    | undefined;
  if (!h || h.shares < shares) throw { status: 400, message: "가진 주식보다 많이 팔 수 없습니다." };
  const total = s.price * shares;
  if (h.shares === shares) {
    db.prepare("DELETE FROM stock_holdings WHERE user_id = ? AND stock_id = ?").run(userId, s.id);
  } else {
    // 판 만큼 매수 원가도 비율대로 덜어낸다(남은 주식의 평단가는 그대로).
    const costLeft = Math.round((h.cost * (h.shares - shares)) / h.shares);
    db.prepare("UPDATE stock_holdings SET shares = ?, cost = ? WHERE user_id = ? AND stock_id = ?").run(
      h.shares - shares,
      costLeft,
      userId,
      s.id
    );
  }
  applyLedgerEntry(userId, "주식매도", total, s.id);
  return { price: s.price, shares, total };
}

// ── 채권: 1,000만 원 단위, 3종 상시 판매 ─────────────────────────────
const BOND_UNIT_PRICE = 10_000_000;
const BOND_ISSUE_QTY = 100;
const BOND_OFFERINGS = 3;

interface BondRow {
  id: number;
  name: string;
  days: number;
  rate: number; // 만기까지 받는 이자율(%), 3.0~8.0
  unit_price: number;
  total: number;
  remaining: number;
}

/** 팔고 있는 채권이 3종이 되도록 새 채권을 발행한다(다 팔린 채권은 판매 목록에서 빠진다). */
function ensureBondOfferings() {
  const open = (db.prepare("SELECT COUNT(*) AS n FROM bonds WHERE remaining > 0").get() as { n: number }).n;
  for (let i = open; i < BOND_OFFERINGS; i++) {
    const days = 1 + Math.floor(Math.random() * 7);
    const rate = Math.round((3 + Math.random() * 5) * 10) / 10;
    const r = db
      .prepare("INSERT INTO bonds (name, days, rate, unit_price, total, remaining) VALUES ('', ?, ?, ?, ?, ?)")
      .run(days, rate, BOND_UNIT_PRICE, BOND_ISSUE_QTY, BOND_ISSUE_QTY);
    const id = Number(r.lastInsertRowid);
    db.prepare("UPDATE bonds SET name = ? WHERE id = ?").run(`리얼국채 제${id}호`, id);
  }
}

/** 만기가 지난 내 채권을 원금+이자로 돌려준다. */
function settleBonds(userId: number, now = Date.now()) {
  const due = db
    .prepare(
      `SELECT bh.id, bh.qty, b.unit_price, b.rate, b.name FROM bond_holdings bh JOIN bonds b ON b.id = bh.bond_id
       WHERE bh.user_id = ? AND bh.paid_at IS NULL AND bh.matures_at <= ?`
    )
    .all(userId, now) as { id: number; qty: number; unit_price: number; rate: number; name: string }[];
  for (const h of due) {
    const payout = Math.round(h.qty * h.unit_price * (1 + h.rate / 100));
    db.prepare("UPDATE bond_holdings SET paid_at = ?, payout = ? WHERE id = ?").run(now, payout, h.id);
    applyLedgerEntry(userId, "채권만기", payout, h.id);
  }
}

export function listBonds(userId: number) {
  ensureBondOfferings();
  settleBonds(userId);
  const offerings = db.prepare("SELECT * FROM bonds WHERE remaining > 0 ORDER BY id").all() as unknown as BondRow[];
  const mine = db
    .prepare(
      `SELECT bh.id, bh.qty, bh.bought_at, bh.matures_at, bh.paid_at, bh.payout, b.name, b.days, b.rate, b.unit_price
       FROM bond_holdings bh JOIN bonds b ON b.id = bh.bond_id
       WHERE bh.user_id = ? ORDER BY bh.paid_at IS NOT NULL, bh.matures_at DESC LIMIT 30`
    )
    .all(userId) as any[];
  return {
    offerings: offerings.map((b) => ({
      id: b.id,
      name: b.name,
      days: b.days,
      rate: b.rate,
      unitPrice: b.unit_price,
      total: b.total,
      remaining: b.remaining,
    })),
    holdings: mine.map((h) => ({
      id: h.id,
      name: h.name,
      days: h.days,
      rate: h.rate,
      qty: h.qty,
      principal: h.qty * h.unit_price,
      expectedPayout: h.payout ?? Math.round(h.qty * h.unit_price * (1 + h.rate / 100)),
      maturesAt: new Date(h.matures_at).toISOString(),
      paid: h.paid_at !== null,
    })),
  };
}

export function buyBond(userId: number, bondId: number, rawQty: unknown) {
  const qty = positiveInt(rawQty, "수량");
  ensureBondOfferings();
  const b = db.prepare("SELECT * FROM bonds WHERE id = ?").get(bondId) as unknown as BondRow | undefined;
  if (!b || b.remaining <= 0) throw { status: 404, message: "판매가 끝난 채권입니다." };
  if (qty > b.remaining) throw { status: 400, message: `남은 수량(${b.remaining}개)보다 많이 살 수 없습니다.` };
  applyLedgerEntry(userId, "채권매수", -qty * b.unit_price, b.id);
  const now = Date.now();
  db.prepare("UPDATE bonds SET remaining = remaining - ? WHERE id = ?").run(qty, b.id);
  db.prepare("INSERT INTO bond_holdings (user_id, bond_id, qty, bought_at, matures_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    b.id,
    qty,
    now,
    now + b.days * DAY
  );
  ensureBondOfferings(); // 방금 다 팔렸으면 바로 새 채권을 발행해 3종을 맞춘다
  return { qty, total: qty * b.unit_price };
}
