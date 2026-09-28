import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ManagerChooseResp, ManagerPanelState } from "../types";

// 마트 점장 NPC(선택지형). 점장은 근무 기록에 따라 칭찬/보너스/경고/면담/특별 근무 제안을 하고,
// 플레이어는 서버가 내려준 선택지 버튼으로만 답한다. 신뢰도 등급에 따라 시급 배수가 달라진다.
const TIER_CLASS: Record<string, string> = { trusted: "trusted", normal: "normal", watch: "watch" };

// 이벤트 선택으로 걸린 "다음 N건" 임시 효과 이름
const MODIFIER_LABEL: Record<string, string> = { wage_scale: "💰 시급", penalty_scale: "⚠ 실수 벌금" };

export function ManagerPanel({ refreshKey }: { refreshKey: number }) {
  const [panel, setPanel] = useState<ManagerPanelState | null>(null);
  const [reply, setReply] = useState<{ text: string; trustChange: number } | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPanel(await api.get<ManagerPanelState>("/npc/manager"));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "점장 정보를 불러올 수 없습니다.");
    }
  }, []);

  useEffect(() => {
    setReply(null); // 새 근무 시작/종료 등으로 상황이 바뀌면 이전 답변 말풍선은 치운다
    load();
  }, [refreshKey, load]);

  async function choose(choiceKey: string) {
    if (!panel?.event || busy) return;
    setBusy(true);
    try {
      const r = await api.post<ManagerChooseResp>("/npc/manager/choose", {
        eventId: panel.event.id,
        choiceKey,
      });
      setReply({ text: r.reply, trustChange: r.trustChange });
      setPanel(r.panel);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "응답에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!panel) return error ? <p className="error">{error}</p> : null;

  // 말풍선: 방금 한 답변 > 답해야 할 이벤트 > 평소 인사 순서로 보여준다.
  const bubble = reply ? reply.text : panel.event ? panel.event.message : panel.greeting;

  return (
    <div className="manager-card">
      <div className="manager-head">
        <span className="manager-avatar">🧑‍💼</span>
        <div className="manager-id">
          <strong>{panel.npc.name}</strong>
          <small className="muted">{panel.npc.title}</small>
        </div>
        <div className="manager-chips">
          <span className={`chip tier-${TIER_CLASS[panel.tier.key]}`}>
            {panel.tier.label} · 시급 ×{panel.tier.wageMultiplier}
          </span>
          {panel.modifiers.map((m) => (
            <span key={m.kind} className="chip rush">
              {MODIFIER_LABEL[m.kind] ?? m.kind} ×{m.value} · {m.remaining}건
            </span>
          ))}
          {panel.task && (
            <span className="chip rush">
              🔥 특별 근무 남은 {panel.task.remaining}건 · ×{panel.task.wageMultiplier}
            </span>
          )}
        </div>
      </div>

      <div className="trust-row">
        <small className="muted">신뢰도</small>
        <div className="trust-bar">
          <div className={`trust-fill tier-${TIER_CLASS[panel.tier.key]}`} style={{ width: `${panel.trust}%` }} />
        </div>
        <small>{panel.trust}</small>
      </div>

      <div className="manager-bubble">
        <p>{bubble}</p>
        {reply && reply.trustChange !== 0 && (
          <small className={reply.trustChange > 0 ? "ok-text" : "error"}>
            신뢰도 {reply.trustChange > 0 ? "+" : ""}
            {reply.trustChange}
          </small>
        )}
      </div>

      {panel.event && (
        <div className="manager-choices">
          {panel.event.choices.map((c) => (
            <button key={c.key} className="ghost" disabled={busy} onClick={() => choose(c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <button className="ghost manager-rules-toggle" onClick={() => setShowRules((v) => !v)}>
        {showRules ? "평가 기준 닫기" : "점장은 무엇을 보고 평가하나요?"}
      </button>
      {showRules && (
        <ul className="manager-rules">
          {panel.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
