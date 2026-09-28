import { useState } from "react";
import { api } from "../api";
import type { Profile } from "../types";
import { AvatarPicker } from "./AvatarPicker";

// README 4.4: 상단 프로필(아바타 클릭 시 기본 아바타/사진으로 교체, 현재 학년 표시) / 4.5: 졸업 등급 표시
export function ProfileHeader({
  profile,
  onRefresh,
}: {
  profile: Profile;
  onRefresh: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  async function onAvatarSelected(dataUrl: string) {
    setPickerOpen(false);
    await api.patch("/profile", { avatarUrl: dataUrl });
    onRefresh();
  }

  return (
    <header className="profile-header">
      <div className="avatar" onClick={() => setPickerOpen(true)} title="클릭해서 사진 변경">
        {profile.avatarUrl ? (
          <img src={profile.avatarUrl} alt="avatar" />
        ) : (
          <span>{profile.nickname.slice(0, 1)}</span>
        )}
      </div>
      <div className="profile-info">
        <div className="profile-name">
          {profile.nickname}
          {profile.isGuest && <span className="badge guest">비회원</span>}
        </div>
        <div className="profile-grade">{profile.school.label}</div>
        <div className="profile-tiers">
          {profile.graduations.map((g) => (
            <span key={g.school_level} className={`badge tier-${g.tier}`}>
              {g.school_level === "elementary"
                ? "초졸"
                : g.school_level === "middle"
                ? "중졸"
                : "고졸"}
              {g.tier}
            </span>
          ))}
        </div>
      </div>

      {pickerOpen && (
        <AvatarPicker onSelect={onAvatarSelected} onClose={() => setPickerOpen(false)} />
      )}
    </header>
  );
}
