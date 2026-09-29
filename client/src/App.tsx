import { useEffect, useState } from "react";
import { api, clearToken, getToken } from "./api";
import type { CatalogItem, PlacementInfo, Profile, RoomSummary } from "./types";
import { Login } from "./components/Login";
import { ProfileHeader } from "./components/ProfileHeader";
import { RoomList } from "./components/RoomList";
import { LessonRoom } from "./components/LessonRoom";
import { ChatRoom } from "./components/ChatRoom";
import { ExamModal } from "./components/ExamModal";
import { PlacementModal } from "./components/PlacementModal";
import { RetentionBar } from "./components/RetentionBar";
import { JailScreen } from "./components/JailScreen";
import { SocialHub, type SocialTab } from "./components/SocialHub";
import { TownHub, type FacilityKey } from "./components/TownHub";
import { HelpGuide } from "./components/HelpGuide";

type View = "hub" | "rooms" | "lesson" | "chat" | "social";

// TownHub의 시설 카드를 실제로 이미 구현돼 있는 SocialHub 탭으로 연결한다.
// 자동차/아파트/명품샵은 모두 "자산(catalog)" 탭 안 카테고리라서 initialCatalogCategory로 구분하고,
// 마트는 별도 화면이 없고 알바 안의 마트 계산원 업무로 구현돼 있어 alba 탭으로 보낸다.
const FACILITY_TO_SOCIAL_TAB: Partial<Record<FacilityKey, SocialTab>> = {
  jobs: "jobs",
  alba: "alba",
  lottery: "lottery",
  mart: "alba",
  car: "catalog",
  apartment: "catalog",
  luxury: "catalog",
};
const FACILITY_TO_CATALOG_CATEGORY: Partial<Record<FacilityKey, CatalogItem["category"]>> = {
  car: "car",
  apartment: "apartment",
  luxury: "luxury",
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
  const [socialTab, setSocialTab] = useState<SocialTab | undefined>();
  const [catalogCategory, setCatalogCategory] = useState<CatalogItem["category"] | undefined>();
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
    if (key === "jail") return; // 감옥은 선택해서 가는 곳이 아니라 규칙 위반 시 강제로 가는 곳
    setSocialTab(FACILITY_TO_SOCIAL_TAB[key]);
    setCatalogCategory(FACILITY_TO_CATALOG_CATEGORY[key]);
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
      <RetentionBar refreshKey={view} />

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
            <div className="tabs sidebar-nav">
              <button className={view === "hub" ? "active" : ""} onClick={() => goTo("hub")}>
                🏠 홈
              </button>
              <button
                className={view === "rooms" || view === "lesson" || view === "chat" ? "active" : ""}
                onClick={() => goTo("rooms")}
              >
                🏫 학교
              </button>
              {profile.school.status === "graduated" && (
                <button className={view === "social" ? "active" : ""} onClick={() => goTo("social")}>
                  🏙️ 사회
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      {view === "hub" && (
        <TownHub
          graduated={profile.school.status === "graduated"}
          avatarUrl={profile.avatarUrl}
          onSelect={enterFacility}
        />
      )}

      {view === "social" && (
        <SocialHub onProfileChange={loadAll} initialTab={socialTab} initialCatalogCategory={catalogCategory} />
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
