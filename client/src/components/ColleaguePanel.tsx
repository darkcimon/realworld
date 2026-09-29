import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type {
  ColleagueAction,
  ColleagueChatResp,
  ColleagueMessagesResp,
  ColleagueSummary,
  WorkplaceState,
} from "../types";

// 직장 동료 NPC(LLM 자유 대화). 회사 규모에 따라 조직도가 다르고(사장 1명 ~ 대리·과장·차장·이사),
// 누구와든 자유롭게 대화할 수 있다. 동료가 남기는 칭찬/경고 기록과 직속 상사의 평가 가감점은
// 서버가 권한·상한 안에서만 실행하고, 그 결과를 채팅 안에 시스템 메시지로 보여준다.
type ChatLine =
  | { kind: "msg"; id: number; sender: "player" | "npc"; content: string }
  | { kind: "system"; id: number; content: string; tone: "ok" | "bad" };

function actionText(a: ColleagueAction): { text: string; tone: "ok" | "bad" } {
  if (a.type === "praise") return { text: `👍 칭찬 기록: ${a.reason}`, tone: "ok" };
  if (a.type === "warning") return { text: `⚠ 경고 기록: ${a.reason}`, tone: "bad" };
  return {
    text: `📈 다음 평가 ${a.value > 0 ? "+" : ""}${a.value}점: ${a.reason}`,
    tone: a.value > 0 ? "ok" : "bad",
  };
}

function trustTier(trust: number): string {
  return trust >= 70 ? " tier-trusted" : trust < 30 ? " tier-watch" : "";
}

const SIZE_LABEL = { small: "소규모", medium: "중소기업", large: "대기업", professional: "전문직" } as const;

