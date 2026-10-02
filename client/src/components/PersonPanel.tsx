import { Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { OwnedItem, PersonDetail, PublicProfile } from "../types";
import { DmChat } from "./DmChat";
import { AssetViewer } from "./CatalogPanel";
import type { AssetCategory } from "./AssetViewer";
import { groupSameItems, itemDisplayName } from "../itemName";
import { CharacterStage } from "../character/characterLazy";
import { assetIcon } from "../assetIcons";
import { confirmDialog } from "./ConfirmDialog";

interface HeartStatus {
  sent: boolean;
  received: boolean;
  matched: boolean;
}

const CATEGORY_LABEL: Record<OwnedItem["category"], string> = { car: "자동차", apartment: "건물", luxury: "명품" };

// README 11.2~11.5: 프로필 열람권 구매/상세 조회, 선물/하트/맞하트, 차단, 채팅 개시.
// 3D 캐릭터는 공간을 많이 차지해 채팅창을 밀어내므로, 사이드 메뉴처럼 간단 프로필만 보여주고
// 아바타를 누르면 별도 창으로 3D 캐릭터를 띄운다.
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
  const [publicProfile, setPublicProfile] = useState<PublicProfile | null>(null);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [heart, setHeart] = useState<HeartStatus | null>(null);
  // 선물: 돈이 아니라 내가 가진 자산(자동차·건물·명품) 하나를 골라 넘긴다.
  const [giftItems, setGiftItems] = useState<OwnedItem[] | null>(null);
  const [giftPick, setGiftPick] = useState<number | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // 채팅을 열면 모바일에서도 바로 입력할 수 있게 채팅창까지 스크롤한다.
  useEffect(() => {
    if (chatOpen) chatRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chatOpen]);

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
    setCharacterOpen(false);
    setPublicProfile(null);
    setHeart(null);
    setGiftItems(null);
    setGiftPick(null);
    loadDetail();
    if (!preview) loadHeart();
    // 학력/졸업 등급은 열람권과 무관한 공개 정보라 따로 불러온다.
    api
      .get<PublicProfile>(`/profile/public/${targetId}`)
      .then(setPublicProfile)
      .catch(() => {});
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

  async function loadHeart() {
    try {
      setHeart(await api.get<HeartStatus>(`/hearts/status/${targetId}`));
    } catch {
      setHeart(null);
    }
  }

  // 상대가 먼저 보낸 하트가 있으면 서버가 맞하트로 처리한다.
  async function sendHeart() {
    setError(null);
    setMessage(null);
    try {
      await api.post(`/hearts/${targetId}`);
      setMessage(heart?.received ? "맞하트가 성립되었습니다!" : "하트를 보냈습니다.");
      onBalanceChange();
      await loadHeart();
      if (heart?.received) await loadDetail();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "하트 전송에 실패했습니다.");
    }
  }

  async function openGift() {
    setError(null);
    setMessage(null);
    if (giftItems) {
      setGiftItems(null);
      return;
    }
    try {
      setGiftItems(await api.get<OwnedItem[]>("/catalog/owned"));
      setGiftPick(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "내 자산을 불러올 수 없습니다.");
    }
  }

  async function sendGift() {
    const item = giftItems?.find((o) => o.id === giftPick);
    if (!item) return;
    const name = itemDisplayName(item);
    const who = basic?.nickname ?? `유저 #${targetId}`;
    if (
      !(await confirmDialog(`${name}을(를) ${who}님에게 보내시겠습니까?
보낸 자산은 상대 소유가 되어 되돌릴 수 없어요.`, {
        title: "선물 보내기",
        confirmText: "보내기",
      }))
    )
      return;
    setError(null);
    setMessage(null);
    try {
      await api.post(`/gifts/${targetId}`, { ownedItemId: item.id });
      setMessage(`${name}을(를) 선물했습니다.`);
      setGiftItems(null);
      setGiftPick(null);
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

  // 열람권이 없어도 공개 정보(닉네임/사진/학력)는 보여준다.
  const basic = detail ?? publicProfile;

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

        {detail && preview && detail.displayedItems.length === 0 && (
          <p className="muted">아직 전시 중인 자산이 없어요. '전시하기'를 누르면 여기에 표시돼요.</p>
        )}

        {basic && (
          <div className="profile-header person-profile-card">
            <div
              className="avatar"
              onClick={() => detail?.character && setCharacterOpen(true)}
              title={detail?.character ? "클릭해서 3D 캐릭터 보기" : undefined}
              style={{ cursor: detail?.character ? "pointer" : "default" }}
            >
              {basic.avatarUrl ? <img src={basic.avatarUrl} alt="avatar" /> : <span>{basic.nickname.slice(0, 1)}</span>}
            </div>
            <div className="profile-info">
              <div className="profile-name">
                {basic.nickname}
                {publicProfile?.isGuest && <span className="badge guest">비회원</span>}
              </div>
              {detail?.character && (
                <button className="character-edit-btn" onClick={() => setCharacterOpen(true)}>
                  🧍 3D 캐릭터 보기
                </button>
              )}
              {publicProfile?.school && <div className="profile-grade">{publicProfile.school.label}</div>}
              {publicProfile && publicProfile.graduations.length > 0 && (
                <div className="profile-tiers">
                  {publicProfile.graduations.map((g) => (
                    <span key={g.school_level} className={`badge tier-${g.tier}`}>
                      {g.school_level === "elementary" ? "초졸" : g.school_level === "middle" ? "중졸" : "고졸"}
                      {g.tier}
                    </span>
                  ))}
                </div>
              )}
              {detail && detail.displayedItems.length > 0 && (
                <div className="profile-tiers" title="전시 중인 자산 (눌러서 3D로 보기)">
                  {groupSameItems(detail.displayedItems).map(({ item: it, count }) => (
                    <span
                      key={it.id}
                      className="badge clickable"
                      onClick={() => setViewAsset({ category: it.category as AssetCategory, name: it.name })}
                    >
                      {assetIcon(it.category, it.name)} {itemDisplayName(it)}
                      {count > 1 && <b className="badge-count"> ×{count}</b>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {!preview && (
          <div className="person-actions">
            {heart?.matched ? (
              <button className="ghost" disabled>
                💞 맞하트 성립
              </button>
            ) : heart?.sent ? (
              <button className="ghost" disabled>
                💌 하트 보냄
              </button>
            ) : (
              <button className="ghost" onClick={sendHeart}>
                {heart?.received ? "맞하트 보내기 (50만원)" : "하트 보내기 (50만원)"}
              </button>
            )}
            <button className="ghost" onClick={openGift}>
              🎁 선물 보내기
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

        {giftItems && (
          <div className="gift-picker">
            <h4>선물할 자산 고르기</h4>
            {giftItems.length === 0 ? (
              <p className="muted">선물할 수 있는 자산이 없어요. 자동차·건물·명품을 먼저 사보세요.</p>
            ) : (
              <ul className="gift-list">
                {giftItems.map((o) => (
                  <li key={o.id}>
                    <button
                      className={giftPick === o.id ? "gift-item selected" : "gift-item"}
                      onClick={() => setGiftPick(o.id)}
                    >
                      <span>
                        {assetIcon(o.category, o.name)} {itemDisplayName(o)}
                      </span>
                      <span className="muted">
                        {CATEGORY_LABEL[o.category]} · 시세 {o.resale.price.toLocaleString()}원
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="person-actions">
              <button onClick={sendGift} disabled={giftPick == null}>
                보내기
              </button>
              <button className="ghost" onClick={() => setGiftItems(null)}>
                취소
              </button>
            </div>
          </div>
        )}

        {chatOpen && (
          <div ref={chatRef}>
            <DmChat
              targetId={targetId}
              targetNickname={detail?.nickname ?? `유저 #${targetId}`}
              onJailed={onJailed}
            />
          </div>
        )}

        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>

      {characterOpen && detail?.character && (
        // 프로필 창 위에 겹쳐 뜨므로 바깥 클릭이 아래 프로필 창까지 닫지 않도록 전파를 막는다.
        <div
          className="modal-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            setCharacterOpen(false);
          }}
        >
          <div className="modal person-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{detail.nickname}님의 캐릭터</h2>
            <Suspense fallback={<div className="character-stage" />}>
              <CharacterStage config={detail.character} photoUrl={detail.avatarUrl} showActions />
            </Suspense>
            <button className="modal-close" onClick={() => setCharacterOpen(false)}>
              닫기
            </button>
          </div>
        </div>
      )}

      {viewAsset && (
        <Suspense fallback={null}>
          <AssetViewer {...viewAsset} onClose={() => setViewAsset(null)} />
        </Suspense>
      )}
    </div>
  );
}
