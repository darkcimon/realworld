import { useEffect, useState } from "react";
import { api } from "../api";
import type { LedgerEntry } from "../types";

// README 6.2 등: 모든 재화 이동은 ledger_entries에 기록된다 — 여기서 잔액과 내역을 함께 보여준다.
export function WalletPanel({ balance }: { balance: number | null }) {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);

  async function load() {
    setLedger(await api.get<LedgerEntry[]>("/wallet/ledger"));
  }

  useEffect(() => {
    load();
  }, [balance]);

  return (
    <div className="panel">
      <h3>지갑</h3>
      <p className="balance-big">{balance === null ? "-" : `${balance.toLocaleString()}원`}</p>
      <ul className="ledger-list">
        {ledger.map((e) => (
          <li key={e.id} className={e.amount >= 0 ? "pos" : "neg"}>
            <span className="ledger-type">{e.type}</span>
            <span className="ledger-amount">
              {e.amount >= 0 ? "+" : ""}
              {e.amount.toLocaleString()}원
            </span>
            <span className="muted">{e.created_at}</span>
          </li>
        ))}
        {ledger.length === 0 && <p className="muted">아직 거래 내역이 없습니다.</p>}
      </ul>
    </div>
  );
}
