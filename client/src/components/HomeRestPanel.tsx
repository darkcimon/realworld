import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Vitals } from "../types";

// 내 집 쉬기: 자면 체력이 가득 찬다(쿨타임은 서버 economy.ts VITALS.sleepCooldownHours).
// 서버는 즉시 가득 채우지만, 화면에서는 SLEEP_MS 동안 체력(과 오른쪽 위 배터리)이 천천히 차오르게 보여준다.
const SLEEP_MS = 5000;
export function HomeRestPanel({ onVitalsChange }: { onVitalsChange: (v: Vitals) => void }) {
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sleeping, setSleeping] = useState(false);
  const raf = useRef<number | null>(null);

  // 화면을 떠나면 애니메이션을 멈춘다(서버 값은 이미 가득이라 다음에 불러오면 맞게 보인다).
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    []
  );

  function update(v: Vitals) {
    setVitals(v);
    onVitalsChange(v);
  }

  useEffect(() => {
    api.get<Vitals>("/town/vitals").then(update).catch(() => setError("상태를 불러오지 못했어요."));
  }, []);

  async function sleep() {
    if (!vitals || sleeping) return;
    setError(null);
    setMessage(null);
    const from = vitals.stamina;
    let after: Vitals;
    try {
      after = await api.post<Vitals>("/town/sleep");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "잠들지 못했어요.");
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      update(after);
      setMessage("😴 푹 잤어요! 체력이 가득 찼어요.");
      return;
    }
    setSleeping(true);
    const t0 = performance.now();
    let shown = -1;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / SLEEP_MS);
      const stamina = Math.round(from + (after.stamina - from) * t);
      if (stamina !== shown) {
        shown = stamina;
        update({ ...after, stamina }); // 숫자가 바뀔 때만 갱신(배터리도 함께 차오른다)
      }
      if (t < 1) {
        raf.current = requestAnimationFrame(step);
        return;
      }
      raf.current = null;
      setSleeping(false);
      setMessage("😴 푹 잤어요! 체력이 가득 찼어요.");
    };
    raf.current = requestAnimationFrame(step);
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
                · ⛽ {vitals.car.name} 연료 <b>{vitals.fuel}</b>/{vitals.fuelCapacity}칸
              </>
            )}
          </p>
          {sleeping && (
            <div className="sleep-progress" aria-live="polite">
              <span className="sleep-zzz">💤</span>
              <div className="sleep-progress-bar">
                <div style={{ width: `${Math.round((vitals.stamina / vitals.maxStamina) * 100)}%` }} />
              </div>
              <span>자는 중…</span>
            </div>
          )}
          <button onClick={sleep} disabled={sleeping || !!canSleepAt || vitals.stamina >= vitals.maxStamina}>
            {sleeping ? "💤 자는 중…" : "😴 잠자기 (체력 가득)"}
          </button>
          <p className="muted">
            {sleeping
              ? "체력이 천천히 차오르고 있어요."
              : canSleepAt
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
