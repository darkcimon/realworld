import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { assetIcon } from "../assetIcons";
import type { RankingResp, RankingRow } from "../types";
import { MiniProfileModal } from "./MiniProfileModal";
import { ShareCardModal } from "./ShareCardModal";

// 자산 랭킹(전체 / 내 주변 50km). 순위는 서버가 10분마다 다시 세고, 내 순위는 지금 자산으로 바로 계산된다.
// 다른 사람은 "3억원대"처럼 구간만, 내 자산은 정확한 금액까지 보여준다. 이름을 누르면 공개 프로필.
const MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function Showcase({ row }: { row: RankingRow }) {
  return (
    <span className="ranking-showcase">
      {row.home ? assetIcon("apartment", row.home) : "📦"}
      {row.car && assetIcon("car", row.car)}
      {row.luxuryCount > 0 && `💎${row.luxuryCount}`}
    </span>
  );
}

export function RankingModal({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<"all" | "nearby">("all");
  const [data, setData] = useState<RankingResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .get<RankingResp>(`/ranking?scope=${scope}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "랭킹을 불러오지 못했어요."));
  }, [scope]);

  const me = data?.me;
  // 프로필·자랑 카드 창은 랭킹 창 바깥에 그린다(안에 두면 그 창의 바깥 클릭이 랭킹 창까지 닫는다).
  return (
    <>
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ranking-modal" onClick={(e) => e.stopPropagation()}>
        <h2>🏆 자산 랭킹</h2>
        <div className="tabs">
          <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
            전체
          </button>
          <button className={scope === "nearby" ? "active" : ""} onClick={() => setScope("nearby")}>
            내 주변 50km
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">순위를 세는 중…</p>}

        {me && (
          <div className="ranking-me">
            <div>
              <strong>
                내 순위 {me.rank.toLocaleString()}위
              </strong>
              <span className="muted"> / {me.outOf.toLocaleString()}명</span>
              <div className="muted">
                💰 {me.total.toLocaleString()}원 ({me.wealthBand}) · 🎓 {me.education}
              </div>
            </div>
            <button onClick={() => setShareOpen(true)}>📸 자랑하기</button>
          </div>
        )}

        {data && (
          <ol className="ranking-list">
            {data.top.map((r) => (
              <li key={r.userId} className={r.isMe ? "me" : ""}>
                <span className="ranking-rank">{MEDAL[r.rank] ?? r.rank}</span>
                <button className="ranking-person" onClick={() => setProfileId(r.userId)}>
                  <span className="ranking-avatar">
                    {r.avatarUrl ? <img src={r.avatarUrl} alt="" /> : r.nickname.slice(0, 1)}
                  </span>
                  <span className="ranking-name">
                    {r.nickname}
                    <small className="muted"> · {r.education}</small>
                  </span>
                </button>
                <Showcase row={r} />
                <span className="ranking-band">{r.wealthBand}</span>
              </li>
            ))}
            {data.top.length === 0 && <p className="muted">아직 순위에 든 사람이 없어요.</p>}
          </ol>
        )}
        {data && <p className="muted ranking-note">순위는 {data.refreshMinutes}분마다 새로 세요. 최근 30일 안에 접속한 사람만 들어가요.</p>}

        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
    {profileId !== null && <MiniProfileModal userId={profileId} onClose={() => setProfileId(null)} />}
    {shareOpen && <ShareCardModal onClose={() => setShareOpen(false)} />}
    </>
  );
}
