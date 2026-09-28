import { useRef, useState } from "react";
import { AVATAR_PRESETS } from "../avatars";
import { PhotoCropper } from "./PhotoCropper";

// 최초 게임 시작(비회원/회원가입) 및 이후 프로필 사진 변경에서 공통으로 쓰는 아바타 선택 모달.
// "기본 아바타" 탭(남자/여자/동물 6종)과 "사진 업로드" 탭(내 저장소 사진 불러오기 + 영역 지정) 중
// 하나를 골라 결과를 avatarUrl(데이터 URL) 하나로 통일해 돌려준다.
export function AvatarPicker({
  onSelect,
  onClose,
  title = "프로필 사진 선택",
}: {
  onSelect: (dataUrl: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const [tab, setTab] = useState<"preset" | "upload">("preset");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
    e.target.value = ""; // 같은 파일을 다시 골라도 change가 발생하도록
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal avatar-picker-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>

        {!pendingFile && (
          <div className="tabs">
            <button className={tab === "preset" ? "active" : ""} onClick={() => setTab("preset")}>
              기본 아바타
            </button>
            <button className={tab === "upload" ? "active" : ""} onClick={() => setTab("upload")}>
              사진 업로드
            </button>
          </div>
        )}

        {pendingFile ? (
          <PhotoCropper
            file={pendingFile}
            onCancel={() => setPendingFile(null)}
            onConfirm={(dataUrl) => {
              setPendingFile(null);
              onSelect(dataUrl);
            }}
          />
        ) : tab === "preset" ? (
          <div className="avatar-preset-grid">
            {AVATAR_PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className="avatar-preset-btn"
                onClick={() => onSelect(p.dataUrl)}
                title={p.label}
              >
                <img src={p.dataUrl} alt={p.label} />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="upload-dropzone">
            <p className="muted">내 기기의 사진을 불러와 원하는 영역만 잘라 프로필 사진으로 쓸 수 있어요.</p>
            <button type="button" onClick={() => fileRef.current?.click()}>
              사진 불러오기
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={onFileChosen}
            />
          </div>
        )}

        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
