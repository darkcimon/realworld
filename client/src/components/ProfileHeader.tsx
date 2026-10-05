import { useState } from "react";
import { api } from "../api";
import type { Profile } from "../types";
import { AvatarPicker } from "./AvatarPicker";
import { SaveAccountModal } from "./SaveAccountModal";
import { CharacterStudio } from "../character/CharacterStudio";
import { groupSameItems, itemDisplayName } from "../itemName";
import { assetIcon } from "../assetIcons";

// README 4.4: 상단 프로필(아바타 클릭 시 기본 아바타/사진으로 교체, 학력·학교 진도 표시) / 4.5: 졸업 등급 표시
export function ProfileHeader({
  profile,
  onRefresh,
}: {
  profile: Profile;
  onRefresh: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);

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
        <button className="character-edit-btn" onClick={() => setStudioOpen(true)}>
          🧍 {profile.character ? "캐릭터 꾸미기" : "캐릭터 만들기"}
        </button>
        {profile.isGuest && (
          <button className="save-account-btn" onClick={() => setSaveOpen(true)}>
            💾 계정 저장하기
          </button>
        )}
        <div className="profile-grade">
          🎓 {profile.education.label}
          {profile.education.payMultiplier !== 1 && ` · 일급 ×${profile.education.payMultiplier}`}
        </div>
        {profile.school.status !== "graduated" && <div className="muted">학교: {profile.school.label}</div>}
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
        {profile.displayedItems.length > 0 && (
          <div className="profile-tiers" title="프로필에 전시 중인 자산">
            {groupSameItems(profile.displayedItems).map(({ item: it, count }) => (
              <span key={it.id} className="badge">
                {assetIcon(it.category, it.name)} {itemDisplayName(it)}
                {count > 1 && <b className="badge-count"> ×{count}</b>}
              </span>
            ))}
          </div>
        )}
      </div>

      {studioOpen && (
        <CharacterStudio
          initial={profile.character}
          photoUrl={profile.avatarUrl}
          onClose={() => setStudioOpen(false)}
          onSaved={() => {
            setStudioOpen(false);
            onRefresh();
          }}
        />
      )}

      {saveOpen && (
        <SaveAccountModal
          onClose={() => setSaveOpen(false)}
          onSaved={() => {
            setSaveOpen(false);
            onRefresh();
          }}
        />
      )}

      {pickerOpen && (
        <AvatarPicker onSelect={onAvatarSelected} onClose={() => setPickerOpen(false)} />
      )}
    </header>
  );
}
