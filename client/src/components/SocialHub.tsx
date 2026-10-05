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
import { MartShopPanel } from "./MartShopPanel";
import { HomeRestPanel } from "./HomeRestPanel";
import { StyleShopPanel } from "./StyleShopPanel";
import { BondsPanel, DepositPanel, StocksPanel } from "./FinancePanel";
import type { CatalogItem, Vitals } from "../types";

export type SocialTab = "rest" | "shop" | "wallet" | "jobs" | "alba" | "lottery" | "manner" | "catalog" | "nearby" | "style" | "deposit" | "stocks" | "bonds";
type Tab = SocialTab;

const TABS: { key: Tab; label: string }[] = [
  { key: "rest", label: "쉬기" },
  { key: "shop", label: "장보기" },
  { key: "wallet", label: "지갑" },
  { key: "jobs", label: "직장" },
  { key: "alba", label: "알바" },
  { key: "lottery", label: "로또" },
  { key: "manner", label: "매너" },
  { key: "catalog", label: "자산" },
  { key: "nearby", label: "인연찾기" },
  { key: "style", label: "스타일샵" },
  { key: "deposit", label: "예금" },
  { key: "stocks", label: "주식" },
  { key: "bonds", label: "채권" },
];

/** 마을 시설 하나에 들어왔을 때 보여줄 것. 다른 시설로 가려면 마을로 나가서 걸어가야 한다. */
export interface FacilityView {
  title: string;
  tabs: SocialTab[]; // 이 시설 안에서 볼 수 있는 탭(1개면 탭 줄을 숨긴다)
  catalogCategory?: CatalogItem["category"]; // 자산 매장이면 그 카테고리로 고정
  catalogOwnedOnly?: boolean; // 내 집: 매장 없이 소유 자산만
}

// README 6~11장(사회 생활/로또/자산/소셜): 처음부터 열려 있는 사회 콘텐츠를 시설 단위로 보여준다.
export function SocialHub({
  onProfileChange,
  facility,
  notice,
  onExit,
  onVitalsChange,
  chatJump,
}: {
  onProfileChange: () => void;
  facility: FacilityView;
  notice?: string | null; // 시설에 들어올 때 한 번 보여줄 안내(예: 집 주차장 주유)
  onExit: () => void;
  onVitalsChange: (v: Vitals) => void;
  chatJump?: { targetId: number | null; seq: number } | null; // 메시지 알림 클릭으로 들어온 경우
}) {
  const [tab, setTab] = useState<Tab>(facility.tabs[0]);
  const [balance, setBalance] = useState<number | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [autoChat, setAutoChat] = useState(false); // 프로필을 열면서 바로 대화창까지 연다

  function openPerson(userId: number, openChat = false) {
    setPersonId(userId);
    setAutoChat(openChat);
  }

  // 메시지 알림을 누르면 인연찾기 탭으로 옮기고, 한 사람이면 그 대화를 바로 연다(여러 명이면 대화 목록만 보여준다).
  useEffect(() => {
    if (!chatJump || !facility.tabs.includes("nearby")) return;
    setTab("nearby");
    if (chatJump.targetId != null) openPerson(chatJump.targetId, true);
    else setPersonId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatJump?.seq]);

  async function refreshBalance() {
    const w = await api.get<{ balance: number }>("/wallet/me");
    setBalance(w.balance);
  }

  useEffect(() => {
    refreshBalance();
  }, []);

  return (
    <div className="social-hub">
      <div className="facility-head">
        <button className="ghost" onClick={onExit}>
          ← 마을로
        </button>
        <strong>{facility.title}</strong>
      </div>
      {notice && <p className="ok-text">{notice}</p>}
      <div className="wallet-bar">
        💰 {balance === null ? "불러오는 중..." : `${balance.toLocaleString()}원`}
      </div>
      {facility.tabs.length > 1 && (
      <div className="tabs sub-tabs">
        {TABS.filter((t) => facility.tabs.includes(t.key)).map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      )}

      {tab === "rest" && <HomeRestPanel onVitalsChange={onVitalsChange} />}
      {tab === "shop" && <MartShopPanel onBalanceChange={refreshBalance} onVitalsChange={onVitalsChange} />}
      {tab === "wallet" && <WalletPanel balance={balance} />}
      {tab === "jobs" && <JobsPanel onBalanceChange={refreshBalance} />}
      {tab === "alba" && <AlbaPanel onBalanceChange={refreshBalance} />}
      {tab === "lottery" && <LotteryPanel onBalanceChange={refreshBalance} />}
      {tab === "manner" && <MannerPanel onBalanceChange={refreshBalance} />}
      {tab === "catalog" && (
        <CatalogPanel
          onBalanceChange={refreshBalance}
          onProfileChange={onProfileChange}
          fixedCategory={facility.catalogCategory}
          ownedOnly={facility.catalogOwnedOnly}
        />
      )}
      {tab === "nearby" && <NearbyPanel onOpenPerson={openPerson} focusConversationsKey={chatJump?.seq} />}
      {tab === "deposit" && <DepositPanel onBalanceChange={refreshBalance} />}
      {tab === "stocks" && <StocksPanel onBalanceChange={refreshBalance} />}
      {tab === "bonds" && <BondsPanel onBalanceChange={refreshBalance} />}
      {tab === "style" && <StyleShopPanel onBalanceChange={refreshBalance} onProfileChange={onProfileChange} />}

      {personId !== null && (
        <PersonPanel
          targetId={personId}
          autoOpenChat={autoChat}
          onClose={() => setPersonId(null)}
          onBalanceChange={refreshBalance}
          onJailed={onProfileChange}
        />
      )}
    </div>
  );
}
