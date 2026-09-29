import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BossChooseResp, BossPanelState } from "../types";

// 직장 상사 NPC(선택지형). 주 1회 근무 기록으로 평가(S/A/B/C)하고, 좋은 평가가 연속되면 승진 심사를
// 요청할 수 있다. 직급이 오르면 일급 배수가 올라간다. 이번 평가 기간의 진행 상황을 미리 보여줘서
// 어떤 행동이 점수로 이어지는지 알 수 있게 한다. (점장 카드와 같은 스타일 클래스를 재사용한다)
export function BossPanel({
  refreshKey,
  onJob,
}: {
  refreshKey: number;
  onJob?: (jobId: number) => void;
}) {
  const [panel, setPanel] = useState<BossPanelState | null>(null);
  const [reply, setReply] = useState<{ text: string; promoted: boolean } | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await api.get<BossPanelState>("/npc/boss");
      setPanel(p);
      if (p.assigned) onJob?.(p.job.id);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "상사 정보를 불러올 수 없습니다.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setReply(null);
    load();
  }, [refreshKey, load]);

  async function choose(choiceKey: string) {
    if (!panel || !panel.assigned || !panel.event || busy) return;
    setBusy(true);
    try {
      const r = await api.post<BossChooseResp>("/npc/boss/choose", {
        eventId: panel.event.id,
        choiceKey,
      });
      setReply({ text: r.reply, promoted: r.promoted });
      setPanel(r.panel);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "응답에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!panel) return error ? <p className="error">{error}</p> : null;
  if (!panel.assigned) {
    return (
      <div className="manager-card">
        <div className="manager-head">
          <span className="manager-avatar">👔</span>
          <div className="manager-id">
            <strong>직장 상사</strong>
            <small className="muted">직장 상사</small>
          </div>
        </div>
        <div className="manager-bubble">
          <p>아직 소속이 없네요. 아래에서 직업을 배정받으면 제가 당신을 평가할 거예요.</p>
        </div>
      </div>
    );
  }

  const bubble = reply ? reply.text : panel.event ? panel.event.message : panel.greeting;
  const pr = panel.review.progress;

  return (
    <div className="manager-card">
      <div className="manager-head">
        <span className="manager-avatar">👔</span>
        <div className="manager-id">
          <strong>{panel.npc.name}</strong>
          <small className="muted">
            {panel.npc.title} · {panel.job.name}
          </small>
        </div>
        <div className="manager-chips">
          <span className={`chip${panel.rank.level > 1 ? " tier-trusted" : ""}`}>
            {panel.rank.title} · 일급 ×{panel.rank.payMultiplier}
          </span>
          {panel.streaks.good > 0 && <span className="chip rush">🔥 좋은 평가 {panel.streaks.good}회 연속</span>}
          {panel.streaks.bad > 0 && <span className="chip tier-watch">⚠ 부진 {panel.streaks.bad}회 연속</span>}
        </div>
      </div>

      <div className="review-progress">
        <div className="review-line">
          <small className="muted">
            다음 평가 {panel.review.daysLeft === 0 ? "오늘 이후 첫 접속" : `D-${panel.review.daysLeft}`} (
            {panel.review.nextDate})
          </small>
          <small>
            예상 {pr.attempts ? `${pr.projectedScore}점 ${pr.projectedGrade}` : "기록 없음"}
          </small>
        </div>
        <div className="trust-bar">
          <div className="trust-fill tier-trusted" style={{ width: `${pr.projectedScore}%` }} />
        </div>
        {panel.project && (
          <small className={panel.project.overtime >= panel.project.goal ? "ok-text" : "muted"}>
            🚨 긴급 프로젝트: 잔업 {panel.project.overtime}/{panel.project.goal}회
          </small>
        )}
        {panel.reputation.adjust !== 0 && (
          <small className={panel.reputation.adjust > 0 ? "ok-text" : "error"}>
            점장 평판(신뢰도 {panel.reputation.managerTrust}) → 평가 {panel.reputation.adjust > 0 ? "+" : ""}
            {panel.reputation.adjust}점
          </small>
        )}
        {panel.peers.adjust !== 0 && (
          <small className={panel.peers.adjust > 0 ? "ok-text" : "error"}>
            동료 평판(평균 신뢰도 {panel.peers.avgTrust}) → 평가 {panel.peers.adjust > 0 ? "+" : ""}
            {panel.peers.adjust}점
          </small>
        )}
        {panel.colleagueAdjust !== 0 && (
          <small className={panel.colleagueAdjust > 0 ? "ok-text" : "error"}>
            직장 동료 평가 {panel.colleagueAdjust > 0 ? "+" : ""}
            {panel.colleagueAdjust}점
          </small>
        )}
        <small className="muted">
          이번 기간: 정답률 {pr.accuracy}% · 근무 {pr.workDays}일 · 잔업 {pr.overtime}회 · 문제 {pr.attempts}개
        </small>
      </div>

      <div className="manager-bubble">
        <p>{bubble}</p>
        {reply?.promoted && <small className="ok-text">🎉 승진했어요!</small>}
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
        {showRules ? "평가 기준 닫기" : "상사는 무엇을 보고 평가하나요?"}
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
