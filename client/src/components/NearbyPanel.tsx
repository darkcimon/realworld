import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { IncomingHeart, MatchSummary, NearbyUser } from "../types";

// README 11.2: 위치(자동 GPS/수동, 수동은 24시간 1회) 및 반경 50km 내 유저 찾기.
// 더불어 받은 하트/성립된 맞하트 목록도 함께 보여줘 실제로 채팅 상대를 고를 수 있게 한다.
export function NearbyPanel({ onOpenPerson }: { onOpenPerson: (userId: number) => void }) {
  const [nearby, setNearby] = useState<NearbyUser[]>([]);
  const [incoming, setIncoming] = useState<IncomingHeart[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadNearby() {
    try {
      setNearby(await api.get<NearbyUser[]>("/nearby?radiusKm=50"));
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
      <h3>주변 사람 찾기</h3>
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
          주변 사람 다시 찾기
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

      <h4>반경 50km 이내</h4>
      <ul className="catalog-list">
        {nearby.map((u) => (
          <li key={u.userId}>
            <div>
              <strong>{u.nickname}</strong>
              <div className="muted">{u.distanceKm}km</div>
            </div>
            <button className="ghost" onClick={() => onOpenPerson(u.userId)}>
              프로필 보기
            </button>
          </li>
        ))}
        {nearby.length === 0 && (
          <p className="muted">위치를 설정하고 "주변 사람 다시 찾기"를 눌러보세요.</p>
        )}
      </ul>
    </div>
  );
}
