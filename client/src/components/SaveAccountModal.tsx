import { useState } from "react";
import { api, ApiError, setToken } from "../api";

// 비회원 → 정식 계정 전환(게임 안에서). 지금 비회원 토큰을 단 채로 /auth/register를 부르면 서버가
// 새 계정을 만들지 않고 이 비회원 계정을 그대로 회원으로 바꾼다 — 학년·돈·자산이 모두 이어진다.
// (로그아웃 후 로그인 화면에서 가입하면 토큰이 없어 빈 새 계정이 만들어지므로 꼭 여기서 해야 한다.)
export function SaveAccountModal({
  reason,
  onSaved,
  onClose,
}: {
  reason?: string; // 가입 유도로 띄웠을 때 맨 위에 보여줄 안내
  onSaved: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) return setError("비밀번호는 6자 이상으로 정해주세요.");
    if (password !== password2) return setError("비밀번호 확인이 일치하지 않습니다.");
    setBusy(true);
    try {
      const r = await api.post<{ token: string; upgraded?: boolean }>("/auth/register", { email, password });
      setToken(r.token);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "계정 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal save-account-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>💾 내 진행 저장하기</h3>
        {reason && <p className="save-account-reason">{reason}</p>}
        <p className="muted">
          지금은 비회원이라 이 브라우저에만 저장돼 있어요. 브라우저 데이터를 지우거나 다른 기기로 들어오면
          다시 찾을 수 없어요. 이메일로 저장하면 학년·돈·자산이 그대로 이어지고 어디서든 로그인할 수 있어요.
        </p>
        {error && <p className="error">{error}</p>}
        <input type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          placeholder="비밀번호 (6자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="비밀번호 확인"
          value={password2}
          onChange={(e) => setPassword2(e.target.value)}
          required
        />
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onClose}>
            나중에
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "저장 중…" : "저장하기"}
          </button>
        </div>
      </form>
    </div>
  );
}
