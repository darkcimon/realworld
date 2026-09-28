import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { LotteryToday } from "../types";

// README 7장: 만원 단위, 하루 3개 제한, 저녁 7시 추첨.
export function LotteryPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [today, setToday] = useState<LotteryToday | null>(null);
  const [units, setUnits] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setToday(await api.get<LotteryToday>("/lottery/today"));
  }

  useEffect(() => {
    load();
  }, []);

  async function buy(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ amount: number; roundDate: string }>("/lottery/buy", {
        amount: Number(units),
      });
      setMessage(`${r.amount.toLocaleString()}원 구매 완료 (${r.roundDate} 회차)`);
      onBalanceChange();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "구매에 실패했습니다.");
    }
  }

  const drawn = !!today?.round?.drawn_at;

  return (
    <div className="panel">
      <h3>로또</h3>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      {today && (
        <>
          <p className="muted">
            {today.roundDate} 회차 — 오늘 남은 구매 가능 수: {today.remaining}개
            {drawn && " (이미 추첨 완료된 회차)"}
          </p>
          <ul className="ledger-list">
            {today.tickets.map((t) => (
              <li key={t.id}>
                <span>{t.slot}번째 구매</span>
                <span>{t.amount.toLocaleString()}원</span>
              </li>
            ))}
            {today.tickets.length === 0 && <p className="muted">아직 구매한 티켓이 없습니다.</p>}
          </ul>
        </>
      )}

      <form className="lottery-form" onSubmit={buy}>
        <input
          type="number"
          min={1}
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          placeholder="구매 단위 (만원)"
        />
        <button type="submit" disabled={!today || today.remaining <= 0}>
          구매하기
        </button>
      </form>
      <p className="muted">1등 5% / 2등 10% / 3등 20% / 4등(원금의 2배) 50% — 매일 저녁 7시 추첨</p>
    </div>
  );
}
