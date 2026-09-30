import { Suspense, useEffect, useState } from "react";
import { api } from "../api";
import type { OwnedItem, Vitals } from "../types";
import { requestVitalsRefresh } from "../vitalsEvents";
import { assetIcon } from "../assetIcons";
import { itemDisplayName } from "../itemName";
import { AssetViewer } from "./CatalogPanel";
import type { AssetCategory } from "./AssetViewer";

// 사이드바의 내 현금 + 소유 자산(이모지). 이모지를 누르면 그 자산을 3D로 본다.
// 사이드바는 열 때마다 새로 그려지므로 열 때마다 최신 값을 받아온다.
export function SidebarAssets({ graduated }: { graduated: boolean }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [owned, setOwned] = useState<OwnedItem[] | null>(null);
  const [view, setView] = useState<{ category: AssetCategory; name: string } | null>(null);
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [carError, setCarError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ balance: number }>("/wallet/me")
      .then((w) => setBalance(w.balance))
      .catch(() => {});
    // 자산은 졸업 후에만 살 수 있다(학생은 자산 API 자체가 막혀 있음).
    if (graduated) {
      api
        .get<OwnedItem[]>("/catalog/owned")
        .then(setOwned)
        .catch(() => setOwned([]));
      api
        .get<Vitals>("/town/vitals")
        .then(setVitals)
        .catch(() => {});
    }
  }, [graduated]);

  async function chooseCar(ownedItemId: number) {
    setCarError(null);
    try {
      setVitals(await api.post<Vitals>("/town/car", { ownedItemId }));
      requestVitalsRefresh(); // 마을 지도의 차 모습·연료 게이지도 바로 바뀌게
    } catch (e: any) {
      setCarError(e?.message ?? "차를 바꾸지 못했어요.");
    }
  }

  // 같은 자산을 여러 개 가졌으면 한 칸에 ×N으로 묶는다. 집 → 차 → 명품, 비싼 순.
  const order = { apartment: 0, car: 1, luxury: 2 } as Record<string, number>;
  const groups = new Map<string, { item: OwnedItem; count: number }>();
  for (const o of owned ?? []) {
    const k = `${o.category}|${o.name}`;
    const g = groups.get(k);
    if (g) g.count += 1;
    else groups.set(k, { item: o, count: 1 });
  }
  const tiles = [...groups.values()].sort(
    (a, b) => (order[a.item.category] ?? 9) - (order[b.item.category] ?? 9) || b.item.price - a.item.price
  );

  return (
    <section className="sidebar-assets">
      <div className="sidebar-cash">
        <span>💰 현금</span>
        <b>{balance === null ? "…" : `${balance.toLocaleString()}원`}</b>
      </div>
      {graduated && (
        <>
          <div className="sidebar-assets-title">내 자산</div>
          {owned && tiles.length === 0 && <p className="muted sidebar-assets-empty">아직 가진 자산이 없어요.</p>}
          <div className="sidebar-asset-grid">
            {tiles.map(({ item, count }) => (
              <button
                key={`${item.category}|${item.name}`}
                type="button"
                className={`sidebar-asset${item.category === "car" && vitals?.car?.name === item.name ? " driving" : ""}`}
                title={`${itemDisplayName(item)} — 눌러서 3D로 보기`}
                aria-label={`${itemDisplayName(item)}${count > 1 ? ` ${count}개` : ""} 3D로 보기`}
                onClick={() => setView({ category: item.category, name: item.name })}
              >
                <span className="sidebar-asset-icon">{assetIcon(item.category, item.name)}</span>
                {count > 1 && <span className="sidebar-asset-count">×{count}</span>}
              </button>
            ))}
          </div>

          {vitals && vitals.cars.length > 0 && (
            <>
              <div className="sidebar-assets-title">🚗 운행할 차</div>
              {carError && <p className="error sidebar-assets-empty">{carError}</p>}
              <div className="sidebar-car-list">
                {vitals.cars.map((c) => (
                  <button
                    key={c.ownedItemId}
                    type="button"
                    className={`sidebar-car${c.active ? " active" : ""}`}
                    disabled={c.active}
                    aria-pressed={c.active}
                    onClick={() => chooseCar(c.ownedItemId)}
                  >
                    <span className="sidebar-car-icon">{assetIcon("car", c.name)}</span>
                    <span className="sidebar-car-info">
                      <b>{c.name}</b>
                      <span className="sidebar-car-fuel">
                        <span className="sidebar-car-fuel-bar">
                          <span style={{ width: `${Math.round((c.fuel / c.tank) * 100)}%` }} />
                        </span>
                        ⛽ {c.fuel}/{c.tank}칸
                      </span>
                    </span>
                    <span className="sidebar-car-state">{c.active ? "운행 중" : "타기"}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {view && (
        <Suspense fallback={null}>
          <AssetViewer {...view} onClose={() => setView(null)} />
        </Suspense>
      )}
    </section>
  );
}
