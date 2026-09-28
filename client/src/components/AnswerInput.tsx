import { useState } from "react";

// 시험/배치고사/근무 공용 답안 입력. 기본은 객관식 버튼(탭 한 번으로 제출)이고, 원하면
// "직접 입력"으로 전환해 서술형으로도 답할 수 있다(README 4.3/6.2 — 타이핑 마찰 감소).
// 채점은 서버가 정답 텍스트와 비교하므로 어떤 방식으로 제출해도 결과는 같다.
export function AnswerInput({
  choices,
  onSubmit,
}: {
  choices?: string[];
  onSubmit: (answer: string) => Promise<void> | void;
}) {
  const hasChoices = !!choices && choices.length >= 2;
  const [typing, setTyping] = useState(!hasChoices);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(answer: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(answer);
      setText("");
    } finally {
      setBusy(false);
    }
  }

  if (hasChoices && !typing) {
    return (
      <div className="answer-choices">
        {choices!.map((c, i) => (
          <button key={c} type="button" className="choice-btn" disabled={busy} onClick={() => send(c)}>
            <span className="choice-no">{i + 1}</span>
            {c}
          </button>
        ))}
        <button type="button" className="ghost choice-toggle" onClick={() => setTyping(true)}>
          ⌨️ 직접 입력하기
        </button>
      </div>
    );
  }

  return (
    <form
      className="answer-typing"
      onSubmit={(e) => {
        e.preventDefault();
        send(text);
      }}
    >
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="정답 입력" />
      <button type="submit" disabled={busy}>
        제출
      </button>
      {hasChoices && (
        <button type="button" className="ghost choice-toggle" onClick={() => setTyping(false)}>
          🔘 보기에서 고르기
        </button>
      )}
    </form>
  );
}
