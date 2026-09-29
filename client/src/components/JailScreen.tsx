import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChatMessage } from "../types";
import { MAX_CHAT_LEN } from "../constants";

interface JailStatus {
  type: "jail" | "solitary";
  startedAt: string;
  endsAt: string;
}

// README 5장: 감옥(채팅 가능, 3시간) / 독방(검은 화면 + 타이머만, 1일)
export function JailScreen({ onReleased }: { onReleased: () => void }) {
  const [status, setStatus] = useState<JailStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [remaining, setRemaining] = useState(0);

  async function refresh() {
    const s = await api.get<JailStatus | null>("/jail/status");
    if (!s) {
      onReleased();
      return;
    }
    setStatus(s);
    if (s.type === "jail") {
      setMessages(await api.get<ChatMessage[]>("/jail/messages"));
    }
  }

  useEffect(() => {
    refresh();
    const poll = window.setInterval(refresh, 4000);
    return () => window.clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!status) return;
    const tick = () => {
      const ms = new Date(status.endsAt + "Z").getTime() - Date.now();
      setRemaining(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [status]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    await api.post("/jail/message", { content: input });
    setInput("");
    setMessages(await api.get<ChatMessage[]>("/jail/messages"));
  }

  if (!status) return null;

  const h = String(Math.floor(remaining / 3600)).padStart(2, "0");
  const m = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
  const s = String(remaining % 60).padStart(2, "0");

  if (status.type === "solitary") {
    return (
      <div className="solitary-screen">
        <div className="solitary-timer">
          {h}:{m}:{s}
        </div>
        <p>독방에서는 누구와도 소통할 수 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="jail-screen">
      <div className="jail-header">
        <h2>🔒 감옥</h2>
        <span className="timer">
          남은 시간 {h}:{m}:{s}
        </span>
      </div>
      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg ${msg.senderType}`}>
            <span className="sender">
              {msg.senderType === "system" ? "⚠️ 시스템" : msg.nickname ?? "수감자"}
            </span>
            <span className="content">{msg.content}</span>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_CHAT_LEN}
          placeholder="메시지를 입력하세요 (여기서도 3회 위반 시 독방행)"
        />
        {input.length >= MAX_CHAT_LEN - 50 && (
          <small className="char-count">
            {input.length}/{MAX_CHAT_LEN}
          </small>
        )}
        <button type="submit">보내기</button>
      </form>
    </div>
  );
}
