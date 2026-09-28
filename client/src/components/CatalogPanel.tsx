import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { CatalogItem, OwnedItem } from "../types";

const CATEGORIES: { key: CatalogItem["category"]; label: string }[] = [
  { key: "car", label: "자동차" },
  { key: "apartment", label: "아파트" },
  { key: "luxury", label: "명품" },
];

// README 8~10장: 자동차/아파트/명품 — 구매 → 소유 → 프로필 전시 토글. 명품은 선물도 가능.
export function CatalogPanel({
  onBalanceChange,
  initialCategory,
}: {
  onBalanceChange: () => void;
  initialCategory?: CatalogItem["category"];
}) {
  const [category, setCategory] = useState<CatalogItem["category"]>(initialCategory ?? "car");
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

  useEffect(() => {
    loadItems();
  }, [category]);
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

  return (
    <div className="panel">
      <h3>자산</h3>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

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

      {category === "luxury" && (
        <input
          className="gift-target-input"
          value={giftTarget}
          onChange={(e) => setGiftTarget(e.target.value)}
          placeholder="선물 받을 상대 유저 ID (선물 시 필요)"
        />
      )}

      <ul className="catalog-list">
        {items.map((it) => (
          <li key={it.id}>
            <div>
              <strong>
                {it.brand ? `${it.brand} ` : ""}
                {it.name}
              </strong>
              <div className="muted">{it.price.toLocaleString()}원</div>
            </div>
            <div className="catalog-actions">
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

      <h4>내 소유 자산</h4>
      <ul className="catalog-list">
        {owned.map((o) => (
          <li key={o.id}>
            <div>
              <strong>
                {o.brand ? `${o.brand} ` : ""}
                {o.name}
              </strong>
              <div className="muted">{o.price.toLocaleString()}원</div>
            </div>
            <button className={o.displayed ? "" : "ghost"} onClick={() => toggleDisplay(o.id, o.displayed)}>
              {o.displayed ? "전시 중" : "전시하기"}
            </button>
          </li>
        ))}
        {owned.length === 0 && <p className="muted">아직 소유한 자산이 없습니다.</p>}
      </ul>
    </div>
  );
}
