import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api, getToken } from "../api";
import type { ChatMessage } from "../types";
import { MiniProfileModal } from "./MiniProfileModal";
import { MAX_CHAT_LEN } from "../constants";

interface VoteState {
  candidates: string[];
  endsAt: number;
  tally: number[];
  myChoice: number | null;
}

// README 4.2.4: 반 전체가 함께 쓰는 단체 채팅방 — 같은 학년의 다른 학생들과 자유롭게
// 대화할 수 있다. 승급 시험은 이 방 참여 여부와 무관하게 언제든 응시 가능하다.
// onBackToLesson으로 언제든 다시 개인 수업(1:1)으로 돌아갈 수 있다.
export function ChatRoom({
  roomId,
  roomLabel,
  onExit,
  onJailed,
  onOpenExam,
  onBackToLesson,
}: {
  roomId: number;
  roomLabel: string;
  onExit: () => void;
  onJailed: () => void;
  onOpenExam: () => void;
  onBackToLesson: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [participantCount, setParticipantCount] = useState<number | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeInput, setProposeInput] = useState("");
  const [proposeNotice, setProposeNotice] = useState<string | null>(null);
  const [vote, setVote] = useState<VoteState | null>(null);
  const [voteRemaining, setVoteRemaining] = useState(0);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  // onJailed는 App이 리렌더될 때마다 새 함수 레퍼런스로 내려온다(App.tsx의 인라인 콜백).
  // 아래 join effect의 의존성에 onJailed를 직접 넣으면 불필요한 재연결이 생길 수 있어
  // ref로 최신 값만 참조하고 effect는 roomId에만 반응시킨다.
  const onJailedRef = useRef(onJailed);
  useEffect(() => {
    onJailedRef.current = onJailed;
  }, [onJailed]);

  useEffect(() => {
    let cancelled = false;
    setVote(null);
    setProposeNotice(null);

    (async () => {
      const joinResp = await api.post<{ topic?: string }>(`/school/rooms/${roomId}/join`);
      if (!cancelled && joinResp.topic) setTopic(joinResp.topic);
      const history = await api.get<ChatMessage[]>(`/school/rooms/${roomId}/messages`);
      if (!cancelled) setMessages(history);
    })();

    const socket = io({ auth: { token: getToken() } });
    socketRef.current = socket;
    // "connect"는 최초 접속뿐 아니라 재접속(네트워크 끊김, 휴대폰 화면 꺼짐, 서버 재시작 등)
    // 때마다 매번 발생한다. 매 접속마다 다시 join해야 서버 쪽 Socket.IO room 멤버십을
    // 다시 얻는다 — 안 그러면 재접속된 소켓은 메시지를 보내도 자기 메시지조차 되돌아오지 않는다.
    socket.on("connect", () => socket.emit("room:join", roomId));
    socket.on("room:message", (m: ChatMessage) => {
      if (m.roomId && m.roomId !== roomId) return;
      setMessages((prev) => [...prev, m]);
    });
    socket.on("room:jailed", () => onJailedRef.current());
    socket.on("room:error", (msg: string) => console.warn("room:error", msg));
    socket.on("room:presence", (p: { roomId: number; count: number }) => {
      if (p.roomId === roomId) setParticipantCount(p.count);
    });

    // 학습 주제 투표(README 4.2.4: "참여자들의 투표로 주제 선정") — 2명 이상이 서로 다른
    // 주제를 제안하면 서버가 바로 투표를 열어준다.
    socket.on(
      "topic:vote_started",
      (v: { roomId: number; candidates: string[]; endsAt: number }) => {
        if (v.roomId !== roomId) return;
        setProposeOpen(false);
        setProposeNotice(null);
        setVote({ candidates: v.candidates, endsAt: v.endsAt, tally: v.candidates.map(() => 0), myChoice: null });
      }
    );
    socket.on("topic:vote_tally", (v: { roomId: number; tally: number[] }) => {
      if (v.roomId !== roomId) return;
      setVote((prev) => (prev ? { ...prev, tally: v.tally } : prev));
    });
    socket.on(
      "topic:vote_result",
      (v: { roomId: number; topic: string }) => {
        if (v.roomId !== roomId) return;
        setTopic(v.topic);
        setVote(null);
      }
    );
    socket.on("topic:proposed", (r: { waitingForOthers?: boolean }) => {
      setProposeNotice(
        r.waitingForOthers
          ? "제안 완료! 다른 사람이 다른 주제를 제안하면 투표가 시작돼요."
          : "제안했습니다."
      );
    });
    socket.on("topic:error", (msg: string) => setProposeNotice(msg));

    return () => {
      cancelled = true;
      socket.disconnect();
    };
  }, [roomId]);

  useEffect(() => {
    // scrollIntoView는 페이지(window)까지 끌어올려 상단 고정 버튼이 글자를 가리므로, 메시지 목록만 스크롤한다.
    const list = listEndRef.current?.parentElement;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // 투표 남은 시간 카운트다운
  useEffect(() => {
    if (!vote) return;
    const tick = () => setVoteRemaining(Math.max(0, Math.ceil((vote.endsAt - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [vote?.endsAt]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    socketRef.current?.emit("room:message", { roomId, content: input });
    setInput("");
  }

  function proposeTopic(e: React.FormEvent) {
    e.preventDefault();
    const text = proposeInput.trim();
    if (!text) return;
    socketRef.current?.emit("topic:propose", { roomId, topic: text });
    setProposeInput("");
  }

  function castVote(choice: number) {
    socketRef.current?.emit("topic:vote", { roomId, choice });
    setVote((prev) => (prev ? { ...prev, myChoice: choice } : prev));
  }

  async function leave() {
    await api.post(`/school/rooms/${roomId}/leave`);
    onExit();
  }

  return (
    <div className="chat-room">
      <div className="chat-header">
        <div>
          <h2>{roomLabel} · 단체 수업</h2>
          {topic && <div className="chat-topic">📚 오늘의 주제: {topic}</div>}
        </div>
        <div className="chat-header-actions">
          <span className="chat-header-count" title="지금 이 수업에 참여 중인 인원">
            👥 {participantCount ?? "-"}명
          </span>
          <button className="icon-btn ghost" onClick={onBackToLesson} title="개인 수업으로 돌아가기">
            🧑‍🏫 개인
          </button>
          <button className="icon-btn" onClick={onOpenExam} title="승급 시험 응시">
            📝 시험
          </button>
          <button className="icon-btn ghost" onClick={leave} title="나가기">
            🚪 종료
          </button>
        </div>
      </div>

      {vote ? (
        <div className="vote-panel">
          <p>🗳️ 주제 투표 중 — {voteRemaining}초 남음</p>
          <div className="vote-candidates">
            {vote.candidates.map((c, i) => (
              <button
                key={c}
                className={vote.myChoice === i ? "" : "ghost"}
                onClick={() => castVote(i)}
              >
                {c} ({vote.tally[i] ?? 0}표)
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="topic-propose">
          {proposeOpen ? (
            <form onSubmit={proposeTopic}>
              <input
                autoFocus
                value={proposeInput}
                onChange={(e) => setProposeInput(e.target.value)}
                placeholder="이야기하고 싶은 주제를 적어주세요"
              />
              <button type="submit">제안</button>
              <button type="button" className="ghost" onClick={() => setProposeOpen(false)}>
                취소
              </button>
            </form>
          ) : (
            <button className="ghost" onClick={() => setProposeOpen(true)}>
              💡 다른 주제 제안하기
            </button>
          )}
          {proposeNotice && <p className="muted">{proposeNotice}</p>}
        </div>
      )}

      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.senderType}`}>
            <span className="sender">
              {m.senderType === "user" && (
                // README 4.4/11: 트위터 아이콘처럼, 채팅 속 프로필 사진을 눌러 그 사람의 프로필을 볼 수 있게 한다.
                <button
                  type="button"
                  className="msg-avatar"
                  onClick={() => m.userId != null && setProfileUserId(m.userId)}
                  title="프로필 보기"
                >
                  {m.avatarUrl ? (
                    <img src={m.avatarUrl} alt="" />
                  ) : (
                    <span>{(m.nickname ?? "학생").slice(0, 1)}</span>
                  )}
                </button>
              )}
              <span className="sender-name">
                {m.senderType === "ai_teacher"
                  ? "🧑‍🏫 AI 선생님"
                  : m.senderType === "system"
                  ? "⚠️ 시스템"
                  : m.nickname ?? "학생"}
              </span>
            </span>
            <span className="content">{m.content}</span>
          </div>
        ))}
        <div ref={listEndRef} />
      </div>

      {profileUserId != null && (
        <MiniProfileModal userId={profileUserId} onClose={() => setProfileUserId(null)} />
      )}

      <form className="chat-input" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_CHAT_LEN}
          placeholder="메시지를 입력하세요"
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
