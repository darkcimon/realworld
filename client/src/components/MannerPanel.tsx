import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { MannerMe } from "../types";

// README 6.4: 매너 점수(기본 100, 위반 시 -1) / 클린 체크 / 5,000만원 초기화
export function MannerPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [manner, setManner] = useState<MannerMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setManner(await api.get<MannerMe>("/manner/me"));
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleCleanCheck() {
    if (!manner) return;
    const enabled = !manner.cleanCheck;
    await api.post("/manner/clean-check", { enabled });
    setManner({ ...manner, cleanCheck: enabled });
  }

  async function reset() {
    setError(null);
    setMessage(null);
    if (!window.confirm("5,000만 게임머니를 지불하고 매너 점수를 100으로 초기화할까요?")) return;
    try {
      await api.post("/manner/reset");
      setMessage("매너 점수가 100으로 초기화되었습니다.");
      onBalanceChange();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "초기화에 실패했습니다.");
    }
  }

  if (!manner) return null;

  return (
    <div className="panel">
      <h3>매너</h3>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}
      <p className="balance-big">{manner.score}점</p>
      {manner.score <= 90 && (
        <p className="error">
          매너 점수가 90점 이하입니다 — 클린 체크를 켠 다른 유저에게는 노출/채팅이 차단됩니다.
        </p>
      )}
      <label className="clean-check-row">
        <input type="checkbox" checked={manner.cleanCheck} onChange={toggleCleanCheck} />
        클린 체크 (매너 90점 이하인 상대는 목록/채팅에서 제외)
      </label>
      <button className="ghost" onClick={reset}>
        매너 점수 초기화 (5,000만원)
      </button>
    </div>
  );
}
