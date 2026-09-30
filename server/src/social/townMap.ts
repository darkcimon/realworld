// 마을 지도에서 시설 사이 거리를 "칸"으로 잰다(연료는 이동한 칸 수만큼 줄어든다).
// 시설 위치(열 col, 줄 row)는 client/src/components/TownHub.tsx의 FACILITIES와 같아야 한다.
//
// 지도: 3열 × 4줄 블록. 줄마다 아래에 가로 도로가 있고, 열 0·1 사이와 1·2 사이에 세로 도로가 있다.
// 1칸 = 블록 하나(가로로 열 하나, 세로로 줄 하나). 같은 줄이면 가로 도로로 |열 차이|칸,
// 다른 줄이면 가까운 세로 도로까지 가서 |줄 차이|칸 오르내린 뒤 다시 가로로 간다.
export const FACILITY_POS: Record<string, { col: number; row: number }> = {
  alba: { col: 0, row: 0 },
  school: { col: 1, row: 0 },
  jobs: { col: 2, row: 0 },
  mart: { col: 0, row: 1 },
  lottery: { col: 1, row: 1 },
  luxury: { col: 2, row: 1 },
  car: { col: 0, row: 2 },
  apartment: { col: 1, row: 2 },
  jail: { col: 2, row: 2 },
  home: { col: 1, row: 3 },
};

const VERTICAL_ROADS = [0.5, 1.5]; // 세로 도로 위치(열 사이)

export function isFacility(key: string): boolean {
  return key in FACILITY_POS;
}

/** 두 시설 사이 도로 거리(칸). 같은 곳이면 0. */
export function cellsBetween(from: string, to: string): number {
  const a = FACILITY_POS[from];
  const b = FACILITY_POS[to];
  if (!a || !b || from === to) return 0;
  if (a.row === b.row) return Math.abs(a.col - b.col);
  const horizontal = Math.min(...VERTICAL_ROADS.map((v) => Math.abs(a.col - v) + Math.abs(v - b.col)));
  return horizontal + Math.abs(a.row - b.row);
}
