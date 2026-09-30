import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { DailyStatus, NotificationsResp, Vitals } from "../types";

// 리텐션 루프 UI: 우상단의 📅(출석/일일 퀘스트)와 🔔(알림) 버튼.
// - 그날 첫 접속에 출석하지 않았다면 출석 패널을 자동으로 띄워 "오늘 할 일"을 바로 보여준다.
// - 뱃지는 화면을 이동할 때(refreshKey)와 30초마다 갱신한다(웹 푸시 대신 앱 안 알림).
const won = (n: number) => `${n.toLocaleString()}원`;

const TYPE_ICON: Record<string, string> = {
  lottery: "🎰",
  salary: "💰",
  heart: "💌",
  match: "💘",
  npc: "🧑‍💼",
};

export function RetentionBar({
  refreshKey,
  onBalanceChange,
  vitals,
}: {
  refreshKey: string;
  onBalanceChange?: () => void;
  vitals?: Vitals | null; // 졸업 후에만 넘어온다 — 달력 옆에 체력 배터리로 표시
}) {
  const [daily, setDaily] = useState<DailyStatus | null>(null);
  const [notif, setNotif] = useState<NotificationsResp | null>(null);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  // 알림창을 열 때 "읽음 처리"를 하더라도 방금 본 새 알림은 강조 표시를 유지하기 위한 스냅샷
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoChecked, setAutoChecked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [d, n] = await Promise.all([
        api.get<DailyStatus>("/daily"),
        api.get<NotificationsResp>("/notifications"),
      ]);
      setDaily(d);
      setNotif(n);
      return d;
    } catch {
      return null; // 구금 중이거나 일시 오류 — 조용히 넘어간다.
    }
  }, []);

  useEffect(() => {
    refresh().then((d) => {
      if (!autoChecked && d) {
        setAutoChecked(true);
        let helpSeen = true;
        try {
          helpSeen = !!localStorage.getItem("rw_help_seen");
        } catch {
          // localStorage 접근 불가 — 자동 표시는 건너뛴다.
        }
        if (!d.attendance.checkedInToday && helpSeen) setDailyOpen(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function checkIn() {
    setError(null);
    try {
      const r = await api.post<{ streak: number; reward: number }>("/daily/checkin");
      setMsg(`🎉 ${r.streak}일 연속 출석! ${won(r.reward)}을 받았어요.`);
      onBalanceChange?.();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "출석 처리에 실패했습니다.");
    }
  }

  async function claim(key: string) {
    setError(null);
    try {
      const r = await api.post<{ reward: number }>(`/daily/quests/${key}/claim`);
      setMsg(`✅ 퀘스트 보상 ${won(r.reward)}을 받았어요.`);
      onBalanceChange?.();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "보상 수령에 실패했습니다.");
    }
  }

  async function openNotif() {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next && notif && notif.unread > 0) {
      setFreshIds(new Set(notif.items.filter((n) => !n.read).map((n) => n.id)));
      await api.post("/notifications/read-all");
      setNotif({ ...notif, unread: 0 });
    }
  }

  return (
    <>
      <div className="retention-bar">
        {vitals && <StaminaBattery vitals={vitals} />}
        <button
          className="retention-btn"
          onClick={() => {
            setMsg(null);
            setError(null);
            setDailyOpen(true);
          }}
          aria-label="출석 및 일일 퀘스트"
          title="출석 · 일일 퀘스트"
        >
          📅
          {!!daily?.pendingCount && <span className="retention-badge">{daily.pendingCount}</span>}
        </button>
        <button className="retention-btn" onClick={openNotif} aria-label="알림" title="알림">
          🔔
          {!!notif?.unread && <span className="retention-badge">{notif.unread}</span>}
        </button>
      </div>

      {notifOpen && (
        <div className="notif-panel">
          <div className="notif-head">
            <strong>알림</strong>
            <button className="ghost" onClick={() => setNotifOpen(false)}>
              ✕
            </button>
          </div>
          <ul>
            {notif?.items.map((n) => (
              <li key={n.id} className={freshIds.has(n.id) ? "fresh" : ""}>
                <span>{TYPE_ICON[n.type] ?? "🔔"}</span>
                <div>
                  <p>{n.message}</p>
                  <small className="muted">{n.created_at.slice(0, 16).replace("T", " ")}</small>
                </div>
              </li>
            ))}
            {notif && notif.items.length === 0 && (
              <li className="muted">아직 알림이 없어요. 로또 결과, 월급, 맞하트 소식이 여기에 도착해요.</li>
            )}
          </ul>
        </div>
      )}

      {dailyOpen && daily && (
        <div className="modal-backdrop" onClick={() => setDailyOpen(false)}>
          <div className="modal daily-modal" onClick={(e) => e.stopPropagation()}>
            <h2>📅 오늘의 출석 · 퀘스트</h2>
            {msg && <p className="ok-text">{msg}</p>}
            {error && <p className="error">{error}</p>}

            <div className="attendance-row">
              {daily.attendance.rewards.map((r, i) => {
                const day = i + 1;
                const { streak, checkedInToday } = daily.attendance;
                // 7일 주기 안에서 이미 도장이 찍힌 칸 수(7일차를 채운 다음 날부터는 새 주기라 0칸)
                const filled = streak === 0 ? 0 : checkedInToday ? ((streak - 1) % 7) + 1 : streak % 7;
                const done = day <= filled;
                const isNext = !checkedInToday && day === daily.attendance.nextDay;
                return (
                  <div key={day} className={`stamp${done ? " done" : ""}${isNext ? " next" : ""}`}>
                    <small>{day}일</small>
                    <span>{done ? "✔" : "🎁"}</span>
                    <small>{r / 10_000}만</small>
                  </div>
                );
              })}
            </div>
            <button disabled={daily.attendance.checkedInToday} onClick={checkIn}>
              {daily.attendance.checkedInToday
                ? `오늘 출석 완료 (${daily.attendance.streak}일 연속)`
                : `출석하고 ${won(daily.attendance.nextReward)} 받기`}
            </button>

            <h3>일일 퀘스트</h3>
            <ul className="quest-list">
              {daily.quests.map((q) => (
                <li key={q.key}>
                  <div className="quest-info">
                    <span>{q.label}</span>
                    <div className="quest-bar">
                      <div style={{ width: `${(q.progress / q.goal) * 100}%` }} />
                    </div>
                    <small className="muted">
                      {q.progress} / {q.goal} · 보상 {won(q.reward)}
                    </small>
                  </div>
                  <button disabled={!q.claimable} onClick={() => claim(q.key)}>
                    {q.claimed ? "받음" : q.claimable ? "받기" : "진행 중"}
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted">매일 자정(KST)에 초기화돼요. 하루 빠지면 연속 출석이 1일차부터 다시 시작해요.</p>
            <button className="modal-close" onClick={() => setDailyOpen(false)}>
              닫기
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** 달력 옆 체력 배터리: 남은 체력 비율만큼 채우고, 적을수록 노랑 → 빨강으로 바뀐다. */
function StaminaBattery({ vitals: v }: { vitals: Vitals }) {
  const pct = Math.max(0, Math.min(100, Math.round((v.stamina / v.maxStamina) * 100)));
  const level = pct > 50 ? "ok" : pct > 20 ? "mid" : "low";
  const label = `체력 ${v.stamina}/${v.maxStamina}`;
  return (
    <div className={`stamina-battery ${level}`} role="img" aria-label={label} title={label}>
      <div className="stamina-battery-body">
        <div className="stamina-battery-fill" style={{ width: `${pct}%` }} />
        <span className="stamina-battery-text">{v.stamina}</span>
      </div>
      <div className="stamina-battery-tip" />
    </div>
  );
}
