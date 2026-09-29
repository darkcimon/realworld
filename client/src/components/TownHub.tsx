import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

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

// 마을 지도(홈 화면). README 2장의 "게임 내 주요 시설"을 작은 2.5D 마을로 보여주고, 건물을 누르면 내 캐릭터가
// 도로를 따라 걸어가서(최단 경로) 문 앞에 도착한 뒤 그 시설로 들어간다.
// 졸업 전에는 학교만 들어갈 수 있고, 잠긴 시설은 걸어가서 말풍선으로 이유를 알려준다.
// three.js 대신 SVG로 그려서 홈 화면은 가볍게 바로 뜬다(3D 뷰어는 자산 상세에서만 lazy 로드).

// ── 지도 좌표계(viewBox 360×480) ─────────────────────────────────────
const W = 360;
const H = 480;
const COL_X = [60, 180, 300]; // 건물 열 중심
const ROAD_Y = [144, 296, 448]; // 각 건물 줄 바로 아래의 가로 도로
const BASE_Y = ROAD_Y.map((y) => y - 16); // 건물이 서 있는 선(인도 위)
const V_ROAD_X = [120, 240]; // 세로 도로(가로 도로들을 잇는다)
const ROAD_W = 22;
const WALK_SPEED = 150; // 초당 이동 거리(지도 단위)
const LAST_SPOT_KEY = "town:lastSpot";

type Roof = "flat" | "gable" | "awning" | "dome";
interface FacilityDef {
  key: FacilityKey;
  icon: string;
  label: string;
  col: number;
  row: number;
  w: number;
  h: number;
  wall: string;
  roof: Roof;
  roofColor: string;
}

const FACILITIES: FacilityDef[] = [
  { key: "alba", icon: "🧢", label: "알바", col: 0, row: 0, w: 78, h: 62, wall: "#f4efe6", roof: "awning", roofColor: "#2f9e6b" },
  { key: "school", icon: "🏫", label: "학교", col: 1, row: 0, w: 92, h: 84, wall: "#c9674f", roof: "gable", roofColor: "#6b3a2e" },
  { key: "jobs", icon: "💼", label: "직장", col: 2, row: 0, w: 70, h: 112, wall: "#5d88b8", roof: "flat", roofColor: "#34506f" },
  { key: "mart", icon: "🛒", label: "마트", col: 0, row: 1, w: 90, h: 66, wall: "#e8f1e2", roof: "awning", roofColor: "#e0843c" },
  { key: "lottery", icon: "🎰", label: "로또", col: 1, row: 1, w: 66, h: 60, wall: "#ffd65a", roof: "dome", roofColor: "#e2542f" },
  { key: "luxury", icon: "💎", label: "명품샵", col: 2, row: 1, w: 84, h: 76, wall: "#26262c", roof: "flat", roofColor: "#c8a24a" },
  { key: "car", icon: "🚗", label: "자동차", col: 0, row: 2, w: 92, h: 58, wall: "#dbe4ee", roof: "flat", roofColor: "#4a5566" },
  { key: "apartment", icon: "🏢", label: "아파트", col: 1, row: 2, w: 74, h: 110, wall: "#ece6dc", roof: "flat", roofColor: "#8b7d6b" },
  { key: "jail", icon: "⛓️", label: "감옥", col: 2, row: 2, w: 86, h: 64, wall: "#8d9199", roof: "flat", roofColor: "#5b5f66" },
];

// ── 도로 그래프(최단 경로) ────────────────────────────────────────────
type Pt = { x: number; y: number };
type Graph = { nodes: Map<string, Pt>; adj: Map<string, string[]> };

const doorId = (k: FacilityKey) => `door:${k}`;
const attachId = (k: FacilityKey) => `at:${k}`;

