import { useEffect, useRef, useState } from "react";
import { requestVitalsRefresh } from "../vitalsEvents";
import { api, ApiError } from "../api";
import type { AlbaSpeedTier, MartCartItem, MartTxResp } from "../types";
import { ManagerPanel } from "./ManagerPanel";
import { NumberKeypad } from "./NumberKeypad";

// README 6.3: 마트 알바 — 손님이 산 물건을 계산해준다. 분급 지급 + 오차 100배 즉시 차감(하한 0원).
// 손님 카트(정답 금액)는 서버가 발급하고 보관한다 — 여기서는 입력한 금액만 보낸다.
// 스피드 보너스: 손님이 온 뒤 빨리 정확하게 계산할수록 분급 배수(×100~×3). 제한 시간이 지나면 손님이 떠난다.
// 시간 판정은 서버가 하고, 여기 타이머는 남은 시간과 지금 받을 수 있는 배수를 보여주는 용도다.
// 입력은 풀 키보드 대신 계산기형 숫자 키패드를 쓴다(계산 자체가 콘텐츠 본질이라 객관식은 쓰지 않는다).
// 배수별 칭찬 문구. ×50 이상은 진동까지 준다.
const PRAISE: Record<number, { text: string; vibrate?: number[] }> = {
  100: { text: "SUPER ULTRA GREAT!!", vibrate: [80, 40, 80, 40, 200] },
  50: { text: "ULTRA GREAT!", vibrate: [80, 40, 160] },
  30: { text: "GREAT!" },
  10: { text: "NICE!" },
  3: { text: "GOOD" },
};

