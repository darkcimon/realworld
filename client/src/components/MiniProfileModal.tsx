import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { PublicProfile } from "../types";

// 채팅(학교 단체 채팅 / 1:1 채팅) 메시지의 프로필 사진 아이콘을 눌렀을 때 뜨는 가벼운 프로필 카드.
// PersonPanel(README 11절, 300만원 열람권이 필요한 상세 프로필)과 달리 비용/졸업 여부와 무관하게
// 누구나 볼 수 있는 공개 정보(닉네임/사진/학년/졸업 등급)만 보여준다 — 트위터 아이콘 클릭과 같은 감각.
export function MiniProfileModal({ userId, onClose }: { userId: number; onClose: () => void }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProfile(null);
    setError(null);
    api
      .get<PublicProfile>(`/profile/public/${userId}`)
      .then(setProfile)
      .catch((e) => setError(e instanceof ApiError ? e.message : "프로필을 불러올 수 없습니다."));
  }, [userId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal person-modal" onClick={(e) => e.stopPropagation()}>
        <h2>프로필</h2>
        {error && <p className="error">{error}</p>}
        {profile && (
          <>
            <div className="avatar" style={{ margin: "0 auto 12px" }}>
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt="avatar" />
              ) : (
                <span>{profile.nickname.slice(0, 1)}</span>
              )}
            </div>
            <p className="profile-name" style={{ justifyContent: "center" }}>
              {profile.nickname}
              {profile.isGuest && <span className="badge guest">비회원</span>}
            </p>
            {profile.school && (
              <p className="muted" style={{ textAlign: "center" }}>
                {profile.school.label}
              </p>
            )}
            {profile.graduations.length > 0 && (
              <div className="profile-tiers" style={{ justifyContent: "center" }}>
                {profile.graduations.map((g) => (
                  <span key={g.school_level} className={`badge tier-${g.tier}`}>
                    {g.school_level === "elementary" ? "초졸" : g.school_level === "middle" ? "중졸" : "고졸"}
                    {g.tier}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
