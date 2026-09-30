import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ShopMenu, Vitals } from "../types";

// 마트 장보기: 음식을 사 먹어 체력을 채우고, 차가 있으면 부족한 연료를 채운다(가격·효과는 서버 economy.ts VITALS).
export function MartShopPanel({
  onBalanceChange,
  onVitalsChange,
}: {
  onBalanceChange: () => void;
  onVitalsChange: (v: Vitals) => void;
}) {
  const [menu, setMenu] = useState<ShopMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const m = await api.get<ShopMenu>("/town/shop");
    setMenu(m);
    onVitalsChange(m.vitals);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "메뉴를 불러오지 못했어요."));
  }, []);

  async function run(fn: () => Promise<string>) {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      setMessage(await fn());
      onBalanceChange();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "구매에 실패했어요.");
    } finally {
      setBusy(false);
    }
  }

  const eat = (key: string, name: string) =>
    run(async () => {
      const r = await api.post<{ gained: number }>("/town/shop/food", { key });
      return `${name} 냠냠! 체력 +${r.gained}`;
    });

  const refuel = () =>
    run(async () => {
      const r = await api.post<{ paid: number }>("/town/shop/fuel");
      return `⛽ 가득 주유 완료 (${r.paid.toLocaleString()}원)`;
    });

  const v = menu?.vitals;
  const full = !!v && v.stamina >= v.maxStamina;

  return (
    <div className="panel">
      <h3>장보기</h3>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}
      {v && (
        <p className="muted">
          💪 체력 {v.stamina}/{v.maxStamina} · 걸어서 한 번 이동할 때 {v.walkCost}씩 줄고, 가만히 있어도 1시간에{" "}
          {v.regenPerHour}씩 차요.
        </p>
      )}

      <h4>먹을거리</h4>
      <ul className="catalog-list">
        {menu?.foods.map((f) => (
          <li key={f.key}>
            <div>
              <strong>{f.name}</strong>
              <div className="muted">
                {f.price.toLocaleString()}원 · 체력 +{f.stamina}
              </div>
            </div>
            <div className="catalog-actions">
              <button className="ghost" disabled={busy || full} onClick={() => eat(f.key, f.name)}>
                사 먹기
              </button>
            </div>
          </li>
        ))}
      </ul>
      {full && <p className="muted">배가 불러요. 체력이 가득할 땐 먹을 수 없어요.</p>}

      <h4>주유</h4>
      {!v?.car ? (
        <p className="muted">차가 없어요. 자동차 매장에서 차를 사면 연료를 넣고 빠르게 다닐 수 있어요.</p>
      ) : (
        <ul className="catalog-list">
          <li>
            <div>
              <strong>⛽ {v.car.name} 가득 채우기</strong>
              <div className="muted">
                남은 연료 {v.fuel}/{v.fuelCapacity}칸
                {menu?.fuel && menu.fuel.missing > 0 && ` · ${menu.fuel.price.toLocaleString()}원 (부족한 ${menu.fuel.missing}칸분)`}
              </div>
            </div>
            <div className="catalog-actions">
              <button className="ghost" disabled={busy || !menu?.fuel || menu.fuel.missing <= 0} onClick={refuel}>
                주유
              </button>
            </div>
          </li>
        </ul>
      )}
    </div>
  );
}
