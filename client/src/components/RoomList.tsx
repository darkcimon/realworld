import { useState } from "react";
import type { PlacementInfo, RoomSummary } from "../types";

// README 4.1: 상위 탭(초/중/고) 안에 학년별 방. 잠긴 방은 입장 불가.
const LEVELS: Array<{ key: RoomSummary["schoolLevel"]; label: string }> = [
  { key: "elementary", label: "초등학교" },
  { key: "middle", label: "중학교" },
  { key: "high", label: "고등학교" },
];

export function RoomList({
  rooms,
  placements,
  onSelect,
  onPlacement,
}: {
  rooms: RoomSummary[];
  placements: PlacementInfo[];
  onSelect: (roomId: number) => void;
  onPlacement: (info: PlacementInfo) => void;
}) {
  const current = rooms.find((r) => r.isCurrent);
  const [tab, setTab] = useState<RoomSummary["schoolLevel"]>(current?.schoolLevel ?? "elementary");

  const placement = placements.find((x) => x.schoolLevel === tab && x.available);

  return (
    <div className="room-list">
      <div className="tabs">
        {LEVELS.map((l) => (
          <button key={l.key} className={tab === l.key ? "active" : ""} onClick={() => setTab(l.key)}>
            {l.label}
          </button>
        ))}
      </div>
      {placement && (
        <div className="placement-banner">
          <div>
            <strong>🎯 {placement.label} 배치고사</strong>
            <p className="muted">
              {placement.total}문제 중 {placement.passThreshold}문제 이상 맞히면 {placement.label} 졸업장 +{" "}
              {(placement.reward / 10_000).toLocaleString()}만원! 학년별 승급 시험을 건너뛸 수 있어요.
            </p>
          </div>
          <button onClick={() => onPlacement(placement)}>응시하기</button>
        </div>
      )}
      <ul className="rooms">
        {rooms
          .filter((r) => r.schoolLevel === tab)
          .map((r) => (
            <li key={r.id} className={r.unlocked ? "unlocked" : "locked"}>
              <button disabled={!r.unlocked} onClick={() => onSelect(r.id)}>
                {r.unlocked ? "" : "🔒 "}
                {r.grade}학년
                {r.isCurrent && <span className="badge current">현재</span>}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
