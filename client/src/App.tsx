import { useEffect, useState } from "react";
import { api, clearToken, getToken } from "./api";
import type { MoveMode, PlacementInfo, Profile, RoomSummary, Vitals } from "./types";
import { Login } from "./components/Login";
import { ProfileHeader } from "./components/ProfileHeader";
import { SaveAccountModal } from "./components/SaveAccountModal";
import { CharacterStudio } from "./character/CharacterStudio";
import { confirmDialog } from "./components/ConfirmDialog";
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
import { SidebarAssets } from "./components/SidebarAssets";
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
  style: { title: "👗 스타일샵", tabs: ["style"] },
  bank: { title: "🏦 금융", tabs: ["deposit", "stocks", "bonds"] },
  home: { title: "🏠 내 집", tabs: ["rest", "wallet", "catalog", "manner", "nearby"], catalogOwnedOnly: true },
};

// 메시지 알림을 눌렀을 때만 들어가는 화면. 마을을 걸어가지 않는 예외라서 인연찾기(대화) 탭만 연다.
const CHAT_FACILITY: FacilityView = { title: "💬 대화", tabs: ["nearby"] };

const SAVE_NUDGE_KEY = "rw_save_nudge_at";
const CHARACTER_SKIP_KEY = "rw_character_skipped";

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
  const [facilityNotice, setFacilityNotice] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [saveNudge, setSaveNudge] = useState(false);
  const [firstStudio, setFirstStudio] = useState(false);
  // 알림에서 대화로 이동: targetId가 있으면 그 사람과의 대화, null이면 대화 목록. seq로 같은 요청도 다시 반영한다.
  const [chatJump, setChatJump] = useState<{ targetId: number | null; seq: number } | null>(null);

  async function loadAll() {
    try {
      const [p, r, pl] = await Promise.all([
        api.get<Profile>("/profile"),
        api.get<RoomSummary[]>("/school/rooms"),
        api.get<PlacementInfo[]>("/school/placement"),
      ]);
      setProfile(p);
      // 캐릭터가 없으면 처음 한 번 "나만의 캐릭터 만들기"를 띄운다(그때는 저장 권유를 미룬다).
      if (!p.character && !characterSkipped()) setFirstStudio(true);
      else maybeNudgeSave(p);
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
  useEffect(() => {
    if (!authed || view !== "hub") return;
    api
      .get<OwnedAsset[]>("/catalog/owned")
      .then(setOwned)
      .catch(() => {
        /* 못 받아오면 박스집·걷기로 보일 뿐 */
      });
  }, [authed, view]);

  // 체력(오른쪽 위 배터리·마을 지도): 화면을 옮길 때, 근무로 체력이 줄었을 때, 그리고 자연 회복을 보여주려고 1분마다 새로 받는다.
  useEffect(() => {
    if (!authed) return;
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
  }, [authed, view]);

  // 마을에서 이동할 때마다 서버가 체력/연료를 깎고 이동 방식(걷기/차/지친 걸음)을 정해준다.
  async function moveInTown(to: FacilityKey): Promise<MoveMode> {
    const r = await api.post<{ mode: MoveMode; cells: number; homeRefuel: number; vitals: Vitals }>("/town/move", { to });
    setVitals(r.vitals);
    // 차를 몰고 집에 오면 주차장에서 연료를 조금 채워 준다(서버, 쿨타임 있음) — 집 화면에 알려준다.
    setFacilityNotice(r.homeRefuel > 0 ? `🅿️ 집 주차장에서 연료를 ${r.homeRefuel}칸 채웠어요.` : null);
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

  function characterSkipped(): boolean {
    try {
      return !!localStorage.getItem(CHARACTER_SKIP_KEY);
    } catch {
      return true; // 저장소를 못 쓰면 매번 뜰 수 있으니 자동으로 띄우지 않는다
    }
  }

  // 진행이 쌓인 비회원(졸업장이 하나라도 있으면)에게 하루 한 번 계정 저장을 권한다.
  function maybeNudgeSave(p: Profile) {
    if (!p.isGuest || p.graduations.length === 0) return;
    try {
      const last = Number(localStorage.getItem(SAVE_NUDGE_KEY) ?? 0);
      if (Date.now() - last < 24 * 60 * 60 * 1000) return;
      localStorage.setItem(SAVE_NUDGE_KEY, String(Date.now()));
    } catch {
      return; // 저장소를 못 쓰면 매번 뜰 수 있으니 띄우지 않는다.
    }
    setSaveNudge(true);
  }

  async function logout() {
    // 비회원은 토큰이 계정의 유일한 열쇠라 로그아웃하면 다시 들어올 수 없다.
    if (
      profile?.isGuest &&
      !(await confirmDialog(
        "비회원은 로그아웃하면 지금까지의 진행(학력·돈·자산)을 다시 찾을 수 없어요.\n먼저 사이드 메뉴의 '계정 저장하기'로 저장하는 걸 추천해요.",
        { title: "정말 로그아웃할까요?", confirmText: "그래도 로그아웃" }
      ))
    ) {
      return;
    }
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
    setChatJump(null); // 예전에 알림으로 들어왔던 요청이 다시 실행되지 않게
    setView("social");
  }

  function openChatFromNotif(targetId: number | null) {
    // 이미 인연찾기가 있는 시설(내 집) 안이면 그대로 두고, 아니면 대화 탭만 있는 화면을 연다.
    if (!(view === "social" && facility?.tabs.includes("nearby"))) setFacility(CHAT_FACILITY);
    setFacilityNotice(null);
    setChatJump({ targetId, seq: Date.now() });
    setView("social");
    setSidebarOpen(false);
  }

  function goTo(next: View) {
    setView(next);
    setSidebarOpen(false);
    window.scrollTo(0, 0); // 긴 화면 아래쪽에서 이동해도 지도 맨 위부터 보이게
  }

  return (
    <div className="app">
      {/* 프로필/도움말/로그아웃/상단 탭은 화면을 항상 차지할 필요가 없다 — 특히 수업 중에는
          세로 공간이 귀하므로, 필요할 때만 여는 사이드바로 옮기고 평소엔 여는 버튼만 남긴다. */}
      <RetentionBar
        refreshKey={view}
        vitals={vitals}
        onGoTown={view === "hub" ? undefined : () => goTo("hub")}
        onOpenChat={openChatFromNotif}
      />

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
            <SidebarAssets />
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
          avatarUrl={profile.avatarUrl}
          owned={owned}
          vitals={vitals}
          onMove={moveInTown}
          onSelect={enterFacility}
        />
      )}

      {view === "social" && facility && (
        <SocialHub key={facility.title} onProfileChange={loadAll} facility={facility} notice={facilityNotice} onExit={() => setView("hub")} onVitalsChange={setVitals} chatJump={chatJump} />
      )}

      {view === "rooms" && (
        <RoomList
          rooms={rooms}
          placements={placements}
          education={profile.education}
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
      {firstStudio && profile && (
        <CharacterStudio
          firstTime
          initial={null}
          photoUrl={profile.avatarUrl}
          onClose={() => {
            setFirstStudio(false);
            try {
              localStorage.setItem(CHARACTER_SKIP_KEY, "1");
            } catch {
              // 다음 접속 때 다시 뜰 수 있지만 문제는 없다
            }
          }}
          onSaved={() => {
            setFirstStudio(false);
            loadAll();
          }}
        />
      )}
      {saveNudge && (
        <SaveAccountModal
          reason="🎓 졸업장까지 땄네요! 지금까지의 진행을 잃지 않게 저장해 두세요."
          onClose={() => setSaveNudge(false)}
          onSaved={() => {
            setSaveNudge(false);
            loadAll();
          }}
        />
      )}
    </div>
  );
}
