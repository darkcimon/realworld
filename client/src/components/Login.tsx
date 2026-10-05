import { useState } from "react";
import { api, setToken } from "../api";
import { AvatarPicker } from "./AvatarPicker";

// README 1절: 비회원(게스트)으로 바로 플레이 가능. 저장(정식 계정 전환)은 원할 때 별도로.
// 성인(만 18세 이상) 대상 게임이라 새로 시작하거나 가입할 때 연령 확인 체크를 받는다(서버도 확인).
// README 4.4: 최초 게임 시작 시 기본 아바타(남자/여자/동물) 또는 내 사진(영역 지정)을 프로필 사진으로 고를 수 있다.
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [nickname, setNickname] = useState("");
  const [mode, setMode] = useState<"guest" | "login" | "register">("guest");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [adult, setAdult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submitGuest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token } = await api.post<{ token: string }>("/auth/guest", {
        nickname,
        avatarUrl,
        adultConfirmed: adult,
      });
      setToken(token);
      onAuthed();
    } catch (e: any) {
      setError(e.message);
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
        adultConfirmed: mode === "register" ? adult : undefined,
      });
      setToken(token);
      onAuthed();
    } catch (e: any) {
      setError(e.message);
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

      {(mode === "guest" || mode === "register") && (
        <div className="avatar-picker-row">
          <div className="avatar" onClick={() => setPickerOpen(true)} title="클릭해서 프로필 사진 선택">
            {avatarUrl ? <img src={avatarUrl} alt="avatar" /> : <span>?</span>}
          </div>
          <button type="button" className="ghost" onClick={() => setPickerOpen(true)}>
            {avatarUrl ? "프로필 사진 변경" : "프로필 사진 선택"}
          </button>
        </div>
      )}

      {mode === "guest" ? (
        <form onSubmit={submitGuest}>
          <input
            placeholder="닉네임"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          <AdultCheck checked={adult} onChange={setAdult} />
          <button type="submit" disabled={loading || !adult}>
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
          {mode === "register" && <AdultCheck checked={adult} onChange={setAdult} />}
          <button type="submit" disabled={loading || (mode === "register" && !adult)}>
            {mode === "login" ? "로그인" : "회원가입"}
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}

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

function AdultCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="hint">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> 만 18세 이상이에요
      (연애·로또 콘텐츠가 있는 성인용 게임이에요)
    </label>
  );
}
