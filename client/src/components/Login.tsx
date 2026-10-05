import { useState } from "react";
import { api, ApiError, setToken } from "../api";
import { AvatarPicker } from "./AvatarPicker";
import { BirthPicker, birthComplete, markUnderage, underageLocked } from "./BirthPicker";

// README 1절: 비회원(게스트)으로 바로 플레이 가능. 저장(정식 계정 전환)은 원할 때 별도로.
// 새로 시작하거나 가입할 때 출생 연월을 받는다(자기 신고, 서버가 만 14세 미만 거부·성인/미성년자 구분).
// README 4.4: 최초 게임 시작 시 기본 아바타(남자/여자/동물) 또는 내 사진(영역 지정)을 프로필 사진으로 고를 수 있다.
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [nickname, setNickname] = useState("");
  const [mode, setMode] = useState<"guest" | "login" | "register">("guest");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [birthYm, setBirthYm] = useState("");
  const [locked, setLocked] = useState(underageLocked);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function onError(e: unknown) {
    if (e instanceof ApiError && e.code === "underage") {
      markUnderage();
      setLocked(true);
    }
    setError(e instanceof Error ? e.message : "요청에 실패했어요.");
  }

  async function submitGuest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token } = await api.post<{ token: string }>("/auth/guest", {
        nickname,
        avatarUrl,
        birthYm,
      });
      setToken(token);
      onAuthed();
    } catch (e: any) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const { token } = await api.post<{ token: string }>(path, {
        email,
        password,
        nickname: nickname || undefined,
        avatarUrl: mode === "register" ? avatarUrl : undefined,
        birthYm: mode === "register" ? birthYm : undefined,
      });
      setToken(token);
      onAuthed();
    } catch (e: any) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-card">
      <h1>인생 시뮬레이션 게임 (가칭)</h1>
      <p className="subtitle">현실은 박스집이어도, 게임에선 펜트하우스 — 그리고 진짜 인연까지</p>

      <div className="tabs">
        <button className={mode === "guest" ? "active" : ""} onClick={() => setMode("guest")}>
          비회원으로 시작
        </button>
        <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
          로그인
        </button>
        <button
          className={mode === "register" ? "active" : ""}
          onClick={() => setMode("register")}
        >
          회원가입
        </button>
      </div>

      {(mode === "guest" || mode === "register") && !locked && (
        <div className="avatar-picker-row">
          <div className="avatar" onClick={() => setPickerOpen(true)} title="클릭해서 프로필 사진 선택">
            {avatarUrl ? <img src={avatarUrl} alt="avatar" /> : <span>?</span>}
          </div>
          <button type="button" className="ghost" onClick={() => setPickerOpen(true)}>
            {avatarUrl ? "프로필 사진 변경" : "프로필 사진 선택"}
          </button>
        </div>
      )}

      {locked && mode !== "login" ? (
        <p className="error">만 14세 이상부터 이용할 수 있어요. 나중에 다시 찾아와 주세요!</p>
      ) : mode === "guest" ? (
        <form onSubmit={submitGuest}>
          <input
            placeholder="닉네임"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          <BirthPicker value={birthYm} onChange={setBirthYm} />
          <button type="submit" disabled={loading || !birthComplete(birthYm)}>
            게스트로 입장
          </button>
          <p className="hint">
            비회원 플레이는 저장되지 않습니다. 나중에 진행 내용을 저장하려면 회원가입으로
            전환하세요.
          </p>
        </form>
      ) : (
        <form onSubmit={submitAuth}>
          <input
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "register" && (
            <input
              placeholder="닉네임 (선택)"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          )}
          {mode === "register" && <BirthPicker value={birthYm} onChange={setBirthYm} />}
          <button type="submit" disabled={loading || (mode === "register" && !birthComplete(birthYm))}>
            {mode === "login" ? "로그인" : "회원가입"}
          </button>
        </form>
      )}
      {error && !(locked && mode !== "login") && <p className="error">{error}</p>}
      <p className="hint login-legal">
        <a href="/privacy" target="_blank" rel="noreferrer">개인정보처리방침</a> ·{" "}
        <a href="/account-deletion" target="_blank" rel="noreferrer">계정 삭제 안내</a>
      </p>

      {pickerOpen && (
        <AvatarPicker
          onSelect={(url) => {
            setAvatarUrl(url);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
