import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Vitals } from "../types";

// 내 집 요리 리듬게임: 재료(노트)가 3줄로 떨어지고, 판정선에 닿을 때 그 줄 버튼을 누른다.
// 채보는 서버가 만들어 주고(/town/cook/start), 끝나면 퍼펙트·굿 수를 보내 체력을 받는다(/town/cook/finish).
const PERFECT_MS = 90;
const GOOD_MS = 180;
const LEAD_MS = 1300; // 노트가 화면 위에서 판정선까지 떨어지는 시간
const HITLINE_PCT = 85; // 판정선 높이(무대 위에서부터 %)
const LANES = [
  { emoji: "🥕", key: "a" },
  { emoji: "🧅", key: "s" },
  { emoji: "🥚", key: "d" },
];

type Judge = "perfect" | "good" | "miss";
interface Note {
  t: number;
  lane: number;
  judged: Judge | null;
}
interface StartResp {
  sessionId: string;
  dish: string;
  songMs: number;
  lanes: number;
  notes: { t: number; lane: number }[];
  maxGain: number;
}

export function CookingGame({ onDone, onClose }: { onDone: (v: Vitals) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<"loading" | "playing" | "sending" | "result" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ dish: string; score: number; gained: number; portions: number; stored: number } | null>(null);
  const [, setTick] = useState(0); // 매 프레임 다시 그리기
  const [flash, setFlash] = useState<{ text: Judge; lane: number; at: number } | null>(null);
  const game = useRef<{ start: StartResp; notes: Note[]; t0: number; combo: number } | null>(null);
  const raf = useRef<number | null>(null);
  // 부모가 다시 그려져 onDone이 새 함수가 돼도 게임을 다시 시작하지 않도록 ref로 들고 있는다.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const elapsed = () => (game.current ? performance.now() - game.current.t0 : 0);

  const finish = useCallback(async () => {
    const g = game.current;
    if (!g) return;
    setPhase("sending");
    const perfect = g.notes.filter((n) => n.judged === "perfect").length;
    const good = g.notes.filter((n) => n.judged === "good").length;
    try {
      const r = await api.post<{ dish: string; score: number; gained: number; portions: number; stored: number; vitals: Vitals }>("/town/cook/finish", {
        sessionId: g.start.sessionId,
        perfect,
        good,
      });
      setResult(r);
      setPhase("result");
      onDoneRef.current(r.vitals);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "요리를 마치지 못했어요.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .post<StartResp>("/town/cook/start")
      .then((start) => {
        if (cancelled) return;
        game.current = { start, notes: start.notes.map((n) => ({ ...n, judged: null })), t0: performance.now(), combo: 0 };
        setPhase("playing");
        const loop = () => {
          const g = game.current!;
          const now = performance.now() - g.t0;
          // 판정선을 GOOD_MS 넘게 지나간 노트는 놓친 것
          for (const n of g.notes) if (!n.judged && now - n.t > GOOD_MS) {
            n.judged = "miss";
            g.combo = 0;
          }
          setTick((x) => x + 1);
          if (now >= start.songMs) {
            raf.current = null;
            void finish();
            return;
          }
          raf.current = requestAnimationFrame(loop);
        };
        raf.current = requestAnimationFrame(loop);
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "요리를 시작하지 못했어요.");
        setPhase("error");
      });
    return () => {
      cancelled = true;
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [finish]);

  const hit = useCallback((lane: number) => {
    const g = game.current;
    if (!g) return;
    const now = performance.now() - g.t0;
    // 이 줄에서 아직 판정 안 된 가장 가까운 노트
    let best: Note | null = null;
    for (const n of g.notes) {
      if (n.lane !== lane || n.judged) continue;
      if (Math.abs(n.t - now) <= GOOD_MS && (!best || Math.abs(n.t - now) < Math.abs(best.t - now))) best = n;
    }
    if (!best) return; // 헛손질은 벌점 없음
    const judge: Judge = Math.abs(best.t - now) <= PERFECT_MS ? "perfect" : "good";
    best.judged = judge;
    g.combo += 1;
    setFlash({ text: judge, lane, at: now });
  }, []);

  // PC: A·S·D 키
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const lane = LANES.findIndex((l) => l.key === e.key.toLowerCase());
      if (lane >= 0 && !e.repeat) hit(lane);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hit]);

  const g = game.current;
  const now = elapsed();
  const perfect = g?.notes.filter((n) => n.judged === "perfect").length ?? 0;
  const good = g?.notes.filter((n) => n.judged === "good").length ?? 0;
  const progress = g ? Math.min(1, now / g.start.songMs) : 0;

  return (
    <div className="modal-backdrop">
      <div className="modal cook-modal" onClick={(e) => e.stopPropagation()}>
        <h3>🍳 요리하기 {g && <span className="muted cook-dish">{g.start.dish}</span>}</h3>

        {phase === "loading" && <p className="muted">재료를 꺼내는 중…</p>}
        {phase === "error" && <p className="error">{error}</p>}

        {(phase === "playing" || phase === "sending") && g && (
          <>
            <div className="cook-hud">
              <span>🌟 퍼펙트 {perfect}</span>
              <span>👍 굿 {good}</span>
              <span>🔥 콤보 {g.combo}</span>
            </div>
            <div className="cook-progress">
              <div style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="cook-stage">
              {LANES.map((l, i) => (
                <div key={i} className="cook-lane" style={{ left: `${(i * 100) / LANES.length}%` }} />
              ))}
              {g.notes.map((n, i) => {
                if (n.judged === "perfect" || n.judged === "good") return null;
                const ahead = n.t - now; // 판정선까지 남은 시간
                if (ahead > LEAD_MS || ahead < -GOOD_MS) return null;
                const y = (1 - ahead / LEAD_MS) * HITLINE_PCT; // 0% 위 → 판정선
                return (
                  <span
                    key={i}
                    className={`cook-note${n.judged === "miss" ? " miss" : ""}`}
                    style={{ left: `${((n.lane + 0.5) * 100) / LANES.length}%`, top: `${y}%` }}
                  >
                    {LANES[n.lane].emoji}
                  </span>
                );
              })}
              <div className="cook-hitline" style={{ top: `${HITLINE_PCT}%` }} />
              {flash && now - flash.at < 400 && (
                <span className={`cook-judge ${flash.text}`} style={{ left: `${((flash.lane + 0.5) * 100) / LANES.length}%` }}>
                  {flash.text === "perfect" ? "퍼펙트!" : "굿"}
                </span>
              )}
            </div>
            <div className="cook-pads">
              {LANES.map((l, i) => (
                <button
                  key={i}
                  type="button"
                  className="cook-pad"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    hit(i);
                  }}
                >
                  {l.emoji}
                </button>
              ))}
            </div>
            <p className="muted cook-hint">재료가 선에 닿을 때 아래 버튼을 톡! (PC는 A·S·D)</p>
          </>
        )}

        {phase === "result" && result && (
          <div className="cook-result">
            <div className="cook-result-dish">{result.dish}</div>
            <p>
              점수 <b>{result.score}</b>점 → 💪 체력 <b>+{result.gained}</b>
            </p>
            {result.portions > 1 && <p className="ok-text">🍽️ 넉넉하게 {result.portions}그릇이 만들어졌어요!</p>}
            {result.stored > 0 && <p className="ok-text">🧊 {result.stored}그릇은 냉장고에 넣어 뒀어요. 쉬기 화면에서 꺼내 먹을 수 있어요.</p>}
            <p className="muted">
              {result.score >= 90 ? "요리사 뺨치는 솜씨예요!" : result.score >= 60 ? "먹을 만하게 됐어요." : "조금 탔지만 배는 불러요."}
            </p>
          </div>
        )}

        {phase !== "playing" && phase !== "sending" && (
          <button className="modal-close" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
    </div>
  );
}
