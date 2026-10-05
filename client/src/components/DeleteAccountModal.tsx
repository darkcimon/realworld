import { useState } from "react";
import { api, ApiError } from "../api";

// 계정 삭제(Play 정책: 앱 안에서 계정을 지울 수 있어야 한다). 되돌릴 수 없으니 확인 체크를 받고,
// 정식 회원은 비밀번호를 한 번 더 받는다(서버도 확인한다). 비회원은 비밀번호가 없다.
export function DeleteAccountModal({
  isGuest,
  onDeleted,
  onClose,
}: {
  isGuest: boolean;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) return;
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/delete-account", isGuest ? {} : { password });
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "계정을 삭제하지 못했어요.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal save-account-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>⚠️ 계정 삭제</h3>
        <p className="muted">
          학력·돈·자산·캐릭터·사진·위치·하트·대화 등 이 계정의 모든 기록이 바로 지워지고, 다시 되살릴 수 없어요.
          상대방 화면에서도 나와의 대화와 매칭이 사라져요.
        </p>
        {error && <p className="error">{error}</p>}
        {!isGuest && (
          <input
            type="password"
            placeholder="비밀번호 확인"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
        <label className="delete-account-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          되돌릴 수 없다는 걸 이해했어요
        </label>
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="danger" disabled={busy || !agreed}>
            {busy ? "삭제 중…" : "영구 삭제"}
          </button>
        </div>
      </form>
    </div>
  );
}