export function ColleaguePanel({ refreshKey, onChange }: { refreshKey: number; onChange?: () => void }) {
  const [state, setState] = useState<WorkplaceState | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.get<WorkplaceState>("/npc/colleagues"));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "동료 정보를 불러올 수 없습니다.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [refreshKey, load]);

  if (!state || !state.assigned) return error ? <p className="error">{error}</p> : null;
  const open = state.colleagues.find((c) => c.key === openKey) ?? null;

  return (
    <div className="manager-card">
      <div className="manager-head">
        <span className="manager-avatar">🏢</span>
        <div className="manager-id">
          <strong>{state.company}</strong>
          <small className="muted">
            {SIZE_LABEL[state.size]} · 동료 {state.colleagues.length}명
          </small>
        </div>
        <div className="manager-chips">
          {state.records.praise > 0 && <span className="chip tier-trusted">👍 칭찬 {state.records.praise}</span>}
          {state.records.warning > 0 && <span className="chip tier-watch">⚠ 경고 {state.records.warning}</span>}
          <span className="chip">
            오늘 대화 {state.remainingToday}/{state.dailyLimit}
          </span>
        </div>
      </div>

      {open ? (
        <ColleagueChat
          colleague={open}
          remaining={state.remainingToday}
          onBack={() => setOpenKey(null)}
          onUpdate={(evalChanged) => {
            load();
            if (evalChanged) onChange?.();
          }}
        />
      ) : (
        <ul className="colleague-list">
          {state.colleagues.map((c) => (
            <li key={c.key}>
              <button className="colleague-row" onClick={() => setOpenKey(c.key)}>
                <span className="manager-avatar">{c.avatar}</span>
                <span className="colleague-info">
                  <span>
                    <strong>{c.name}</strong> <small className="muted">{c.title}</small>
                    {c.directBoss && <span className="chip colleague-boss">직속 상사</span>}
                  </span>
                  <small className="muted colleague-last">
                    {c.lastMessage
                      ? `${c.lastMessage.sender === "player" ? "나: " : ""}${c.lastMessage.content}`
                      : c.relation}
                  </small>
                  <span className="trust-row">
                    <span className="trust-bar">
                      <span className={`trust-fill${trustTier(c.trust)}`} style={{ width: `${c.trust}%`, display: "block" }} />
                    </span>
                    <small className="muted">신뢰 {c.trust}</small>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.evalAdjust.current !== 0 && (
        <small className={state.evalAdjust.current > 0 ? "ok-text" : "error"}>
          이번 평가 기간 동료 평가 {state.evalAdjust.current > 0 ? "+" : ""}
          {state.evalAdjust.current}점 (한도 ±{state.evalAdjust.cap})
        </small>
      )}

      <button className="ghost manager-rules-toggle" onClick={() => setShowRules((v) => !v)}>
        {showRules ? "규칙 닫기" : "동료들은 무엇을 할 수 있나요?"}
      </button>
      {showRules && (
        <ul className="manager-rules">
          {state.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ColleagueChat({
  colleague,
  remaining,
  onBack,
  onUpdate,
}: {
  colleague: ColleagueSummary;
  remaining: number;
  onBack: () => void;
  onUpdate: (evalChanged: boolean) => void;
}) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [trust, setTrust] = useState(colleague.trust);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seq = useRef(-1); // 로컬 전용 줄(시스템 메시지/전송 중 내 메시지)의 음수 id

  useEffect(() => {
    let cancelled = false;
    api
      .get<ColleagueMessagesResp>(`/npc/colleagues/${colleague.key}/messages`)
      .then((r) => {
        if (cancelled) return;
        setLines(r.messages.map((m) => ({ kind: "msg", id: m.id, sender: m.sender, content: m.content })));
        setTrust(r.trust);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "대화를 불러올 수 없습니다."));
    return () => {
      cancelled = true;
    };
  }, [colleague.key]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setLines((l) => [...l, { kind: "msg", id: seq.current--, sender: "player", content: message }]);
    try {
      const r = await api.post<ColleagueChatResp>(`/npc/colleagues/${colleague.key}/chat`, { message });
      const added: ChatLine[] = [{ kind: "msg", id: seq.current--, sender: "npc", content: r.reply }];
      if (r.action) {
        const { text, tone } = actionText(r.action);
        added.push({ kind: "system", id: seq.current--, content: text, tone });
      }
      if (r.violation) {
        added.push({
          kind: "system",
          id: seq.current--,
          content: r.violation.jailed
            ? "금지 행위가 3회 누적되어 감옥으로 이동합니다."
            : `금지 행위 경고 (${r.violation.level}/3): 욕설/음담패설은 삼가주세요.`,
          tone: "bad",
        });
      }
      setLines((l) => [...l, ...added]);
      setTrust(r.trust);
      onUpdate(r.action?.type === "eval_adjust");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "메시지를 보내지 못했습니다.");
      setInput(message);
      setLines((l) => l.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dm-chat colleague-chat">
      <div className="chat-header">
        <h2>
          {colleague.avatar} {colleague.name} <small className="muted">{colleague.title}</small>
        </h2>
        <div className="chat-header-actions">
          <span className={`chip${trustTier(trust)}`}>신뢰 {trust}</span>
          <button className="ghost" onClick={onBack}>
            목록
          </button>
        </div>
      </div>
      <div className="chat-messages">
        {lines.length === 0 && !busy && <small className="muted">{colleague.relation}에게 먼저 말을 걸어보세요.</small>}
        {lines.map((line) =>
          line.kind === "system" ? (
            <div key={line.id} className={`chat-msg system colleague-action ${line.tone}`}>
              <span className="content">{line.content}</span>
            </div>
          ) : (
            <div key={line.id} className={`chat-msg${line.sender === "player" ? " me" : ""}`}>
              <span className="content">{line.content}</span>
            </div>
          )
        )}
        {busy && (
          <div className="chat-msg">
            <span className="content muted">…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {error && <p className="error colleague-error">{error}</p>}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          maxLength={200}
          placeholder={remaining > 0 ? `${colleague.name}에게 말하기` : "오늘 대화 횟수를 다 썼어요"}
          disabled={busy || remaining <= 0}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" disabled={busy || remaining <= 0 || !input.trim()}>
          보내기
        </button>
      </form>
    </div>
  );
}
