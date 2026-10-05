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
  // 명품 수량 입력: buy-<상품 id>, sell-<상품 id>
  const [qty, setQty] = useState<Record<string, string>>({});
  const qtyOf = (key: string) => Math.max(1, Math.floor(Number(qty[key] ?? "1")) || 1);

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
    const cgt = o.capitalGainsTax;
    const taxLine =
      cgt && cgt.tax > 0
        ? `\n양도소득세 ${Math.round(cgt.rate * 100)}%(건물 ${cgt.buildings}채 보유): -${cgt.tax.toLocaleString()}원\n실수령 ${(o.resale.price - cgt.tax).toLocaleString()}원`
        : cgt
          ? `\n양도소득세 없음(${cgt.gain <= 0 ? "이익 없음" : "건물 1채 보유"})`
          : "";
    if (!(await confirmDialog(`${itemDisplayName(o)}을(를) ${o.resale.price.toLocaleString()}원에 팔까요?\n(${how})${taxLine}`, { title: "판매 확인", confirmText: "팔기" }))) return;
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ soldFor: number; tax: number }>(`/owned-items/${o.id}/sell`);
      setMessage(
        `${itemDisplayName(o)}을(를) ${r.soldFor.toLocaleString()}원에 팔았어요.` +
          (r.tax > 0 ? ` 양도소득세 ${r.tax.toLocaleString()}원을 내고 ${(r.soldFor - r.tax).toLocaleString()}원을 받았어요.` : "")
      );
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

  // 같은 명품 여러 개를 한꺼번에 판다. 전시 안 한 것부터 팔아서 전시 중인 건 최대한 남긴다.
  async function sellMany(group: OwnedItem[]) {
    const first = group[0];
    const n = Math.min(qtyOf(`sell-${first.catalog_item_id}`), group.length);
    const total = first.resale.price * n;
    if (
      !(await confirmDialog(
        `${itemDisplayName(first)} ${n}개를 ${total.toLocaleString()}원에 팔까요?\n(개당 ${first.resale.price.toLocaleString()}원, 지금 시세 ×${first.resale.ratio})`,
        { title: "판매 확인", confirmText: "팔기" }
      ))
    )
      return;
    setError(null);
    setMessage(null);
    const ids = [...group]
      .sort((a, b) => Number(a.displayed) - Number(b.displayed))
      .slice(0, n)
      .map((o) => o.id);
    try {
      const r = await api.post<{ count: number; soldFor: number }>(`/owned-items/sell-many`, { ids });
      setMessage(`${itemDisplayName(first)} ${r.count}개를 ${r.soldFor.toLocaleString()}원에 팔았어요.`);
      onBalanceChange();
      onProfileChange(); // 전시 중이던 자산이면 프로필에서도 빠진다
      await loadOwned();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "판매에 실패했습니다.");
    }
  }

  async function buy(it: CatalogItem) {
    setError(null);
    setMessage(null);
    const quantity = it.category === "luxury" ? qtyOf(`buy-${it.id}`) : 1;
    try {
      const r = await api.post<{ item: CatalogItem; quantity: number; total: number }>(`/catalog/${it.id}/purchase`, {
        quantity,
      });
      setMessage(
        r.quantity > 1
          ? `${r.item.name} ${r.quantity}개 구매 완료! (${r.total.toLocaleString()}원)`
          : `${r.item.name} 구매 완료!`
      );
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
  // 명품은 같은 상품끼리 한 줄로 묶어 여러 개를 한꺼번에 팔 수 있게 한다(자동차·집은 하나씩).
  const ownedRows: OwnedItem[][] = [];
  const luxuryRows = new Map<number, OwnedItem[]>();
  for (const o of visibleOwned) {
    const row = o.category === "luxury" ? luxuryRows.get(o.catalog_item_id) : undefined;
    if (row) {
      row.push(o);
      continue;
    }
    const created = [o];
    if (o.category === "luxury") luxuryRows.set(o.catalog_item_id, created);
    ownedRows.push(created);
  }

  // 묶인 명품 줄의 전시 토글: 하나라도 전시 중이면 모두 내리고, 아니면 하나만 전시한다.
  async function toggleGroupDisplay(group: OwnedItem[]) {
    const shown = group.filter((o) => o.displayed);
    if (shown.length) await Promise.all(shown.map((o) => api.patch(`/owned-items/${o.id}`, { displayed: false })));
    else await api.patch(`/owned-items/${group[0].id}`, { displayed: true });
    await loadOwned();
    onProfileChange();
  }

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
              {it.category === "luxury" && (
                <input
                  className="qty-input"
                  type="number"
                  min={1}
                  max={100}
                  value={qty[`buy-${it.id}`] ?? "1"}
                  onChange={(e) => setQty((q) => ({ ...q, [`buy-${it.id}`]: e.target.value }))}
                  aria-label={`${itemDisplayName(it)} 구매 수량`}
                />
              )}
              <button className="ghost" onClick={() => buy(it)}>
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
        {ownedRows.map((group) => {
          const o = group[0];
          if (group.length > 1) {
            // 같은 명품 여러 개: 개수만큼 한꺼번에 판다
            const paid = group.filter((g) => g.paidPrice != null);
            const avgPaid = paid.length ? Math.round(paid.reduce((sum, g) => sum + g.paidPrice!, 0) / paid.length) : null;
            const displayed = group.some((g) => g.displayed);
            const sellKey = `sell-${o.catalog_item_id}`;
            return (
              <li key={`lux-${o.catalog_item_id}`}>
                <div>
                  <strong>
                    {itemDisplayName(o)} <span className="muted">×{group.length}</span>
                  </strong>
                  <div className="muted">
                    {avgPaid != null ? `평균 구매 ${avgPaid.toLocaleString()}원` : "선물 받음"} → 지금 팔면 개당{" "}
                    <b>{o.resale.price.toLocaleString()}원</b> (시세 ×{o.resale.ratio})
                  </div>
                </div>
                <div className="catalog-actions">
                  <button className="ghost" onClick={() => setViewAsset({ category: o.category, name: o.name })}>
                    3D
                  </button>
                  <button className={displayed ? "" : "ghost"} onClick={() => toggleGroupDisplay(group)}>
                    {displayed ? "전시 중" : "전시하기"}
                  </button>
                  <input
                    className="qty-input"
                    type="number"
                    min={1}
                    max={group.length}
                    value={qty[sellKey] ?? "1"}
                    onChange={(e) => setQty((q) => ({ ...q, [sellKey]: e.target.value }))}
                    aria-label={`${itemDisplayName(o)} 판매 수량`}
                  />
                  <button className="ghost" onClick={() => setQty((q) => ({ ...q, [sellKey]: String(group.length) }))}>
                    전부
                  </button>
                  <button className="ghost" onClick={() => sellMany(group)}>
                    팔기
                  </button>
                </div>
              </li>
            );
          }
          return (
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
                {o.capitalGainsTax && o.capitalGainsTax.tax > 0 && (
                  <> · 양도세 {Math.round(o.capitalGainsTax.rate * 100)}% -{o.capitalGainsTax.tax.toLocaleString()}원</>
                )}
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
          );
        })}
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