export function AlbaPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [shift, setShift] = useState<{
    shiftId: number;
    perMinuteWage: number;
    timeLimitSec: number;
    speedTiers: AlbaSpeedTier[];
  } | null>(null);
  const [cart, setCart] = useState<MartCartItem[] | null>(null);
  const [entered, setEntered] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<MartTxResp | null>(null);
  const [summary, setSummary] = useState<{
    minutesWorked: number;
    totalWagePaid: number;
    totalPenalty: number;
    netPay: number;
    managerReacted: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 이번 손님이 떠나는 시각(로컬 ms)과 남은 시간(초, 0.1초 단위로 갱신)
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [leftNotice, setLeftNotice] = useState(false);
  const [praise, setPraise] = useState<{ key: number; mult: number } | null>(null);
  const timingOut = useRef(false);
  // 근무 시작/종료 때마다 올려서 점장 패널이 최신 상태(반응/제안)를 다시 불러오게 한다.
  const [managerKey, setManagerKey] = useState(0);

  function nextCustomer(nextCart: MartCartItem[], limitSec: number) {
    setCart(nextCart);
    setDeadline(Date.now() + limitSec * 1000);
    setRemaining(limitSec);
  }

  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setRemaining(Math.max(0, (deadline - Date.now()) / 1000)), 100);
    return () => window.clearInterval(id);
  }, [deadline]);

  // 시간이 다 되면 손님이 떠나고 다음 손님이 온다.
  useEffect(() => {
    if (!shift || deadline === null || remaining > 0 || busy || timingOut.current) return;
    timingOut.current = true;
    api
      .post<{ nextCart: MartCartItem[]; timeLimitSec: number }>("/alba/mart/timeout")
      .then((r) => {
        setEntered("");
        setLastTx(null);
        setLeftNotice(true);
        nextCustomer(r.nextCart, r.timeLimitSec);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "다음 손님을 부르지 못했습니다."))
      .finally(() => {
        timingOut.current = false;
      });
  }, [remaining, deadline, shift, busy]);

  function celebrate(mult: number) {
    const p = PRAISE[mult];
    if (!p) return;
    setPraise({ key: Date.now(), mult });
    if (p.vibrate) {
      try {
        navigator.vibrate?.(p.vibrate);
      } catch {
        // 진동을 지원하지 않는 기기(iOS 등)는 그냥 넘어간다.
      }
    }
  }

  useEffect(() => {
    if (!praise) return;
    const id = window.setTimeout(() => setPraise(null), 1400);
    return () => window.clearTimeout(id);
  }, [praise]);

  async function startShift() {
    setError(null);
    setSummary(null);
    setLastTx(null);
    try {
      const r = await api.post<{
        shiftId: number;
        perMinuteWage: number;
        cart: MartCartItem[];
        timeLimitSec: number;
        speedTiers: AlbaSpeedTier[];
      }>("/alba/mart/shift/start");
      setShift({ shiftId: r.shiftId, perMinuteWage: r.perMinuteWage, timeLimitSec: r.timeLimitSec, speedTiers: r.speedTiers });
      setLeftNotice(false);
      nextCustomer(r.cart, r.timeLimitSec);
      setManagerKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "근무를 시작할 수 없습니다.");
    }
  }

  async function submitTx() {
    if (!cart || busy || entered === "") return;
    setBusy(true);
    try {
      const r = await api.post<MartTxResp>("/alba/mart/transaction", {
        enteredAmount: Number(entered),
      });
      setLastTx(r);
      setLeftNotice(false);
      celebrate(r.speedMultiplier);
      requestVitalsRefresh(); // 손님 1명 = 1분 근무만큼 체력이 줄었다
      setEntered("");
      nextCustomer(r.nextCart, shift?.timeLimitSec ?? 20);
      // 특별 근무 중이면 점장 카드의 남은 건수/완료 상태를 갱신한다.
      if (r.rushRemaining !== null) setManagerKey((k) => k + 1);
      onBalanceChange();
    } catch (e) {
      // 서버 기준으로 이미 시간이 지났다면(409) 타이머를 0으로 돌려 다음 손님을 부르게 한다.
      if (e instanceof ApiError && e.status === 409) {
        setDeadline(Date.now());
        setRemaining(0);
      } else {
        setError(e instanceof ApiError ? e.message : "계산 처리에 실패했습니다.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function endShift() {
    try {
      const r = await api.post<{
        minutesWorked: number;
        totalWagePaid: number;
        totalPenalty: number;
        netPay: number;
        managerReacted: boolean;
      }>("/alba/mart/shift/end");
      setSummary(r);
      setShift(null);
      setCart(null);
      setDeadline(null);
      setEntered("");
      setManagerKey((k) => k + 1);
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "근무 종료에 실패했습니다.");
    }
  }

  return (
    <div className="panel">
      <h3>알바 (마트)</h3>
      <ManagerPanel refreshKey={managerKey} />
      {error && <p className="error">{error}</p>}

      {!shift && <button onClick={startShift}>근무 시작</button>}

      {shift && (
        <>
          <p className="muted">분급 {shift.perMinuteWage.toLocaleString()}원/분</p>
          {cart && (
            <div className="mart-form">
              <SpeedTimer remaining={remaining} limit={shift.timeLimitSec} tiers={shift.speedTiers} />
              {leftNotice && <p className="error">😤 손님이 기다리다 떠났어요. 다음 손님!</p>}
              <p>손님이 고른 물건:</p>
              <ul className="cart-list">
                {cart.map((i, idx) => (
                  <li key={idx}>
                    {i.name} — {i.price.toLocaleString()}원
                  </li>
                ))}
              </ul>
              <NumberKeypad value={entered} onChange={setEntered} onSubmit={submitTx} disabled={busy} />
            </div>
          )}
          {lastTx && (
            <p className={lastTx.penalty > 0 ? "error" : "ok-text"}>
              {lastTx.penalty > 0
                ? `오차 ${lastTx.errorAmount.toLocaleString()}원 → 페널티 ${lastTx.penaltyApplied.toLocaleString()}원${
                    lastTx.penaltyCapped ? " (이번 근무 급여까지만 차감)" : ""
                  }`
                : lastTx.speedMultiplier > 1
                ? `⚡ ${lastTx.elapsedSec}초 만에 정확하게! 분급 ×${lastTx.speedMultiplier}`
                : "정확하게 계산했습니다!"}{" "}
              (분급 +{lastTx.wagePaid.toLocaleString()}원
              {lastTx.wageMultiplier !== 1 && ` (×${lastTx.wageMultiplier})`}, 잔액{" "}
              {lastTx.balance.toLocaleString()}원) · 💪 체력 {lastTx.stamina}
            </p>
          )}
          <button className="ghost" onClick={endShift}>
            근무 종료
          </button>
        </>
      )}

      {praise && (
        <div key={praise.key} className={`alba-praise mult-${praise.mult}`} aria-live="assertive">
          <strong>{PRAISE[praise.mult].text}</strong>
          <span>분급 ×{praise.mult}</span>
        </div>
      )}

      {summary && (
        <p className="muted">
          {summary.minutesWorked}분 근무, 분급 총 {summary.totalWagePaid.toLocaleString()}원, 페널티
          총 {summary.totalPenalty.toLocaleString()}원 → 실수령 <b>{summary.netPay.toLocaleString()}원</b>
          {summary.netPay === 0 && summary.totalWagePaid > 0 && " (페널티가 급여를 넘어 0원으로 정산)"}
          {summary.managerReacted && " — 점장님이 근무 결과를 보고 한마디 남겼어요!"}
        </p>
      )}
    </div>
  );
}

// 남은 시간 막대 + "지금 맞히면 ×N" 표시. 구간 경계는 서버 판정과 같은 표(economy.ts ALBA_SPEED)를 쓴다.
function SpeedTimer({ remaining, limit, tiers }: { remaining: number; limit: number; tiers: AlbaSpeedTier[] }) {
  const elapsed = limit - remaining;
  const tier = tiers.find((t) => elapsed <= t.withinSec);
  const mult = tier?.multiplier ?? 1;
  const pct = Math.max(0, Math.min(100, (remaining / limit) * 100));
  return (
    <div className={`speed-timer mult-${mult}`}>
      <div className="speed-timer-row">
        <span className="speed-timer-mult">{mult > 1 ? `지금 맞히면 분급 ×${mult}` : "보너스 없음"}</span>
        <span className="speed-timer-sec">{remaining.toFixed(1)}초</span>
      </div>
      <div className="speed-timer-track">
        <div className="speed-timer-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
