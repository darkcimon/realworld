import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { IncomingHeart, MatchSummary, NearbyUser } from "../types";

// README 11.2: 위치(자동 GPS/수동, 수동은 24시간 1회) 및 가까운 순 유저 찾기(거리는 구간 라벨로만 표시).
// 목록이 길어지면 거리 구간·최근 접속·사진·매너·하트 보낸 상대 숨기기 필터로 좁혀 본다.
// 더불어 받은 하트/성립된 맞하트 목록도 함께 보여줘 실제로 채팅 상대를 고를 수 있게 한다.
// 거리 필터: NearbyUser.distanceBucket 이 maxBucket 이하인 사람만. null 이면 전체.
const DISTANCE_FILTERS: { label: string; maxBucket: number | null }[] = [
  { label: "전체", maxBucket: null },
  { label: "30km", maxBucket: 0 },
  { label: "50km", maxBucket: 1 },
  { label: "100km", maxBucket: 2 },
  { label: "200km", maxBucket: 3 },
];

const TOGGLE_FILTERS = [
  { key: "recentlyActive", label: "🟢 최근 접속" },
  { key: "hasPhoto", label: "📷 사진 있음" },
  { key: "goodManner", label: "😇 매너 좋음" },
  { key: "hideHeartSent", label: "💌 하트 보낸 사람 숨기기" },
] as const;
type ToggleKey = (typeof TOGGLE_FILTERS)[number]["key"];

export function NearbyPanel({ onOpenPerson }: { onOpenPerson: (userId: number) => void }) {
  const [nearby, setNearby] = useState<NearbyUser[]>([]);
  const [incoming, setIncoming] = useState<IncomingHeart[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [maxBucket, setMaxBucket] = useState<number | null>(null);
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>({
    recentlyActive: false,
    hasPhoto: false,
    goodManner: false,
    hideHeartSent: false,
  });

  const filtered = useMemo(
    () =>
      nearby.filter(
        (u) =>
          (maxBucket === null || u.distanceBucket <= maxBucket) &&
          (!toggles.recentlyActive || u.recentlyActive) &&
          (!toggles.hasPhoto || u.hasPhoto) &&
          (!toggles.goodManner || u.goodManner) &&
          (!toggles.hideHeartSent || !u.heartSent)
      ),
    [nearby, maxBucket, toggles]
  );

  async function loadNearby() {
    try {
      setNearby(await api.get<NearbyUser[]>("/nearby"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "먼저 위치를 설정해주세요.");
    }
  }
  async function loadIncoming() {
    setIncoming(await api.get<IncomingHeart[]>("/hearts/incoming"));
  }
  async function loadMatches() {
    setMatches(await api.get<MatchSummary[]>("/matches"));
  }

  useEffect(() => {
    loadIncoming();
    loadMatches();
  }, []);

  async function useGps() {
    setError(null);
    setMessage(null);
    if (!navigator.geolocation) {
      setError("이 브라우저는 위치 정보를 지원하지 않습니다.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await api.put("/location", { lat: pos.coords.latitude, lng: pos.coords.longitude });
        setMessage("현재 위치로 설정했습니다.");
        await loadNearby();
      },
      () => setError("위치 정보를 가져오지 못했습니다.")
    );
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.put("/location/manual", { lat: Number(manualLat), lng: Number(manualLng) });
      setMessage("수동 위치로 설정했습니다.");
      await loadNearby();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "수동 위치 변경은 24시간에 1회만 가능합니다.");
    }
  }

  async function reciprocate(senderId: number) {
    setError(null);
    setMessage(null);
    try {
      await api.post(`/hearts/${senderId}/reciprocate`);
      setMessage("맞하트가 성립되었습니다!");
      await loadIncoming();
      await loadMatches();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "맞하트에 실패했습니다.");
    }
  }

  return (
    <div className="panel">
      <h3>인연 찾기</h3>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      <div className="location-controls">
        <button className="ghost" onClick={useGps}>
          📍 내 위치 자동 설정(GPS)
        </button>
        <form className="manual-location-form" onSubmit={submitManual}>
          <input
            value={manualLat}
            onChange={(e) => setManualLat(e.target.value)}
            placeholder="위도(lat)"
          />
          <input
            value={manualLng}
            onChange={(e) => setManualLng(e.target.value)}
            placeholder="경도(lng)"
          />
          <button type="submit" className="ghost">
            수동 설정 (하루 1회)
          </button>
        </form>
        <button className="ghost" onClick={loadNearby}>
          내 주변 인연 찾기
        </button>
      </div>

      {incoming.length > 0 && (
        <>
          <h4>나에게 온 하트 💌</h4>
          <ul className="catalog-list">
            {incoming.map((h) => (
              <li key={h.senderId}>
                <span>{h.nickname}</span>
                <div className="catalog-actions">
                  <button className="ghost" onClick={() => onOpenPerson(h.senderId)}>
                    프로필
                  </button>
                  <button onClick={() => reciprocate(h.senderId)}>맞하트 보내기</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {matches.length > 0 && (
        <>
          <h4>맞하트 성립 💞</h4>
          <ul className="catalog-list">
            {matches.map((m) => (
              <li key={m.userId}>
                <span>{m.nickname}</span>
                <button className="ghost" onClick={() => onOpenPerson(m.userId)}>
                  대화하기
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>
        가까운 순 {nearby.length > 0 && <span className="muted">({filtered.length}/{nearby.length}명)</span>}
      </h4>
      {nearby.length > 0 && (
        <div className="nearby-filters">
          <div className="filter-row">
            {DISTANCE_FILTERS.map((f) => (
              <button
                key={f.label}
                className={`filter-chip${maxBucket === f.maxBucket ? " active" : ""}`}
                onClick={() => setMaxBucket(f.maxBucket)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="filter-row">
            {TOGGLE_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`filter-chip${toggles[f.key] ? " active" : ""}`}
                onClick={() => setToggles((t) => ({ ...t, [f.key]: !t[f.key] }))}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <ul className="catalog-list">
        {filtered.map((u) => (
          <li key={u.userId}>
            <div>
              <strong>{u.nickname}</strong>
              <div className="muted">
                {u.distanceLabel}
                {u.recentlyActive && " · 최근 접속"}
                {u.heartSent && " · 하트 보냄"}
              </div>
            </div>
            <button className="ghost" onClick={() => onOpenPerson(u.userId)}>
              프로필 보기
            </button>
          </li>
        ))}
        {nearby.length > 0 && filtered.length === 0 && (
          <p className="muted">조건에 맞는 사람이 없어요. 필터를 줄여보세요.</p>
        )}
        {nearby.length === 0 && (
          <p className="muted">위치를 설정하고 "내 주변 인연 찾기"를 눌러보세요.</p>
        )}
      </ul>
    </div>
  );
}
