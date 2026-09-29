import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api, getToken } from "../api";
import type { DmMessage } from "../types";
import { MiniProfileModal } from "./MiniProfileModal";

// README 11.3~11.5: 맞하트/열람권으로 열린 1:1 채팅. onJailed는 ref로만 참조해 부모 리렌더가
// 소켓을 불필요하게 재연결하지 않게 한다("버튼 클릭이 소켓을 재연결시켜 상태를 리셋하는" 문제를 피한다).
export function DmChat({
  targetId,
  targetNickname,
  onJailed,
}: {
  targetId: number;
  targetNickname: string;
  onJailed: () => void;
}) {
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const onJailedRef = useRef(onJailed);
  const listEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onJailedRef.current = onJailed;
  }, [onJailed]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);

    (async () => {
      try {
        const history = await api.get<DmMessage[]>(`/chat/messages/${targetId}`);
        if (!cancelled) setMessages(history);
      } catch {
        if (!cancelled) setError("대화 내역을 불러올 수 없습니다.");
      }
    })();

    const socket = io({ auth: { token: getToken() } });
    socketRef.current = socket;
    socket.emit("dm:join", targetId);
    socket.on("dm:message", (m: DmMessage) => {
      const from = m.fromId ?? m.from_id;
      const to = m.toId ?? m.to_id;
      if (from !== targetId && to !== targetId) return;
      setMessages((prev) => [...prev, m]);
    });
    socket.on("dm:error", (msg: string) => setError(msg));
    socket.on("room:jailed", () => onJailedRef.current());

    return () => {
      cancelled = true;
      socket.disconnect();
    };
  }, [targetId]);

  useEffect(() => {
    // scrollIntoView는 페이지(window)까지 끌어올려 상단 고정 버튼이 글자를 가리므로, 메시지 목록만 스크롤한다.
    const list = listEndRef.current?.parentElement;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    socketRef.current?.emit("dm:message", { targetId, content: input });
    setInput("");
  }

  return (
    <div className="dm-chat">
      <div className="chat-header">
        <h2>{targetNickname}님과의 대화</h2>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="chat-messages">
        {messages.map((m) => {
          const from = m.fromId ?? m.from_id;
          return (
            <div key={m.id} className={`chat-msg ${from === targetId ? "" : "me"}`}>
              <span className="sender">
                <button
                  type="button"
                  className="msg-avatar"
                  onClick={() => from != null && setProfileUserId(from)}
                  title="프로필 보기"
                >
                  {m.avatarUrl ? (
                    <img src={m.avatarUrl} alt="" />
                  ) : (
                    <span>{(m.nickname ?? "익명").slice(0, 1)}</span>
                  )}
                </button>
                <span className="sender-name">{m.nickname ?? "익명"}</span>
              </span>
              <span className="content">{m.content}</span>
            </div>
          );
        })}
        <div ref={listEndRef} />
      </div>

      {profileUserId != null && (
        <MiniProfileModal userId={profileUserId} onClose={() => setProfileUserId(null)} />
      )}
      <form className="chat-input" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="메시지를 입력하세요"
        />
        <button type="submit">보내기</button>
      </form>
    </div>
  );
}
