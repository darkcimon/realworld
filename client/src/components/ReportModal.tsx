import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

// 사용자 신고. 신고하면 그 사람은 바로 차단된다. 서로 다른 사람에게 신고가 3건 쌓이면 감옥, 5건이면 이용 정지
// (서버 social/reports.ts). 같은 사람을 여러 번 신고해도 1건으로 센다.
export function ReportModal({
  targetId,
  targetName,
  onReported,
  onClose,
}: {
  targetId: number;
  targetName: string;
  onReported: () => void;
  onClose: () => void;
}) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ reasons: string[] }>("/reports/reasons")
      .then((r) => setReasons(r.reasons))
      .catch(() => setError("신고 사유를 불러오지 못했어요."));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return;
    setError(null);
    setBusy(true);
    try {
      await api.post(`/reports/${targetId}`, { reason, detail });
      onReported();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "신고하지 못했어요.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal save-account-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>🚨 {targetName}님 신고</h3>
        <p className="muted">신고하면 이 사람은 바로 차단돼요. 신고가 여러 사람에게서 쌓이면 자동으로 제재돼요.</p>
        {error && <p className="error">{error}</p>}
        <div className="report-reasons">
          {reasons.map((r) => (
            <label key={r} className={reason === r ? "active" : ""}>
              <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} />
              {r}
            </label>
          ))}
        </div>
        <textarea
          placeholder="무슨 일이 있었는지 적어 주세요 (선택, 300자)"
          maxLength={300}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          rows={3}
        />
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="danger" disabled={busy || !reason}>
            {busy ? "신고 중…" : "신고하고 차단"}
          </button>
        </div>
      </form>
    </div>
  );
}
