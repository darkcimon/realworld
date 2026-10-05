import { useState } from "react";
import { api, ApiError } from "../api";
import { BirthPicker, birthComplete } from "./BirthPicker";

// 연령 확인 전에 만든 예전 계정: 출생 연월을 한 번만 받는다(이후 앱에서 바꿀 수 없다).
// 만 14세 미만이면 이용할 수 없어서 계정 삭제·로그아웃만 안내한다.
export function AgeGateModal({
  onDone,
  onDeleteAccount,
  onLogout,
}: {
  onDone: () => void;
  onDeleteAccount: () => void;
  onLogout: () => void;
}) {
  const [birthYm, setBirthYm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [underage, setUnderage] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/profile/birth", { birthYm });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "underage") setUnderage(true);
      setError(e instanceof ApiError ? e.message : "저장하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal save-account-modal" onSubmit={submit}>
        <h3>🎂 연령 확인</h3>
        {underage ? (
          <>
            <p className="error">{error}</p>
            <div className="confirm-actions">
              <button type="button" className="logout" onClick={onDeleteAccount}>
                계정 삭제
              </button>
              <button type="button" className="ghost" onClick={onLogout}>
                로그아웃
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">게임을 계속하려면 한 번만 확인해 주세요. 정한 뒤에는 바꿀 수 없어요.</p>
            {error && <p className="error">{error}</p>}
            <BirthPicker value={birthYm} onChange={setBirthYm} />
            <div className="confirm-actions">
              <button type="submit" disabled={busy || !birthComplete(birthYm)}>
                확인
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
