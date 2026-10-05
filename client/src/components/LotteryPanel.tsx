import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { LotteryToday } from "../types";
import { feedback } from "../feedback";

// README 7장: 무료 응모권(게임머니를 걸지 않는다), 회차당 3장, 매일 09·12·15·18시 네 번 추첨.
export function LotteryPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [today, setToday] = useState<LotteryToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setToday(await api.get<LotteryToday>("/lottery/today"));
  }

  useEffect(() => {
    load();
  }, []);

  async function enter() {
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ slot: number; roundDate: string }>("/lottery/buy", { amount: 1 });
      setMessage(`🎟️ ${r.slot}번째 응모 완료 (${r.roundDate} 회차)`);
      feedback("coin");
      onBalanceChange();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "응모하지 못했어요.");
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
            {today.roundDate} 회차 — 남은 무료 응모권: {today.remaining}장
            {drawn && " (이미 추첨 완료된 회차)"}
          </p>
          <ul className="ledger-list">
            {today.tickets.map((t) => (
              <li key={t.id}>
                <span>🎟️ {t.slot}번째 응모</span>
                <span>{t.amount > 0 ? `${t.amount.toLocaleString()}원` : "무료"}</span>
              </li>
            ))}
            {today.tickets.length === 0 && <p className="muted">아직 응모하지 않았어요.</p>}
          </ul>
        </>
      )}

      <button onClick={enter} disabled={!today || today.remaining <= 0}>
        🎟️ 무료로 응모하기
      </button>
      <p className="muted">
        응모는 무료예요. 1등 5% / 2등 10% / 3등 20% / 4등(2만원) 50% — 매일{" "}
        {(today?.drawHours ?? [9, 12, 15, 18]).map((h) => `${h}시`).join(" · ")} 추첨 (회차당 3장)
      </p>
    </div>
  );
}
