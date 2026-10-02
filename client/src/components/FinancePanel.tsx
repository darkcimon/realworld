import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { confirmDialog } from "./ConfirmDialog";

// 금융 건물: 예금(3시간마다 0.5% 복리) / 주식(30분마다 변동) / 채권(1,000만 원 단위, 1~7일물).
// 서버가 조회할 때마다 밀린 이자·주가·채권 만기를 계산하므로 화면은 불러오기만 하면 된다.

const won = (n: number) => `${n.toLocaleString()}원`;

function useNotice() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function run(fn: () => Promise<string | void>, fallback: string) {
    setError(null);
    setMessage(null);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    }
  }
  const view = (
    <>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}
    </>
  );
  return { run, view };
}

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "곧";
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}분 뒤`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 ${m % 60}분 뒤` : `${Math.floor(h / 24)}일 ${h % 24}시간 뒤`;
}

// ── 예금 ──────────────────────────────────────────────────────────
interface DepositInfo {
  balance: number;
  ratePerPeriod: number;
  periodHours: number;
  nextInterestAt: string | null;
}

export function DepositPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [amount, setAmount] = useState("");
  const { run, view } = useNotice();

  const load = () => api.get<DepositInfo>("/finance/deposit").then(setInfo);
  useEffect(() => {
    load();
  }, []);

  const move = (kind: "deposit" | "withdraw") =>
    run(async () => {
      const r = await api.post<DepositInfo>(`/finance/${kind}`, { amount: Number(amount) });
      setInfo(r);
      setAmount("");
      onBalanceChange();
      return `${won(Number(amount))} ${kind === "deposit" ? "입금" : "출금"} 완료`;
    }, "처리하지 못했습니다.");

  return (
    <div className="panel">
      <h3>예금</h3>
      {view}
      <p className="balance-big">{info ? won(info.balance) : "불러오는 중..."}</p>
      <p className="muted">
        {info?.periodHours ?? 3}시간마다 {((info?.ratePerPeriod ?? 0.005) * 100).toFixed(1)}% 이자가 붙어요(복리).
        {info?.nextInterestAt && ` 다음 이자: ${timeLeft(info.nextInterestAt)}`}
      </p>
      <div className="lottery-form">
        <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="금액(원)" />
        <div className="catalog-actions">
          <button onClick={() => move("deposit")} disabled={!(Number(amount) > 0)}>
            입금
          </button>
          <button className="ghost" onClick={() => move("withdraw")} disabled={!(Number(amount) > 0)}>
            출금
          </button>
          <button className="ghost" onClick={() => info && setAmount(String(info.balance))} disabled={!info?.balance}>
            전액
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 주식 ──────────────────────────────────────────────────────────
interface Stock {
  id: number;
  name: string;
  tier: "large" | "mid" | "growth";
  maxMovePct: number;
  price: number;
  prevPrice: number;
  listPrice: number;
  delistedCount: number;
  history: number[];
  shares: number;
  cost: number;
}

const TIER_LABEL: Record<Stock["tier"], string> = { large: "대형주", mid: "중소형주", growth: "성장주" };

function pct(now: number, before: number): number {
  return before ? ((now - before) / before) * 100 : 0;
}

function Change({ value }: { value: number }) {
  const cls = value > 0 ? "up" : value < 0 ? "down" : "";
  return (
    <span className={`price-change ${cls}`}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "-"} {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${28 - ((p - min) / span) * 26}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg className={`sparkline ${up ? "up" : "down"}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={d} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StocksPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [data, setData] = useState<{ nextChangeAt: string; stocks: Stock[] } | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const { run, view } = useNotice();

  const load = () => api.get<{ nextChangeAt: string; stocks: Stock[] }>("/finance/stocks").then(setData);
  useEffect(() => {
    load();
  }, []);

  const trade = (s: Stock, side: "buy" | "sell") =>
    run(async () => {
      const shares = Number(qty[s.id] || 1);
      const r = await api.post<{ price: number; total: number }>(`/finance/stocks/${s.id}/${side}`, { shares });
      onBalanceChange();
      await load();
      return `${s.name} ${shares.toLocaleString()}주 ${side === "buy" ? "매수" : "매도"} (${won(r.total)})`;
    }, "거래하지 못했습니다.");

  const owned = data?.stocks.filter((s) => s.shares > 0) ?? [];
  const value = owned.reduce((n, s) => n + s.price * s.shares, 0);
  const cost = owned.reduce((n, s) => n + s.cost, 0);

  return (
    <div className="panel">
      <h3>주식</h3>
      {view}
      {data && <p className="muted">30분마다 가격이 바뀌어요. 다음 변동: {timeLeft(data.nextChangeAt)}</p>}
      {owned.length > 0 && (
        <p>
          내 주식 평가액 <strong>{won(value)}</strong> <Change value={pct(value, cost)} />
        </p>
      )}

      {(["large", "mid", "growth"] as const).map((tier) => (
        <div key={tier} className="style-section">
          <h4>
            {TIER_LABEL[tier]} <span className="muted">(30분마다 ±{data?.stocks.find((s) => s.tier === tier)?.maxMovePct ?? ""}%)</span>
          </h4>
          <ul className="catalog-list">
            {data?.stocks
              .filter((s) => s.tier === tier)
              .map((s) => (
                <li key={s.id} className="stock-row">
                  <div className="stock-info">
                    <strong>{s.name}</strong>
                    <div>
                      {won(s.price)} <Change value={pct(s.price, s.prevPrice)} />
                    </div>
                    {s.shares > 0 && (
                      <div className="muted">
                        보유 {s.shares.toLocaleString()}주 · 평단 {won(Math.round(s.cost / s.shares))}{" "}
                        <Change value={pct(s.price * s.shares, s.cost)} />
                      </div>
                    )}
                    {s.delistedCount > 0 && <div className="muted">상장폐지 {s.delistedCount}회</div>}
                  </div>
                  <Sparkline points={s.history} />
                  <div className="stock-trade">
                    <input
                      type="number"
                      min={1}
                      value={qty[s.id] ?? "1"}
                      onChange={(e) => setQty((q) => ({ ...q, [s.id]: e.target.value }))}
                      aria-label={`${s.name} 수량`}
                    />
                    <button onClick={() => trade(s, "buy")}>매수</button>
                    <button className="ghost" onClick={() => trade(s, "sell")} disabled={s.shares === 0}>
                      매도
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <p className="muted">⚠️ 가격이 상장가의 1% 밑으로 떨어지면 상장폐지돼 들고 있던 주식이 사라지고, 상장가로 다시 상장돼요.</p>
    </div>
  );
}

// ── 채권 ──────────────────────────────────────────────────────────
interface BondOffering {
  id: number;
  name: string;
  days: number;
  rate: number;
  unitPrice: number;
  total: number;
  remaining: number;
}
interface BondHolding {
  id: number;
  name: string;
  days: number;
  rate: number;
  qty: number;
  principal: number;
  expectedPayout: number;
  maturesAt: string;
  paid: boolean;
}

export function BondsPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [data, setData] = useState<{ offerings: BondOffering[]; holdings: BondHolding[] } | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const { run, view } = useNotice();

  const load = () => api.get<{ offerings: BondOffering[]; holdings: BondHolding[] }>("/finance/bonds").then(setData);
  useEffect(() => {
    load().then(onBalanceChange); // 만기 지난 채권이 방금 정산됐을 수 있다
  }, []);

  const buy = (b: BondOffering) =>
    run(async () => {
      const n = Number(qty[b.id] || 1);
      const total = n * b.unitPrice;
      if (!(await confirmDialog(`${b.name} ${n}개를 ${won(total)}에 살까요?\n${b.days}일 뒤 ${won(Math.round(total * (1 + b.rate / 100)))}을 돌려받아요.`, { title: "채권 구매", confirmText: "사기" })))
        return;
      await api.post(`/finance/bonds/${b.id}/buy`, { qty: n });
      onBalanceChange();
      await load();
      return `${b.name} ${n}개 구매 완료`;
    }, "구매하지 못했습니다.");

  return (
    <div className="panel">
      <h3>채권</h3>
      {view}
      <p className="muted">1개 1,000만 원. 만기가 되면 원금과 이자를 자동으로 지갑에 넣어드려요. 다 팔리면 새 채권이 발행돼요.</p>
      <ul className="catalog-list">
        {data?.offerings.map((b) => (
          <li key={b.id} className="stock-row">
            <div className="stock-info">
              <strong>{b.name}</strong>
              <div>
                {b.days}일 만기 · 이자 <span className="price-change up">{b.rate.toFixed(1)}%</span>
              </div>
              <div className="muted">
                남은 수량 {b.remaining}/{b.total}개
              </div>
            </div>
            <div className="stock-trade">
              <input
                type="number"
                min={1}
                max={b.remaining}
                value={qty[b.id] ?? "1"}
                onChange={(e) => setQty((q) => ({ ...q, [b.id]: e.target.value }))}
                aria-label={`${b.name} 수량`}
              />
              <button onClick={() => buy(b)}>구매</button>
            </div>
          </li>
        ))}
      </ul>

      {data && data.holdings.length > 0 && (
        <>
          <h4>내 채권</h4>
          <ul className="ledger-list">
            {data.holdings.map((h) => (
              <li key={h.id}>
                <span>
                  {h.name} × {h.qty}
                  <br />
                  <small className="muted">{h.paid ? "만기 지급 완료" : `만기 ${timeLeft(h.maturesAt)}`}</small>
                </span>
                <span className="ledger-amount">
                  {won(h.principal)} → {won(h.expectedPayout)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
