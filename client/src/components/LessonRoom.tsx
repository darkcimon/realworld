import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BoardCommand, LessonAskResp, LessonMessage, LessonStartResp } from "../types";
import { Blackboard } from "./Blackboard";
import { MAX_CHAT_LEN } from "../constants";

// 방에 입장하면 이 학생만을 위한 주제 + 칠판으로 개인 수업이 시작된다. 강의 시간 제한이나
// 자유 토론 단계는 없다 — 원하는 만큼 질문하고, 준비되면 언제든 승급 시험에 응시하면 된다.
// 원하면 언제든 4.2.4의 단체 수업(다른 학생들과 함께하는 채팅방)으로 옮겨갈 수도 있다.
export function LessonRoom({
  roomId,
  roomLabel,
  onExit,
  onOpenExam,
  onJoinGroup,
}: {
  roomId: number;
  roomLabel: string;
  onExit: () => void;
  onOpenExam: () => void;
  onJoinGroup: () => void;
}) {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [messages, setMessages] = useState<LessonMessage[]>([]);
  const [board, setBoard] = useState<BoardCommand[]>([]);
  const [boardOpen, setBoardOpen] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const listEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await api.post<LessonStartResp>(`/lesson/rooms/${roomId}/start`);
        if (cancelled) return;
        setSessionId(resp.sessionId);
        setTopic(resp.topic);
        setMessages(resp.messages);
        setBoard(resp.board);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "수업을 시작하지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    // scrollIntoView는 페이지(window)까지 끌어올려 상단 고정 버튼이 글자를 가리므로, 메시지 목록만 스크롤한다.
    const list = listEndRef.current?.parentElement;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || !sessionId || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    setMessages((prev) => [...prev, { id: Date.now(), senderType: "student", content: question }]);
    try {
      const resp = await api.post<LessonAskResp>(`/lesson/sessions/${sessionId}/ask`, { question });
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, senderType: "ai_teacher", content: resp.reply, board: resp.board },
      ]);
      if (resp.board) setBoard(resp.board);
    } catch (e: any) {
      setError(e.message ?? "답변을 받지 못했습니다.");
    } finally {
      setSending(false);
    }
  }

  // 종료 API가 실패해도(네트워크 문제 등) 화면 전환 자체는 막지 않는다 — 방치된 세션은
  // 서버에서 자동으로 종료 처리된다.
  async function endAndGo(after: () => void) {
    if (sessionId) {
      try {
        await api.post(`/lesson/sessions/${sessionId}/end`);
      } catch {
        // 무시
      }
    }
    after();
  }

  if (loading) {
    return (
      <div className="center-msg">{error ? <p className="error">{error}</p> : <p>수업을 준비하는 중...</p>}</div>
    );
  }

  return (
    <div className="chat-room lesson-room">
      <div className="chat-header">
        <div>
          <h2>{roomLabel} · 개인 수업</h2>
          {topic && <div className="chat-topic">📚 오늘의 주제: {topic}</div>}
        </div>
        <div className="chat-header-actions">
          <button
            className="icon-btn ghost"
            onClick={() => setBoardOpen((v) => !v)}
            title={boardOpen ? "칠판 숨기기" : "칠판 보기"}
          >
            🖼️ 칠판
          </button>
          <button className="icon-btn" onClick={onOpenExam} title="승급 시험 응시">
            📝 시험
          </button>
          <button
            className="icon-btn ghost"
            onClick={() => endAndGo(onJoinGroup)}
            title="친구들과 함께 수업하기"
          >
            👥 단체
          </button>
          <button className="icon-btn ghost" onClick={() => endAndGo(onExit)} title="나가기">
            🚪 종료
          </button>
        </div>
      </div>

      {boardOpen && <Blackboard commands={board} />}

      {error && <p className="error lesson-error">{error}</p>}

      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.senderType === "student" ? "me" : "ai_teacher"}`}>
            <span className="sender">
              <span className="sender-name">{m.senderType === "ai_teacher" ? "🧑‍🏫 AI 선생님" : "나"}</span>
            </span>
            <span className="content">{m.content}</span>
          </div>
        ))}
        <div ref={listEndRef} />
      </div>

      <form className="chat-input" onSubmit={ask}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_CHAT_LEN}
          placeholder="궁금한 점을 질문해보세요"
          disabled={sending}
        />
        {input.length >= MAX_CHAT_LEN - 50 && (
          <small className="char-count">
            {input.length}/{MAX_CHAT_LEN}
          </small>
        )}
        <button type="submit" disabled={sending || !input.trim()}>
          {sending ? "..." : "보내기"}
        </button>
      </form>
    </div>
  );
}
