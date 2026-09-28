import { useEffect, useState } from "react";
import { api } from "../api";
import { WalletPanel } from "./WalletPanel";
import { JobsPanel } from "./JobsPanel";
import { AlbaPanel } from "./AlbaPanel";
import { LotteryPanel } from "./LotteryPanel";
import { MannerPanel } from "./MannerPanel";
import { CatalogPanel } from "./CatalogPanel";
import { NearbyPanel } from "./NearbyPanel";
import { PersonPanel } from "./PersonPanel";
import type { CatalogItem } from "../types";

export type SocialTab = "wallet" | "jobs" | "alba" | "lottery" | "manner" | "catalog" | "nearby";
type Tab = SocialTab;

const TABS: { key: Tab; label: string }[] = [
  { key: "wallet", label: "지갑" },
  { key: "jobs", label: "직장" },
  { key: "alba", label: "알바" },
  { key: "lottery", label: "로또" },
  { key: "manner", label: "매너" },
  { key: "catalog", label: "자산" },
  { key: "nearby", label: "주변사람" },
];

// README 6~11장(사회 생활/로또/자산/소셜): 고3 졸업 후 열리는 사회 콘텐츠 전체를 탭으로 묶는다.
export function SocialHub({
  onProfileChange,
  initialTab,
  initialCatalogCategory,
}: {
  onProfileChange: () => void;
  initialTab?: SocialTab;
  initialCatalogCategory?: CatalogItem["category"];
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "wallet");
  const [balance, setBalance] = useState<number | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);

  async function refreshBalance() {
    const w = await api.get<{ balance: number }>("/wallet/me");
    setBalance(w.balance);
  }

  useEffect(() => {
    refreshBalance();
  }, []);

  return (
    <div className="social-hub">
      <div className="wallet-bar">
        💰 {balance === null ? "불러오는 중..." : `${balance.toLocaleString()}원`}
      </div>
      <div className="tabs sub-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "wallet" && <WalletPanel balance={balance} />}
      {tab === "jobs" && <JobsPanel onBalanceChange={refreshBalance} />}
      {tab === "alba" && <AlbaPanel onBalanceChange={refreshBalance} />}
      {tab === "lottery" && <LotteryPanel onBalanceChange={refreshBalance} />}
      {tab === "manner" && <MannerPanel onBalanceChange={refreshBalance} />}
      {tab === "catalog" && (
        <CatalogPanel onBalanceChange={refreshBalance} initialCategory={initialCatalogCategory} />
      )}
      {tab === "nearby" && <NearbyPanel onOpenPerson={setPersonId} />}

      {personId !== null && (
        <PersonPanel
          targetId={personId}
          onClose={() => setPersonId(null)}
          onBalanceChange={refreshBalance}
          onJailed={onProfileChange}
        />
      )}
    </div>
  );
}
