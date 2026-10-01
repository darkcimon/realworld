import { lazy, Suspense, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { CatalogItem, OwnedItem, Profile } from "../types";
import { PersonPanel } from "./PersonPanel";
import { itemDisplayName } from "../itemName";
import { confirmDialog } from "./ConfirmDialog";

// three.js가 무거워서 3D 창을 처음 열 때만 불러온다.
export const AssetViewer = lazy(() => import("./AssetViewer"));

const CATEGORIES: { key: CatalogItem["category"]; label: string }[] = [
  { key: "car", label: "자동차" },
  { key: "apartment", label: "집" },
  { key: "luxury", label: "명품" },
];

// README 8~10장: 자동차/아파트/명품 — 구매 → 소유 → 프로필 전시 토글. 명품은 선물도 가능.
// fixedCategory: 그 매장 상품과 그 카테고리 소유 자산만 보여준다.
// ownedOnly: 매장 목록 없이 소유 자산 전체만 보여준다(내 집).
export function CatalogPanel({
  onBalanceChange,
  onProfileChange,
  initialCategory,
  fixedCategory,
  ownedOnly = false,
}: {
  onBalanceChange: () => void;
  onProfileChange: () => void;
  initialCategory?: CatalogItem["category"];
  fixedCategory?: CatalogItem["category"];
  ownedOnly?: boolean;
}) {
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [viewAsset, setViewAsset] = useState<{ category: CatalogItem["category"]; name: string } | null>(null);
  const [category, setCategory] = useState<CatalogItem["category"]>(fixedCategory ?? initialCategory ?? "car");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [owned, setOwned] = useState<OwnedItem[]>([]);
  const [giftTarget, setGiftTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadItems() {
    setItems(await api.get<CatalogItem[]>(`/catalog?category=${category}`));
  }
  async function loadOwned() {
    setOwned(await api.get<OwnedItem[]>("/catalog/owned"));
  }
  const [marketNext, setMarketNext] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ nextChangeAt: string }>("/catalog/market")
      .then((m) => setMarketNext(m.nextChangeAt))
      .catch(() => {});
  }, []);

  async function sell(o: OwnedItem) {
    const how =
      o.resale.kind === "depreciation"
        ? `감가 반영 구매가의 ${Math.round(o.resale.ratio * 100)}%`
        : `지금 시세 ×${o.resale.ratio}`;
    if (!(await confirmDialog(`${itemDisplayName(o)}을(를) ${o.resale.price.toLocaleString()}원에 팔까요?\n(${how})`, { title: "판매 확인", confirmText: "팔기" }))) return;
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ soldFor: number }>(`/owned-items/${o.id}/sell`);
      setMessage(`${itemDisplayName(o)}을(를) ${r.soldFor.toLocaleString()}원에 팔았어요.`);
      onBalanceChange();
      onProfileChange(); // 전시 중이던 자산이면 프로필에서도 빠진다
      await loadOwned();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "판매에 실패했습니다.");
    }
  }

  useEffect(() => {
    if (!ownedOnly) loadItems();
  }, [category, ownedOnly]);
  useEffect(() => {
    loadOwned();
  }, []);

  async function buy(itemId: number) {
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ item: CatalogItem }>(`/catalog/${itemId}/purchase`);
      setMessage(`${r.item.name} 구매 완료!`);
      onBalanceChange();
      await loadOwned();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "구매에 실패했습니다.");
    }
  }

  async function toggleDisplay(ownedItemId: number, displayed: boolean) {
    await api.patch(`/owned-items/${ownedItemId}`, { displayed: !displayed });
    await loadOwned();
    onProfileChange(); // 사이드바 내 프로필의 전시 뱃지도 갱신
  }

  async function openPreview() {
    const me = await api.get<Profile>("/profile");
    setPreviewId(me.id);
  }

  async function gift(itemId: number) {
    setError(null);
    setMessage(null);
    const targetId = Number(giftTarget);
    if (!targetId) {
      setError("선물 받을 상대의 유저 ID를 입력해주세요.");
      return;
    }
    try {
      const r = await api.post<{ item: CatalogItem }>(`/luxury/${itemId}/gift`, { targetId });
      setMessage(`${r.item.name}을(를) 선물했습니다!`);
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "선물에 실패했습니다.");
    }
  }

  const visibleOwned = fixedCategory ? owned.filter((o) => o.category === fixedCategory) : owned;

  return (
    <div className="panel">
      {/* 매장 이름은 시설 머리글(SocialHub)에 이미 나오므로 매장 모드에선 생략 */}
      {!fixedCategory && <h3>{ownedOnly ? "🏠 내 자산" : "자산"}</h3>}
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      {!ownedOnly && !fixedCategory && (
      <div className="tabs sub-tabs">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={category === c.key ? "active" : ""}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      )}

      {!ownedOnly && category === "luxury" && (
        <input
          className="gift-target-input"
          value={giftTarget}
          onChange={(e) => setGiftTarget(e.target.value)}
          placeholder="선물 받을 상대 유저 ID (선물 시 필요)"
        />
      )}

      {!ownedOnly && (
      <ul className="catalog-list">
        {items.map((it) => (
          <li key={it.id}>
            <div>
              <strong>
                {itemDisplayName(it)}
              </strong>
              <div className="muted">
                {it.price.toLocaleString()}원
                {it.marketMultiplier != null && (
                  <>
                    {" "}
                    <span className={it.marketMultiplier <= 1 ? "ok-text" : "error"}>(시세 ×{it.marketMultiplier})</span>
                    {it.basePrice != null && ` · 정가 ${it.basePrice.toLocaleString()}원`}
                  </>
                )}
              </div>
            </div>
            <div className="catalog-actions">
              <button className="ghost" onClick={() => setViewAsset({ category: it.category, name: it.name })}>
                3D
              </button>
              <button className="ghost" onClick={() => buy(it.id)}>
                구매
              </button>
              {category === "luxury" && (
                <button className="ghost" onClick={() => gift(it.id)}>
                  선물
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      )}

      {fixedCategory !== "luxury" && fixedCategory !== "apartment" && (
        <p className="muted">🚗 자동차는 산 날부터 하루 2%씩 값이 떨어져요(최저 구매가의 10%).</p>
      )}
      {fixedCategory !== "car" && marketNext && (
        <p className="muted">
          🏠💎 집·명품은 시세대로 사고팔아요. 시세는 매일 9·12·15·18시에 정가의 0.5~3배 사이로 바뀌어요 — 쌀 때 사서
          비쌀 때 팔면 이익! 다음 변경{" "}
          {new Date(marketNext).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
      <div className="owned-head">
        <h4>내 소유 자산</h4>
        <button className="ghost" onClick={openPreview}>
          👁 내 프로필 미리보기
        </button>
      </div>
      <ul className="catalog-list">
        {visibleOwned.map((o) => (
          <li key={o.id}>
            <div>
              <strong>
                {itemDisplayName(o)}
              </strong>
              <div className="muted">
                {o.paidPrice != null ? `구매 ${o.paidPrice.toLocaleString()}원` : "선물 받음"} → 지금 팔면{" "}
                <b>{o.resale.price.toLocaleString()}원</b>
                {o.resale.kind === "depreciation"
                  ? ` (감가 ${Math.round((1 - o.resale.ratio) * 100)}%)`
                  : ` (시세 ×${o.resale.ratio})`}
              </div>
            </div>
            <div className="catalog-actions">
              <button className="ghost" onClick={() => setViewAsset({ category: o.category, name: o.name })}>
                3D
              </button>
              <button className={o.displayed ? "" : "ghost"} onClick={() => toggleDisplay(o.id, o.displayed)}>
                {o.displayed ? "전시 중" : "전시하기"}
              </button>
              <button className="ghost" onClick={() => sell(o)}>
                팔기
              </button>
            </div>
          </li>
        ))}
        {visibleOwned.length === 0 && <p className="muted">아직 소유한 자산이 없습니다.</p>}
      </ul>

      {viewAsset && (
        <Suspense fallback={null}>
          <AssetViewer {...viewAsset} onClose={() => setViewAsset(null)} />
        </Suspense>
      )}

      {previewId !== null && (
        <PersonPanel
          targetId={previewId}
          preview
          onClose={() => setPreviewId(null)}
          onBalanceChange={onBalanceChange}
          onJailed={onProfileChange}
        />
      )}
    </div>
  );
}
