// 오래 버려진 비회원(게스트) 계정 정리.
// 비회원은 브라우저에 저장된 토큰이 유일한 열쇠라, 토큰을 잃으면(브라우저 데이터 삭제·다른 기기·만료)
// 그 계정에 다시 들어올 방법이 없다. 토큰은 접속할 때마다 30일로 연장되고(middleware/auth.ts) 그때
// last_seen_at도 갱신되므로, INACTIVE_DAYS 동안 접속이 없으면 토큰이 이미 만료돼 아무도 못 쓰는 계정이다.
//
// 다른 유저와 주고받은 기록(하트·선물·DM·매칭·차단·프로필 열람)이 있는 게스트는 지우지 않는다 —
// 상대방 화면에서 대화나 받은 선물이 사라지면 안 되기 때문이다.
import { db } from "../db.js";

const INACTIVE_DAYS = 60;
const BATCH_LIMIT = 200; // 한 번에 정리할 최대 계정 수
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;

interface FkRow {
  table: string; // 참조 대상(부모) 테이블
  from: string; // 이 테이블의 컬럼
  to: string | null; // 부모 컬럼(null이면 부모의 PK)
}

let childMapCache: Map<string, { child: string; from: string; to: string }[]> | null = null;

/** 부모 테이블 → 그 테이블을 참조하는 (자식 테이블, 자식 컬럼, 부모 컬럼) 목록. 스키마의 FK 선언에서 만든다. */
function childMap() {
  if (childMapCache) return childMapCache;
  const map = new Map<string, { child: string; from: string; to: string }[]>();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as unknown as FkRow[]) {
      const list = map.get(fk.table) ?? [];
      list.push({ child: name, from: fk.from, to: fk.to ?? "id" });
      map.set(fk.table, list);
    }
  }
  childMapCache = map;
  return map;
}

/** users를 둘 이상 참조하는 테이블(유저 간 상호작용 기록) — 여기에 등장하는 게스트는 정리하지 않는다. */
function interactionColumns(): { table: string; column: string }[] {
  const byTable = new Map<string, string[]>();
  for (const ref of childMap().get("users") ?? []) {
    byTable.set(ref.child, [...(byTable.get(ref.child) ?? []), ref.from]);
  }
  return [...byTable]
    .filter(([, cols]) => cols.length >= 2)
    .flatMap(([table, cols]) => cols.map((column) => ({ table, column })));
}

/** table에서 column IN values인 행을 지우기 전에, 그 행을 참조하는 자식 행부터 재귀적으로 지운다. */
function purge(table: string, column: string, values: (number | string)[], depth = 0): number {
  if (!values.length) return 0;
  if (depth > 8) throw new Error(`guestCleanup: FK 깊이 초과 (${table})`);
  const placeholders = values.map(() => "?").join(",");
  let deleted = 0;
  for (const ref of childMap().get(table) ?? []) {
    const parentKeys = (
      db.prepare(`SELECT DISTINCT "${ref.to}" AS k FROM "${table}" WHERE "${column}" IN (${placeholders})`).all(
        ...values
      ) as { k: number | string | null }[]
    )
      .map((r) => r.k)
      .filter((k): k is number | string => k !== null);
    deleted += purge(ref.child, ref.from, parentKeys, depth + 1);
  }
  deleted += Number(db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${placeholders})`).run(...values).changes);
  return deleted;
}

export function findAbandonedGuests(limit = BATCH_LIMIT): number[] {
  const exclusions = interactionColumns()
    .map(({ table, column }) => `AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x."${column}" = u.id)`)
    .join("\n      ");
  return (
    db
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.is_guest = 1
           AND COALESCE(u.last_seen_at, u.created_at) < datetime('now', ?)
           ${exclusions}
         ORDER BY u.id LIMIT ?`
      )
      .all(`-${INACTIVE_DAYS} days`, limit) as { id: number }[]
  ).map((r) => r.id);
}

/** 버려진 게스트를 한 명씩 트랜잭션으로 지운다(한 명이 실패해도 나머지는 계속). */
export function cleanupAbandonedGuests(): { users: number; rows: number; failed: number } {
  let users = 0;
  let rows = 0;
  let failed = 0;
  for (const id of findAbandonedGuests()) {
    try {
      db.exec("BEGIN");
      rows += purge("users", "id", [id]);
      db.exec("COMMIT");
      users += 1;
    } catch (e) {
      db.exec("ROLLBACK");
      failed += 1;
      console.error(`[guestCleanup] user ${id} 정리 실패:`, e);
    }
  }
  return { users, rows, failed };
}

export function startGuestCleanupScheduler(): void {
  const run = () => {
    try {
      const r = cleanupAbandonedGuests();
      if (r.users || r.failed) {
        console.log(`[guestCleanup] 비회원 ${r.users}명 정리(행 ${r.rows}개), 실패 ${r.failed}명`);
      }
    } catch (e) {
      console.error("[guestCleanup] 실행 실패:", e);
    }
  };
  // 서버 시작 직후 부하를 피해 1분 뒤 첫 실행, 이후 하루마다.
  setTimeout(run, 60_000);
  setInterval(run, RUN_EVERY_MS);
}
