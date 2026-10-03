import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Vitals } from "../types";
import { CookingGame } from "./CookingGame";

// 내 집 쉬기: 자면 체력이 가득 찬다(쿨타임은 서버 economy.ts VITALS.sleepCooldownHours).
// 서버는 즉시 가득 채우지만, 화면에서는 SLEEP_MS 동안 체력(과 오른쪽 위 배터리)이 천천히 차오르게 보여준다.
const SLEEP_MS = 5000;
export function HomeRestPanel({ onVitalsChange }: { onVitalsChange: (v: Vitals) => void }) {
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sleeping, setSleeping] = useState(false);
  const [cooking, setCooking] = useState(false);
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
  const cookAt = vitals?.cookAvailableAt ? new Date(vitals.cookAvailableAt) : null;
  const hhmm = (d: Date) => d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  // 배가 불러도 냉장고에 자리가 있으면 요리해서 넣어 둘 수 있다(서버 assertCanCook와 같은 조건).
  const canCook =
    !!vitals && (vitals.stamina < vitals.maxStamina || vitals.meals.length < vitals.fridgeCapacity);

  async function eatMeal(id: number) {
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ dish: string; gained: number; vitals: Vitals }>(`/town/meals/${id}/eat`);
      update(r.vitals);
      setMessage(`😋 ${r.dish}을(를) 데워 먹었어요. 체력 +${r.gained}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "음식을 먹지 못했어요.");
    }
  }

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
          <p className="muted">
            {vitals.home
              ? `🏠 ${vitals.home} — 가만히 있어도 1시간에 체력이 ${vitals.regenPerHour}씩 차요.`
              : `📦 박스집 — 1시간에 체력이 ${vitals.regenPerHour}씩 차요. 집을 사면 더 빨리 차요.`}
          </p>
          <div className="cook-entry">
            <button className="ghost" onClick={() => setCooking(true)} disabled={sleeping || !!cookAt || !canCook}>
              🍳 요리하기 (리듬게임, 한 그릇 체력 최대 +{vitals.cookMaxGain})
            </button>
            <small className="muted">
              {cookAt
                ? `${hhmm(cookAt)} 이후에 다시 요리할 수 있어요.`
                : !canCook
                  ? vitals.fridgeCapacity > 0
                    ? "배도 부르고 냉장고도 가득 찼어요."
                    : "배가 불러서 지금은 요리할 필요가 없어요."
                  : vitals.fridgeCapacity > 0
                    ? "좋은 집일수록 든든한 요리가 나와요. 잘 만들면 가끔 여러 그릇이 생겨 냉장고에 넣어 둬요. 15분마다 한 번."
                    : "재료가 선에 닿을 때 맞춰 누를수록 맛있게(체력 많이) 만들어져요. 15분마다 한 번."}
            </small>
          </div>
          {vitals.fridgeCapacity > 0 && (
            <div className="fridge">
              <strong>
                🧊 냉장고 {vitals.meals.length}/{vitals.fridgeCapacity}
              </strong>
              {vitals.meals.length === 0 ? (
                <small className="muted">비어 있어요. 요리를 잘하면 남은 음식이 여기에 들어와요.</small>
              ) : (
                <ul className="fridge-list">
                  {vitals.meals.map((m) => (
                    <li key={m.id}>
                      <span>
                        {m.dish} <small className="muted">체력 +{m.stamina}</small>
                      </span>
                      <button
                        className="ghost"
                        onClick={() => eatMeal(m.id)}
                        disabled={sleeping || vitals.stamina >= vitals.maxStamina}
                      >
                        꺼내 먹기
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
      {cooking && (
        <CookingGame
          onDone={(v) => update(v)}
          onClose={() => setCooking(false)}
        />
      )}
    </div>
  );
}
