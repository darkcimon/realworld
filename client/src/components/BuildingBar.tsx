import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Building, BuildingsResp } from "../types";
import { confirmDialog } from "./ConfirmDialog";
import { feedback } from "../feedback";

// 시설 인수(건물주): 시설 화면 맨 위에 건물주와 효과를 보여주고, 인수·매수 제안·강제 인수·금고 수령을 한다.
// 수치와 규칙은 서버 economy.ts BUILDINGS. 금고는 그 건물에 와 있어야 열 수 있어서 이 바에서만 받는다.

/** 큰 금액을 "5,000억원", "1조 2,000억원"처럼 읽기 쉽게. */
export function bigWon(n: number): string {
  const jo = Math.floor(n / 1e12);
  const eok = Math.floor((n % 1e12) / 1e8);
  if (jo > 0) return `${jo.toLocaleString()}조${eok ? ` ${eok.toLocaleString()}억` : ""}원`;
  if (eok > 0) return `${eok.toLocaleString()}억원`;
  return `${n.toLocaleString()}원`;
}

function timeLeft(iso: string): string {
  const m = Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간` : `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

export function BuildingBar({ facility, onBalanceChange }: { facility: string; onBalanceChange?: () => void }) {
  const [data, setData] = useState<BuildingsResp | null>(null);
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api.get<BuildingsResp>("/buildings"));
    } catch {
      // 건물 정보가 안 와도 시설 이용은 그대로 할 수 있게 조용히 넘긴다
    }
  }

  useEffect(() => {
    load();
  }, [facility]);

  const b: Building | undefined = data?.buildings.find((x) => x.facility === facility);
  if (!data || !b) return null;

  async function run(fn: () => Promise<string>, fallback: string) {
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
      onBalanceChange?.();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    }
  }

  const full = data.myCount >= data.maxPerUser;

  const buy = () =>
    run(async () => {
      if (!(await confirmDialog(`${b.label} 건물을 ${bigWon(b.price)}에 인수할까요?`, { confirmText: "인수하기" }))) return "";
      await api.post(`/buildings/${facility}/buy`);
      feedback("coin");
      return `🏢 이제 ${b.label} 건물주예요!`;
    }, "인수하지 못했어요.");

  const takeover = () =>
    run(async () => {
      const ok = await confirmDialog(
        `${b.owner!.nickname}님에게 ${bigWon(b.takeoverPrice)}을 주고 ${b.label} 건물을 바로 가져올까요?`,
        { title: "강제 인수", confirmText: "강제 인수" }
      );
      if (!ok) return "";
      await api.post(`/buildings/${facility}/takeover`);
      feedback("coin");
      return `🏢 ${b.label} 건물을 강제 인수했어요!`;
    }, "강제 인수하지 못했어요.");

  const sendOffer = () =>
    run(async () => {
      // 입력은 억 단위(조 단위 금액을 원으로 다 치기 어렵다)
      await api.post(`/buildings/${facility}/offer`, { amount: Math.round(Number(offer) * 1e8) });
      setOffer("");
      return "📨 매수 제안을 보냈어요. 건물주가 답하면 알림이 와요.";
    }, "제안하지 못했어요.");

  const cancelOffer = (id: number) =>
    run(async () => {
      await api.post(`/buildings/offers/${id}/cancel`);
      return "제안을 취소했어요.";
    }, "취소하지 못했어요.");

  const answer = (id: number, accept: boolean, buyer: string, amount: number) =>
    run(async () => {
      if (accept && !(await confirmDialog(`${buyer}님에게 ${bigWon(amount)}에 건물을 넘길까요?`, { confirmText: "팔기" }))) return "";
      await api.post(`/buildings/offers/${id}/${accept ? "accept" : "reject"}`);
      if (accept) feedback("coin");
      return accept ? `🤝 ${bigWon(amount)}에 건물을 팔았어요.` : "제안을 거절했어요.";
    }, "답하지 못했어요.");

  const collect = () =>
    run(async () => {
      const r = await api.post<{ collected: number }>(`/buildings/${facility}/collect`);
      feedback("coin");
      return `💰 금고에서 ${r.collected.toLocaleString()}원을 꺼냈어요.`;
    }, "금고를 열지 못했어요.");

  return (
    <div className="building-bar">
      <button className="building-summary" onClick={() => setOpen((v) => !v)}>
        <span>
          🏢 건물주: <strong>{b.owner ? b.owner.nickname : "없음"}</strong>
          {b.mine && b.vault! > 0 && <span className="building-vault"> · 금고 {b.vault!.toLocaleString()}원</span>}
          {b.mine && b.incomingOffers.length > 0 && <span className="badge">제안 {b.incomingOffers.length}</span>}
        </span>
        <span className="muted">{open ? "닫기 ▲" : "자세히 ▼"}</span>
      </button>

      {open && (
        <div className="building-detail">
          <p className="muted">
            효과: {b.effect}. 수익은 이 건물 금고에 쌓이고, 건물주가 직접 와야 꺼낼 수 있어요. 건물주 본인의 이용은 수익이
            되지 않아요.
          </p>
          {error && <p className="error">{error}</p>}
          {message && <p className="ok-text">{message}</p>}

          {b.mine ? (
            <>
              <p>
                💰 금고 <strong>{b.vault!.toLocaleString()}원</strong>
                <span className="muted"> (인수 후 누적 {b.earnedTotal!.toLocaleString()}원)</span>
              </p>
              <button onClick={collect} disabled={b.vault! <= 0}>
                금고 열기
              </button>
              {b.protectedUntil && <p className="muted">🛡️ 강제 인수 보호: {timeLeft(b.protectedUntil)} 남음</p>}
              <h4>받은 매수 제안</h4>
              {b.incomingOffers.length === 0 && <p className="muted">아직 없어요.</p>}
              <ul className="ledger-list">
                {b.incomingOffers.map((o) => (
                  <li key={o.id}>
                    <span>
                      {o.buyer} · {bigWon(o.amount)}
                    </span>
                    <span className="building-actions">
                      <button onClick={() => answer(o.id, true, o.buyer, o.amount)}>수락</button>
                      <button className="ghost" onClick={() => answer(o.id, false, o.buyer, o.amount)}>
                        거절
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : !b.owner ? (
            <>
              <p>
                인수 가격 <strong>{bigWon(b.price)}</strong>
              </p>
              <button onClick={buy} disabled={full}>
                정가에 인수하기
              </button>
            </>
          ) : (
            <>
              <p className="muted">
                정가 {bigWon(b.price)} · 매수 제안은 {bigWon(b.offerMin)} ~ {bigWon(b.offerMax)}, {data.offerExpireHours}시간 안에
                답이 없으면 사라져요.
              </p>
              {b.myOffer ? (
                <p>
                  📨 보낸 제안: {bigWon(b.myOffer.amount)}{" "}
                  <button className="ghost" onClick={() => cancelOffer(b.myOffer!.id)}>
                    취소
                  </button>
                </p>
              ) : (
                <div className="lottery-form">
                  <input
                    type="number"
                    min={b.offerMin / 1e8}
                    max={b.offerMax / 1e8}
                    value={offer}
                    onChange={(e) => setOffer(e.target.value)}
                    placeholder="제안 금액(억 원)"
                  />
                  <button onClick={sendOffer} disabled={!offer || full}>
                    매수 제안
                  </button>
                </div>
              )}
              <button onClick={takeover} disabled={!!b.protectedUntil || full}>
                강제 인수 ({bigWon(b.takeoverPrice)})
              </button>
              {b.protectedUntil && <p className="muted">🛡️ 인수한 지 얼마 안 돼 {timeLeft(b.protectedUntil)} 뒤부터 강제 인수할 수 있어요.</p>}
            </>
          )}
          {!b.mine && full && <p className="muted">건물은 한 사람이 {data.maxPerUser}채까지만 가질 수 있어요.</p>}
        </div>
      )}
    </div>
  );
}
