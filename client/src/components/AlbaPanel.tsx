import { useState } from "react";
import { requestVitalsRefresh } from "../vitalsEvents";
import { api, ApiError } from "../api";
import type { MartCartItem, MartTxResp } from "../types";
import { ManagerPanel } from "./ManagerPanel";
import { NumberKeypad } from "./NumberKeypad";

// README 6.3: 마트 알바 — 손님이 산 물건을 계산해준다. 분급 지급 + 오차 100배 즉시 차감(하한 0원).
// 손님 카트(정답 금액)는 서버가 발급하고 보관한다 — 여기서는 입력한 금액만 보낸다.
// 입력은 풀 키보드 대신 계산기형 숫자 키패드를 쓴다(계산 자체가 콘텐츠 본질이라 객관식은 쓰지 않는다).
export function AlbaPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [shift, setShift] = useState<{ shiftId: number; perMinuteWage: number } | null>(null);
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
  // 근무 시작/종료 때마다 올려서 점장 패널이 최신 상태(반응/제안)를 다시 불러오게 한다.
  const [managerKey, setManagerKey] = useState(0);

  async function startShift() {
    setError(null);
    setSummary(null);
    setLastTx(null);
    try {
      const r = await api.post<{ shiftId: number; perMinuteWage: number; cart: MartCartItem[] }>(
        "/alba/mart/shift/start"
      );
      setShift({ shiftId: r.shiftId, perMinuteWage: r.perMinuteWage });
      setCart(r.cart);
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
      requestVitalsRefresh(); // 손님 1명 = 1분 근무만큼 체력이 줄었다
      setEntered("");
      setCart(r.nextCart);
      // 특별 근무 중이면 점장 카드의 남은 건수/완료 상태를 갱신한다.
      if (r.rushRemaining !== null) setManagerKey((k) => k + 1);
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "계산 처리에 실패했습니다.");
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