function buildGraph(): Graph {
  const nodes = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  };
  // 가로 도로마다: 교차로 + 건물 앞 지점을 x순으로 이어준다.
  ROAD_Y.forEach((y, row) => {
    const onRoad: string[] = [];
    V_ROAD_X.forEach((x, i) => {
      const id = `x:${row}:${i}`;
      nodes.set(id, { x, y });
      onRoad.push(id);
    });
    for (const f of FACILITIES.filter((f) => f.row === row)) {
      nodes.set(attachId(f.key), { x: COL_X[f.col], y });
      nodes.set(doorId(f.key), { x: COL_X[f.col], y: BASE_Y[row] - 4 });
      link(attachId(f.key), doorId(f.key));
      onRoad.push(attachId(f.key));
    }
    onRoad.sort((a, b) => nodes.get(a)!.x - nodes.get(b)!.x);
    for (let i = 1; i < onRoad.length; i++) link(onRoad[i - 1], onRoad[i]);
  });
  // 세로 도로: 위아래 교차로를 잇는다.
  V_ROAD_X.forEach((_, i) => {
    for (let row = 1; row < ROAD_Y.length; row++) link(`x:${row - 1}:${i}`, `x:${row}:${i}`);
  });
  return { nodes, adj };
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 다익스트라(노드가 20개 남짓이라 단순 구현으로 충분). */
function shortestPath(g: Graph, from: string, to: string): string[] {
  const d = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const todo = new Set(g.nodes.keys());
  while (todo.size) {
    let u: string | null = null;
    for (const n of todo) if (d.has(n) && (u === null || d.get(n)! < d.get(u)!)) u = n;
    if (u === null || u === to) break;
    todo.delete(u);
    for (const v of g.adj.get(u) ?? []) {
      const alt = d.get(u)! + dist(g.nodes.get(u)!, g.nodes.get(v)!);
      if (alt < (d.get(v) ?? Infinity)) {
        d.set(v, alt);
        prev.set(v, u);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) {
    const p = prev.get(path[0]);
    if (!p) return [from];
    path.unshift(p);
  }
  return path;
}

function isEnabled(key: FacilityKey, graduated: boolean) {
  return key === "school" ? true : key === "jail" ? false : graduated;
}

function lockedMessage(key: FacilityKey) {
  return key === "jail" ? "여긴 규칙을 어기면 끌려오는 곳이에요 😰" : "고3을 졸업하면 들어갈 수 있어요 🔒";
}

function readLastSpot(): string | null {
  try {
    return sessionStorage.getItem(LAST_SPOT_KEY);
  } catch {
    return null;
  }
}

function saveLastSpot(id: string) {
  try {
    sessionStorage.setItem(LAST_SPOT_KEY, id);
  } catch {
    /* 저장 못 해도 다음엔 학교 앞에서 시작할 뿐 */
  }
}

// ── 컴포넌트 ────────────────────────────────────────────────────────
export function TownHub({
  graduated,
  avatarUrl,
  onSelect,
}: {
  graduated: boolean;
  avatarUrl?: string | null;
  onSelect: (key: FacilityKey) => void;
}) {
  const graph = useMemo(buildGraph, []);
  const startId = useMemo(() => {
    const saved = readLastSpot();
    return saved && graph.nodes.has(saved) ? saved : attachId("school");
  }, [graph]);

  const [pos, setPos] = useState<Pt>(() => graph.nodes.get(startId)!);
  const [facingLeft, setFacingLeft] = useState(false);
  const [walking, setWalking] = useState(false);
  const [entering, setEntering] = useState(false);
  const [target, setTarget] = useState<FacilityKey | null>(null);
  const [bubble, setBubble] = useState<string | null>("건물을 눌러보세요!");

  // 애니메이션 상태는 매 프레임 바뀌므로 ref로 들고, 화면에는 pos만 반영한다.
  const walk = useRef<{ nodeId: string; path: string[]; seg: number; t0: number; from: Pt; pending: FacilityKey | null } | null>(null);
  const here = useRef(startId); // 마지막으로 도착한 노드
  const raf = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      timers.current.forEach(clearTimeout);
    },
    []
  );

  const arrive = useCallback(
    (key: FacilityKey) => {
      setWalking(false);
      setTarget(null);
      saveLastSpot(attachId(key));
      if (!isEnabled(key, graduated)) {
        setBubble(lockedMessage(key));
        // 잠긴 건물 앞에서는 도로로 한 발 물러난다(다음 이동의 출발점).
        const back = graph.nodes.get(attachId(key))!;
        timers.current.push(window.setTimeout(() => setPos(back), 350));
        here.current = attachId(key);
        return;
      }
      setBubble(null);
      setEntering(true);
      timers.current.push(window.setTimeout(() => onSelect(key), reducedMotion ? 0 : 320));
    },
    [graduated, graph, onSelect, reducedMotion]
  );

  const startWalk = useCallback(
    (from: string, key: FacilityKey) => {
      const path = shortestPath(graph, from, doorId(key));
      if (reducedMotion || path.length < 2) {
        setPos(graph.nodes.get(doorId(key))!);
        here.current = doorId(key);
        arrive(key);
        return;
      }
      walk.current = { nodeId: from, path, seg: 1, t0: performance.now(), from: graph.nodes.get(from)!, pending: null };
      setWalking(true);
      const step = (now: number) => {
        const w = walk.current;
        if (!w) return;
        const a = w.from;
        const b = graph.nodes.get(w.path[w.seg])!;
        const len = dist(a, b) || 1;
        const t = Math.min(1, ((now - w.t0) / 1000) * (WALK_SPEED / len));
        if (b.x !== a.x) setFacingLeft(b.x < a.x);
        setPos({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        if (t < 1) {
          raf.current = requestAnimationFrame(step);
          return;
        }
        // 다음 지점 도착
        here.current = w.path[w.seg];
        if (w.pending) {
          // 걷는 중에 다른 건물을 눌렀으면 지금 지점에서 새 경로로 갈아탄다.
          const next = w.pending;
          walk.current = null;
          startWalk(here.current, next);
          return;
        }
        if (w.seg === w.path.length - 1) {
          walk.current = null;
          arrive(key);
          return;
        }
        w.seg += 1;
        w.from = b;
        w.t0 = now;
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [arrive, graph, reducedMotion]
  );

  function go(key: FacilityKey) {
    if (entering) return;
    setBubble(null);
    setTarget(key);
    if (walk.current) {
      walk.current.pending = key; // 다음 지점에서 방향을 바꾼다
      return;
    }
    // 이미 그 건물 문 앞/바로 앞 도로에 서 있으면 바로 도착 처리
    if (here.current === doorId(key)) {
      arrive(key);
      return;
    }
    startWalk(here.current, key);
  }

  function onKey(e: KeyboardEvent, key: FacilityKey) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(key);
    }
  }

  return (
    <div className="town-hub">
      <p className="town-hub-intro">
        {graduated
          ? "고등학교 졸업! 가고 싶은 건물을 누르면 걸어가요."
          : "가고 싶은 건물을 누르면 걸어가요. 지금은 학교만 열려 있고, 고3을 졸업하면 다른 시설도 열려요."}
      </p>
      <div className="town-map-wrap">
        <svg className="town-map" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="마을 지도">
          <defs>
            <clipPath id="town-avatar-clip">
              <circle cx="0" cy="0" r="9" />
            </clipPath>
            <pattern id="town-grass" width="12" height="12" patternUnits="userSpaceOnUse">
              <rect width="12" height="12" fill="#4f8a55" />
              <circle cx="3" cy="4" r="0.9" fill="#5d9a62" />
              <circle cx="9" cy="9" r="0.9" fill="#467d4c" />
            </pattern>
          </defs>

          {/* 땅 + 도로 */}
          <rect width={W} height={H} fill="url(#town-grass)" />
          {V_ROAD_X.map((x) => (
            <rect key={x} x={x - ROAD_W / 2} y={ROAD_Y[0]} width={ROAD_W} height={ROAD_Y[2] - ROAD_Y[0]} fill="#50545c" />
          ))}
          {ROAD_Y.map((y) => (
            <g key={y}>
              <rect x={0} y={y - ROAD_W / 2 - 5} width={W} height={5} fill="#b9b4a8" />
              <rect x={0} y={y - ROAD_W / 2} width={W} height={ROAD_W} fill="#50545c" />
              <line x1={0} x2={W} y1={y} y2={y} stroke="#e9d27a" strokeWidth={1.4} strokeDasharray="8 7" />
            </g>
          ))}
          {V_ROAD_X.map((x) =>
            ROAD_Y.slice(1, 3).map((y) => (
              <line key={`${x}-${y}`} x1={x} x2={x} y1={y - 128} y2={y - 24} stroke="#e9d27a" strokeWidth={1.4} strokeDasharray="8 7" />
            ))
          )}
          {/* 횡단보도 */}
          {V_ROAD_X.flatMap((x) =>
            ROAD_Y.map((y) => (
              <g key={`cw-${x}-${y}`}>
                {[-8, -4, 0, 4, 8].map((dx) => (
                  <rect key={dx} x={x + dx - 1.2} y={y - ROAD_W / 2 - 8} width={2.4} height={6} fill="#e8e8e8" opacity={0.8} />
                ))}
              </g>
            ))
          )}
          {/* 나무 */}
          {[
            [14, 40],
            [106, 60],
            [346, 30],
            [8, 196],
            [221, 210],
            [346, 190],
            [346, 350],
            [14, 470],
            [346, 470],
          ].map(([x, y]) => (
            <g key={`t-${x}-${y}`}>
              <ellipse cx={x} cy={y + 8} rx={7} ry={2.5} fill="#000" opacity={0.2} />
              <rect x={x - 1.5} y={y} width={3} height={8} fill="#6b4b33" />
              <circle cx={x} cy={y - 3} r={8} fill="#3f7a45" />
              <circle cx={x - 3} cy={y - 6} r={4} fill="#4d9255" />
            </g>
          ))}

          {/* 건물 */}
          {FACILITIES.map((f) => (
            <Building
              key={f.key}
              def={f}
              enabled={isEnabled(f.key, graduated)}
              targeted={target === f.key}
              onActivate={() => go(f.key)}
              onKey={(e) => onKey(e, f.key)}
            />
          ))}

          {/* 목적지 표시 */}
          {target && (
            <circle
              className="town-target"
              cx={graph.nodes.get(attachId(target))!.x}
              cy={graph.nodes.get(attachId(target))!.y}
              r={8}
            />
          )}

          {/* 캐릭터 */}
          <g transform={`translate(${pos.x} ${pos.y})`} pointerEvents="none">
            <g className={`town-char${walking ? " walking" : ""}${entering ? " entering" : ""}`}>
              <ellipse cx={0} cy={0} rx={8} ry={2.8} fill="#000" opacity={0.3} />
              <g transform={facingLeft ? "scale(-1.3 1.3)" : "scale(1.3)"}>
                <g className="town-char-body">
                  <rect x={-2.6} y={-6} width={2.2} height={6} rx={1} fill="#2d3445" className="leg leg-a" />
                  <rect x={0.4} y={-6} width={2.2} height={6} rx={1} fill="#2d3445" className="leg leg-b" />
                  <rect x={-6} y={-15} width={12} height={10} rx={4} fill="#5b8cff" />
                  <g transform="translate(0 -24)">
                    <circle r={10} fill="#fff" />
                    {avatarUrl ? (
                      <image href={avatarUrl} x={-9} y={-9} width={18} height={18} clipPath="url(#town-avatar-clip)" />
                    ) : (
                      <text textAnchor="middle" dominantBaseline="central" fontSize={13}>
                        🙂
                      </text>
                    )}
                  </g>
                </g>
              </g>
              {bubble && (
                <g transform="translate(0 -46)">
                  <SpeechBubble text={bubble} x={pos.x} />
                </g>
              )}
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}

function Building({
  def: f,
  enabled,
  targeted,
  onActivate,
  onKey,
}: {
  def: FacilityDef;
  enabled: boolean;
  targeted: boolean;
  onActivate: () => void;
  onKey: (e: KeyboardEvent) => void;
}) {
  const cx = COL_X[f.col];
  const base = BASE_Y[f.row];
  const x = cx - f.w / 2;
  const y = base - f.h;
  const dark = f.wall === "#26262c";
  const winColor = dark ? "#e7c870" : "#9ccbee";
  // 창문 격자(건물 크기에 맞춰 자동)
  const cols = Math.max(2, Math.floor((f.w - 12) / 16));
  const rows = Math.max(1, Math.floor((f.h - 34) / 18));
  const windows: Pt[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const wx = x + 8 + c * ((f.w - 16) / cols) + ((f.w - 16) / cols - 9) / 2;
      const wy = y + 18 + r * 18;
      if (Math.abs(wx + 4.5 - cx) < 9 && wy > base - 30) continue; // 문 자리 비우기
      windows.push({ x: wx, y: wy });
    }

  return (
    <g
      className={`town-building${enabled ? "" : " locked"}${targeted ? " targeted" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={enabled ? f.label : `${f.label} (잠김)`}
      onClick={onActivate}
      onKeyDown={onKey}
    >
      {/* 넓은 터치 영역 */}
      <rect x={cx - 52} y={base - Math.max(f.h, 70) - 14} width={104} height={Math.max(f.h, 70) + 30} fill="transparent" />
      <ellipse cx={cx} cy={base + 1} rx={f.w / 2 + 4} ry={4} fill="#000" opacity={0.22} />
      {/* 옆면(입체감) */}
      <polygon points={`${x + f.w},${y + 6} ${x + f.w + 7},${y + 1} ${x + f.w + 7},${base - 5} ${x + f.w},${base}`} fill="#000" opacity={0.25} />
      <rect x={x} y={y} width={f.w} height={f.h} fill={f.wall} rx={2} />
      {f.roof === "flat" && <rect x={x - 2} y={y - 5} width={f.w + 4} height={7} fill={f.roofColor} rx={1.5} />}
      {f.roof === "gable" && <polygon points={`${x - 6},${y + 2} ${cx},${y - 22} ${x + f.w + 6},${y + 2}`} fill={f.roofColor} />}
      {f.roof === "dome" && <path d={`M${x - 2},${y + 2} Q${cx},${y - 30} ${x + f.w + 2},${y + 2} Z`} fill={f.roofColor} />}
      {f.roof === "awning" &&
        Array.from({ length: 8 }, (_, i) => (
          <rect
            key={i}
            x={x - 3 + (i * (f.w + 6)) / 8}
            y={y - 2}
            width={(f.w + 6) / 8}
            height={10}
            fill={i % 2 ? "#fff" : f.roofColor}
          />
        ))}
      {windows.map((p, i) => (
        <g key={i}>
          <rect x={p.x} y={p.y} width={9} height={10} rx={1} fill={f.key === "jail" ? "#3a3d44" : winColor} opacity={0.9} />
          {f.key === "jail" &&
            [2, 4.5, 7].map((dx) => <rect key={dx} x={p.x + dx - 0.5} y={p.y} width={1} height={10} fill="#c9ccd2" />)}
        </g>
      ))}
      {/* 문 */}
      <rect x={cx - 7} y={base - 17} width={14} height={17} rx={1.5} fill={dark ? "#c8a24a" : "#5a4636"} />
      {/* 간판 */}
      <g transform={`translate(${cx} ${f.roof === "gable" ? y + 10 : y + 8})`}>
        <rect x={-26} y={-8} width={52} height={15} rx={7} fill="#1b1e25" opacity={0.85} />
        <text textAnchor="middle" dominantBaseline="central" fontSize={9} fill="#fff" y={0}>
          {f.icon} {f.label}
        </text>
      </g>
      {!enabled && (
        <text x={x + f.w - 4} y={y + 4} fontSize={12} textAnchor="middle">
          🔒
        </text>
      )}
    </g>
  );
}

/** 캐릭터 머리 위 말풍선. 지도 가장자리에서는 안쪽으로 밀어서 잘리지 않게 한다. */
function SpeechBubble({ text, x }: { text: string; x: number }) {
  const width = Math.min(200, 16 + text.length * 8.2);
  const half = width / 2;
  const shift = Math.max(half + 4 - x, 0) - Math.max(x + half + 4 - W, 0);
  return (
    <g className="town-bubble">
      <rect x={-half + shift} y={-22} width={width} height={20} rx={10} fill="#fff" />
      <polygon points="-5,-3 5,-3 0,4" fill="#fff" />
      <text x={shift} y={-12} textAnchor="middle" dominantBaseline="central" fontSize={9.5} fill="#1b1e25">
        {text}
      </text>
    </g>
  );
}
