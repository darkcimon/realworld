export type FacilityKey =
  | "school"
  | "jobs"
  | "alba"
  | "lottery"
  | "car"
  | "apartment"
  | "luxury"
  | "mart"
  | "jail";

// README 2장의 "게임 내 주요 시설" 전체를 한눈에 보여주는 마을 화면.
// 로그인 직후 학교 채팅방으로 바로 들어가 버리면 "이 게임엔 학교밖에 없나" 오해하기 쉬워서,
// 졸업 전까지 잠겨 있는 시설도 함께 보여주고 학교만 입장 가능하게 한다.
const FACILITIES: { key: FacilityKey; icon: string; label: string }[] = [
  { key: "school", icon: "🏫", label: "학교" },
  { key: "jobs", icon: "💼", label: "직장" },
  { key: "alba", icon: "🧢", label: "알바" },
  { key: "lottery", icon: "🎰", label: "로또" },
  { key: "car", icon: "🚗", label: "자동차" },
  { key: "apartment", icon: "🏢", label: "아파트" },
  { key: "luxury", icon: "💎", label: "명품샵" },
  { key: "mart", icon: "🛒", label: "마트" },
  { key: "jail", icon: "⛓️", label: "감옥" },
];

export function TownHub({
  graduated,
  onSelect,
}: {
  graduated: boolean;
  onSelect: (key: FacilityKey) => void;
}) {
  return (
    <div className="town-hub">
      <p className="town-hub-intro">
        {graduated
          ? "고등학교 졸업! 이제 마을의 모든 시설을 이용할 수 있어요."
          : "이 마을에는 다양한 시설이 있어요. 고등학교 3학년을 졸업하면 학교 밖 시설도 열려요 — 지금은 학교부터 시작해봐요."}
      </p>
      <div className="facility-grid">
        {FACILITIES.map((f) => {
          const enabled = f.key === "school" ? true : f.key === "jail" ? false : graduated;
          return (
            <button
              key={f.key}
              className={`facility-card${enabled ? "" : " locked"}`}
              disabled={!enabled}
              onClick={() => onSelect(f.key)}
              title={
                f.key === "jail"
                  ? "규칙을 어기면 강제로 가게 되는 곳이에요"
                  : enabled
                  ? undefined
                  : "고등학교 3학년 졸업 후 이용 가능합니다"
              }
            >
              <span className="facility-icon">{f.icon}</span>
              <span className="facility-label">{f.label}</span>
              {!enabled && <span className="facility-lock">🔒</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
