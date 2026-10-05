import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { PhotoCropper } from "./PhotoCropper";
import { confirmDialog } from "./ConfirmDialog";
import { feedback } from "../feedback";

interface AlbumState {
  photos: { id: number; url: string; sortOrder: number }[];
  limit: number;
  maxLimit: number;
  hasAlbum: boolean;
  albumCost: number;
}

// 내 사진첩(README 11.1): 나를 표현하는 사진을 올려 두면 상세 프로필(열람권·맞하트)에서 보인다.
// 기본 1장, 사진첩을 사면 5장까지. 사진은 정사각형으로 잘라 JPEG로 올린다(서버가 형식·크기를 다시 확인).
export function PhotoAlbumModal({ onClose, onAvatarChanged }: { onClose: () => void; onAvatarChanged: () => void }) {
  const [album, setAlbum] = useState<AlbumState | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () =>
    api
      .get<AlbumState>("/profile/photos")
      .then(setAlbum)
      .catch(() => setError("사진첩을 불러오지 못했어요."));

  useEffect(() => {
    void load();
  }, []);

  async function run(fn: () => Promise<string | void>) {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "처리하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  const full = !!album && album.photos.length >= album.limit;

  async function upload(dataUrl: string) {
    setFile(null);
    await run(async () => {
      await api.post("/profile/photos", { url: dataUrl });
      feedback("correct");
      return "사진을 올렸어요.";
    });
  }

  async function buyAlbum() {
    if (!album) return;
    if (!(await confirmDialog(`사진첩을 ${album.albumCost.toLocaleString()}원에 사서 사진을 ${album.maxLimit}장까지 올릴까요?`, { title: "사진첩 구매", confirmText: "사기" })))
      return;
    await run(async () => {
      await api.post("/profile/photo-album/purchase");
      feedback("purchase");
      return `이제 사진을 ${album.maxLimit}장까지 올릴 수 있어요.`;
    });
  }

  async function remove(id: number) {
    if (!(await confirmDialog("이 사진을 지울까요?", { title: "사진 삭제", confirmText: "지우기" }))) return;
    await run(async () => {
      await api.delete(`/profile/photos/${id}`);
      return "사진을 지웠어요.";
    });
  }

  async function makeAvatar(id: number) {
    await run(async () => {
      await api.post(`/profile/photos/${id}/avatar`);
      onAvatarChanged();
      return "프로필 사진으로 바꿨어요.";
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal photo-album-modal" onClick={(e) => e.stopPropagation()}>
        <h3>📷 내 사진첩</h3>
        <p className="muted">
          나를 보여 주는 사진을 올려 보세요. 상세 프로필(열람권·맞하트)을 본 사람에게 보여요.
          {album && ` (${album.photos.length}/${album.limit}장)`}
        </p>
        {error && <p className="error">{error}</p>}
        {message && <p className="ok-text">{message}</p>}

        {file && <PhotoCropper file={file} onCancel={() => setFile(null)} onConfirm={upload} />}
        {!file && (
        <div className="photo-grid">
          {album?.photos.map((p) => (
            <figure key={p.id}>
              <img src={p.url} alt={`사진 ${p.sortOrder}`} />
              <figcaption>
                <button className="ghost" disabled={busy} onClick={() => makeAvatar(p.id)}>
                  대표로
                </button>
                <button className="ghost" disabled={busy} onClick={() => remove(p.id)}>
                  삭제
                </button>
              </figcaption>
            </figure>
          ))}
          {album && !full && (
            <button className="photo-add" disabled={busy} onClick={() => fileInput.current?.click()}>
              ＋<span>사진 올리기</span>
            </button>
          )}
        </div>
        )}

        {album && full && !album.hasAlbum && (
          <button className="ghost" disabled={busy} onClick={buyAlbum}>
            📚 사진첩 사기 ({album.albumCost.toLocaleString()}원 · {album.maxLimit}장까지)
          </button>
        )}
        <p className="muted photo-rule">본인 사진이나 나를 표현하는 사진만 올려 주세요. 불쾌한 사진은 신고되면 제재를 받아요.</p>

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) setFile(f);
          }}
        />
        <div className="confirm-actions">
          <button className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
