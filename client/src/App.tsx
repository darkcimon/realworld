import { useEffect, useState } from "react";
import { api, clearToken, getToken } from "./api";
import type { MoveMode, PlacementInfo, Profile, RoomSummary, Vitals } from "./types";
import { Login } from "./components/Login";
import { ProfileHeader } from "./components/ProfileHeader";
import { RoomList } from "./components/RoomList";
import { LessonRoom } from "./components/LessonRoom";
import { ChatRoom } from "./components/ChatRoom";
import { ExamModal } from "./components/ExamModal";
import { PlacementModal } from "./components/PlacementModal";
import { RetentionBar } from "./components/RetentionBar";
import { JailScreen } from "./components/JailScreen";
import { SocialHub, type FacilityView } from "./components/SocialHub";
import { TownHub, type FacilityKey, type OwnedAsset } from "./components/TownHub";
import { HelpGuide } from "./components/HelpGuide";
import { onVitalsRefresh } from "./vitalsEvents";

type View = "hub" | "rooms" | "lesson" | "chat" | "social";

// 마을 시설 → SocialHub에서 보여줄 화면. 시설 안에서는 그 시설 기능만 쓸 수 있고, 다른 시설로 가려면
// 마을로 나가 걸어가야(차가 있으면 타고) 한다 — 사이드바/탭으로 바로 넘어가는 지름길은 두지 않는다.
// 마트는 별도 화면이 없고 알바 안의 마트 계산원 업무로 구현돼 있어 alba 탭을 쓴다.
// 지갑·매너·인연찾기처럼 특정 건물이 없는 기능은 "내 집"에 모았다.
const FACILITY_VIEWS: Partial<Record<FacilityKey, FacilityView>> = {
  jobs: { title: "💼 직장", tabs: ["jobs"] },
  alba: { title: "🧢 알바", tabs: ["alba"] },
  mart: { title: "🛒 마트", tabs: ["shop", "alba"] },
  lottery: { title: "🎰 로또", tabs: ["lottery"] },
  car: { title: "🚗 자동차 매장", tabs: ["catalog"], catalogCategory: "car" },
  apartment: { title: "🏡 모델하우스", tabs: ["catalog"], catalogCategory: "apartment" },
  luxury: { title: "💎 명품샵", tabs: ["catalog"], catalogCategory: "luxury" },
  home: { title: "🏠 내 집", tabs: ["rest", "wallet", "catalog", "manner", "nearby"], catalogOwnedOnly: true },
};

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [view, setView] = useState<View>("hub");
  const [selectedRoom, setSelectedRoom] = useState<RoomSummary | null>(null);
  const [examOpen, setExamOpen] = useState(false);
  const [placements, setPlacements] = useState<PlacementInfo[]>([]);
  const [placementOpen, setPlacementOpen] = useState<PlacementInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [facility, setFacility] = useState<FacilityView | null>(null);
  const [owned, setOwned] = useState<OwnedAsset[]>([]);
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function loadAll() {
    try {
      const [p, r, pl] = await Promise.all([
        api.get<Profile>("/profile"),
        api.get<RoomSummary[]>("/school/rooms"),
        api.get<PlacementInfo[]>("/school/placement"),
      ]);
      setProfile(p);
      setRooms(r);
      setPlacements(pl);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e.message);
    }
  }

  useEffect(() => {
    if (authed) loadAll();
  }, [authed]);

  // 마을 지도의 내 집/내 차 모습은 소유 자산으로 정해진다. 마을로 돌아올 때마다 새로 받는다(매장에서 샀을 수 있음).
  const graduated = profile?.school.status === "graduated";
  useEffect(() => {
    if (!graduated || view !== "hub") return;
    api
      .get<OwnedAsset[]>("/catalog/owned")
      .then(setOwned)
      .catch(() => {
        /* 못 받아오면 박스집·걷기로 보일 뿐 */
      });
  }, [graduated, view]);

  // 체력(오른쪽 위 배터리·마을 지도): 화면을 옮길 때, 근무로 체력이 줄었을 때, 그리고 자연 회복을 보여주려고 1분마다 새로 받는다.
  useEffect(() => {
    if (!graduated) return;
    const load = () =>
      api
        .get<Vitals>("/town/vitals")
        .then(setVitals)
        .catch(() => {
          /* 체력 표시만 빠진다 */
        });
    load();
    const t = window.setInterval(load, 60_000);
    const off = onVitalsRefresh(load);
    return () => {
      clearInterval(t);
      off();
    };
  }, [graduated, view]);

  // 마을에서 이동할 때마다 서버가 체력/연료를 깎고 이동 방식(걷기/차/지친 걸음)을 정해준다.
  async function moveInTown(): Promise<MoveMode> {
    const r = await api.post<{ mode: MoveMode; vitals: Vitals }>("/town/move");
    setVitals(r.vitals);
    return r.mode;
  }

  // 처음 접속한 브라우저라면 마을 홈 화면과 함께 도움말을 한 번 자동으로 띄워서
  // "학교밖에 없는 게임"으로 오해하지 않게 전체 진행 흐름을 먼저 보여준다.
  useEffect(() => {
    if (!profile) return;
    try {
      if (!localStorage.getItem("rw_help_seen")) setHelpOpen(true);
    } catch {
      // 시크릿 모드 등 localStorage 접근이 막혀 있으면 그냥 자동 표시는 건너뛴다.
    }
  }, [profile]);

  function closeHelp() {
    setHelpOpen(false);
    try {
      localStorage.setItem("rw_help_seen", "1");
    } catch {
      // 저장 실패해도 이번 세션에서 닫히는 데는 문제 없다.
    }
  }

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  if (!profile) {
    return (
      <div className="center-msg">
        {loadError ? <p className="error">{loadError}</p> : <p>불러오는 중...</p>}
      </div>
    );
  }

  if (profile.jail) {
    return (
      <div className="app">
        <JailScreen onReleased={loadAll} />
      </div>
    );
  }

  function logout() {
    clearToken();
    setAuthed(false);
    setProfile(null);
  }

  function enterFacility(key: FacilityKey) {
    if (key === "school") {
      setView("rooms");
      return;
    }
    const next = FACILITY_VIEWS[key];
    if (!next) return; // 감옥은 선택해서 가는 곳이 아니라 규칙 위반 시 강제로 가는 곳
    setFacility(next);
    setView("social");
  }

  function goTo(next: View) {
    setView(next);
    setSidebarOpen(false);
  }

  return (
    <div className="app">
      {/* 프로필/도움말/로그아웃/상단 탭은 화면을 항상 차지할 필요가 없다 — 특히 수업 중에는
          세로 공간이 귀하므로, 필요할 때만 여는 사이드바로 옮기고 평소엔 여는 버튼만 남긴다. */}
      <RetentionBar refreshKey={view} vitals={graduated ? vitals : null} />

      <button
        className="sidebar-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="메뉴 열기"
      >
        ☰
      </button>

      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)}>
          <aside className="sidebar" onClick={(e) => e.stopPropagation()}>
            <button className="sidebar-close" onClick={() => setSidebarOpen(false)}>
              ✕
            </button>
            <ProfileHeader profile={profile} onRefresh={loadAll} />
            <div className="sidebar-actions">
              <button
                className="ghost"
                onClick={() => {
                  setHelpOpen(true);
                  setSidebarOpen(false);
                }}
              >
                ❓ 도움말
              </button>
              <button className="logout" onClick={logout}>
                로그아웃
              </button>
            </div>
            {/* 시설로 바로 가는 지름길은 두지 않는다 — 마을로 돌아가 걸어서(차로) 이동한다. */}
            <div className="tabs sidebar-nav">
              <button className={view === "hub" ? "active" : ""} onClick={() => goTo("hub")}>
                🗺️ 마을로
              </button>
            </div>
          </aside>
        </div>
      )}

      {view === "hub" && (
        <TownHub
          graduated={profile.school.status === "graduated"}
          avatarUrl={profile.avatarUrl}
          owned={owned}
          vitals={vitals}
          onMove={moveInTown}
          onSelect={enterFacility}
        />
      )}

      {view === "social" && facility && (
        <SocialHub key={facility.title} onProfileChange={loadAll} facility={facility} onExit={() => setView("hub")} onVitalsChange={setVitals} />
      )}

      {view === "rooms" && (
        <RoomList
          rooms={rooms}
          placements={placements}
          onPlacement={setPlacementOpen}
          onSelect={(roomId) => {
            const room = rooms.find((r) => r.id === roomId) ?? null;
            setSelectedRoom(room);
            setView("lesson");
          }}
        />
      )}

      {view === "lesson" && selectedRoom && (
        <LessonRoom
          roomId={selectedRoom.id}
          roomLabel={selectedRoom.label}
          onExit={async () => {
            await loadAll();
            setView("rooms");
          }}
          onOpenExam={() => setExamOpen(true)}
          onJoinGroup={() => setView("chat")}
        />
      )}

      {view === "chat" && selectedRoom && (
        <ChatRoom
          roomId={selectedRoom.id}
          roomLabel={selectedRoom.label}
          onExit={async () => {
            await loadAll();
            setView("rooms");
          }}
          onJailed={async () => {
            await loadAll();
            setView("rooms");
          }}
          onOpenExam={() => setExamOpen(true)}
          onBackToLesson={() => setView("lesson")}
        />
      )}

      {examOpen && selectedRoom && (
        <ExamModal
          roomId={selectedRoom.id}
          onClose={() => setExamOpen(false)}
          onDone={async () => {
            // 승급 시험 통과 후 "승급한다"를 누르면 서버는 즉시 grade를 올려주지만,
            // 여기서 loadAll()을 기다리지 않고 setView("rooms")를 먼저 부르면 RoomList가
            // 아직 옛 grade로 계산된 rooms(다음 학년 locked)로 한 번 그려진다. 그 순간의
            // 스냅샷이 눈에 남아 "승급했는데도 잠금이 안 풀린다"로 보이고, 실제로는 그 뒤
            // loadAll 응답이 와서 다시 그려지긴 하지만 체감상 "방을 다시 들어갔다 나와야"
            // 풀리는 것처럼 느껴진다 — 그래서 fetch가 끝난 뒤에 화면을 전환한다.
            await loadAll();
            setView("rooms");
          }}
        />
      )}

      {placementOpen && (
        <PlacementModal
          info={placementOpen}
          onClose={() => setPlacementOpen(null)}
          onDone={async () => {
            await loadAll();
            setView("rooms");
          }}
        />
      )}

      {helpOpen && <HelpGuide onClose={closeHelp} />}
    </div>
  );
}
