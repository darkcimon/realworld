import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Vitals } from "../types";

// 내 집 쉬기: 자면 체력이 가득 찬다(쿨타임은 서버 economy.ts VITALS.sleepCooldownHours).
export function HomeRestPanel({ onVitalsChange }: { onVitalsChange: (v: Vitals) => void }) {
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function update(v: Vitals) {
    setVitals(v);
    onVitalsChange(v);
  }

  useEffect(() => {
    api.get<Vitals>("/town/vitals").then(update).catch(() => setError("상태를 불러오지 못했어요."));
  }, []);

  async function sleep() {
    setError(null);
    setMessage(null);
    try {
      update(await api.post<Vitals>("/town/sleep"));
      setMessage("😴 푹 잤어요! 체력이 가득 찼어요.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "잠들지 못했어요.");
    }
  }

  const canSleepAt = vitals?.canSleepAt ? new Date(vitals.canSleepAt) : null;

  return (
    <div className="panel">
      <h3>쉬기</h3>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}
      {vitals && (
        <>
          <p>
            💪 체력 <b>{vitals.stamina}</b>/{vitals.maxStamina}
            {vitals.car && (
              <>
                {" "}
                · ⛽ {vitals.car.name} 연료 <b>{vitals.fuel}</b>/{vitals.tankMoves}회
              </>
            )}
          </p>
          <button onClick={sleep} disabled={!!canSleepAt || vitals.stamina >= vitals.maxStamina}>
            😴 잠자기 (체력 가득)
          </button>
          <p className="muted">
            {canSleepAt
              ? `${canSleepAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 이후에 다시 잘 수 있어요.`
              : vitals.stamina >= vitals.maxStamina
                ? "지금은 체력이 가득해요."
                : "자고 나면 체력이 가득 차요. 한 번 자면 몇 시간 뒤에 다시 잘 수 있어요."}
            {" "}연료는 마트에서 채워요.
          </p>
        </>
      )}
    </div>
  );
}
