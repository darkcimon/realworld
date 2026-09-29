import { Suspense, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { PersonDetail } from "../types";
import { DmChat } from "./DmChat";
import { AssetViewer } from "./CatalogPanel";
import type { AssetCategory } from "./AssetViewer";
import { itemDisplayName } from "../itemName";

// README 11.2~11.5: 프로필 열람권 구매/상세 조회, 선물/하트/맞하트, 차단, 채팅 개시.
// preview: 내 프로필을 다른 사람 시점으로 미리보기(하트/선물/채팅 등 상대용 버튼은 숨긴다).
export function PersonPanel({
  targetId,
  onClose,
  onBalanceChange,
  onJailed,
  preview = false,
}: {
  targetId: number;
  onClose: () => void;
  onBalanceChange: () => void;
  onJailed: () => void;
  preview?: boolean;
}) {
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [needsPass, setNeedsPass] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [viewAsset, setViewAsset] = useState<{ category: AssetCategory; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadDetail() {
    try {
      const d = await api.get<PersonDetail>(`/profile-view/${targetId}`);
      setDetail(d);
      setNeedsPass(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNeedsPass(true);
      } else {
        setError(e instanceof ApiError ? e.message : "프로필을 불러올 수 없습니다.");
      }
    }
  }

  useEffect(() => {
    setDetail(null);
    setNeedsPass(false);
    setChatOpen(false);
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  async function buyPass() {
    setError(null);
    setMessage(null);
    try {
      await api.post(`/profile-view/${targetId}/purchase`);
      onBalanceChange();
      await loadDetail();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "열람권 구매에 실패했습니다.");
    }
  }

  async function sendHeart() {
    setError(null);
    setMessage(null);
    try {
      await api.post(`/hearts/${targetId}`);
      setMessage("하트를 보냈습니다.");
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "하트 전송에 실패했습니다.");
    }
  }

  async function sendGift() {
    setError(null);
    setMessage(null);
    try {
      await api.post(`/gifts/${targetId}`);
      setMessage("선물을 보냈습니다.");
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "선물 전송에 실패했습니다.");
    }
  }

  async function block() {
    setError(null);
    try {
      await api.post(`/blocks/${targetId}`);
      setMessage("차단했습니다.");
      setChatOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "차단에 실패했습니다.");
    }
  }

  async function unblock() {
    setError(null);
    try {
      await api.delete(`/blocks/${targetId}`);
      setMessage("차단을 해제했습니다.");
      await loadDetail();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "차단 해제에 실패했습니다.");
    }
  }

  async function openChat() {
    setError(null);
    try {
      await api.post(`/chat/request/${targetId}`);
      setChatOpen(true);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "채팅을 시작할 수 없습니다 (열람권 구매 또는 맞하트가 필요합니다)."
      );
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal person-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{preview ? "내 프로필 미리보기" : `상대 프로필 (#${targetId})`}</h2>
        {preview && <p className="muted">다른 사람이 내 프로필을 열면 이렇게 보여요.</p>}
        {error && <p className="error">{error}</p>}
        {message && <p className="ok-text">{message}</p>}

        {needsPass && (
          <>
            <p className="muted">상세 프로필을 보려면 열람권(300만원)이 필요합니다.</p>
            <button onClick={buyPass}>열람권 구매 (300만원)</button>
          </>
        )}

        {detail && (
          <>
            {preview && detail.displayedItems.length === 0 && (
              <p className="muted">아직 전시 중인 자산이 없어요. '전시하기'를 누르면 여기에 표시돼요.</p>
            )}
            <div className="avatar" style={{ margin: "0 auto 12px" }}>
              {detail.avatarUrl ? (
                <img src={detail.avatarUrl} alt="avatar" />
              ) : (
                <span>{detail.nickname.slice(0, 1)}</span>
              )}
            </div>
            <p className="profile-name" style={{ justifyContent: "center" }}>
              {detail.nickname}
            </p>
            {detail.displayedItems.length > 0 && (
              <ul className="catalog-list">
                {detail.displayedItems.map((it) => (
                  <li key={it.id}>
                    <span>
                      {itemDisplayName(it)}
                    </span>
                    <button
                      className="ghost"
                      onClick={() => setViewAsset({ category: it.category as AssetCategory, name: it.name })}
                    >
                      3D로 보기
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {!preview && (
          <div className="person-actions">
            <button className="ghost" onClick={sendHeart}>
              하트 보내기 (50만원)
            </button>
            <button className="ghost" onClick={sendGift}>
              선물 보내기 (100만원)
            </button>
            <button onClick={openChat}>채팅 시작</button>
            <button className="ghost" onClick={block}>
              차단
            </button>
            <button className="ghost" onClick={unblock}>
              차단 해제
            </button>
          </div>
        )}

        {chatOpen && (
          <DmChat
            targetId={targetId}
            targetNickname={detail?.nickname ?? `유저 #${targetId}`}
            onJailed={onJailed}
          />
        )}

        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>

      {viewAsset && (
        <Suspense fallback={null}>
          <AssetViewer {...viewAsset} onClose={() => setViewAsset(null)} />
        </Suspense>
      )}
    </div>
  );
}
