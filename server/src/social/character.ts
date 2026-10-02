// 3D 캐릭터 꾸미기: 성별·옷(몸 모델)·헤어(머리 모델)·키·피부색·헤어 색·얼굴(사진/캐릭터).
// 모델은 Kenney "Mini Characters"(CC0, client/public/models/characters). 같은 뼈대라 몸과 머리를 섞어 쓴다.
// 서버는 설정값이 허용 목록 안에 있는지만 검사하고 JSON으로 저장한다 — 그리는 일은 전부 클라이언트가 한다.
//
// 성별·얼굴·키·피부색·헤어 색은 누구나 고를 수 있고, 옷·헤어스타일은 성별마다 기본 1개만 무료다.
// 나머지는 마을의 스타일샵(내 집 옆)에서 사서 해금한다. "캐릭터"(세트)는 한 모델의 옷+헤어를 한 번에 해금한다.
import { db } from "../db.js";
import { applyLedgerEntry } from "../wallet/ledger.js";

// 옷 스타일: female-a 모델은 목발이 붙어 있어 몸으로는 쓰지 않는다(머리는 헤어 후보로 쓴다).
export const CHARACTER_BODIES: Record<"female" | "male", string[]> = {
  female: ["b", "c", "d", "e", "f"],
  male: ["a", "b", "c", "d", "e", "f"],
};
export const CHARACTER_HEADS = [
  "female-a", "female-b", "female-c", "female-d", "female-e", "female-f",
  "male-a", "male-b", "male-c", "male-d", "male-e", "male-f",
];
export const CHARACTER_LIMITS = {
  heightMin: 145,
  heightMax: 190,
  skinCount: 6, // 0 = 모델 원래 색
  hairCount: 7, // 0 = 모델 원래 색
  faceSizeMin: 0.7,
  faceSizeMax: 1.25,
};

type Gender = "female" | "male";

// 무료 기본 옷·헤어(client/src/character/options.ts의 defaultCharacter와 같아야 한다)
const FREE_BODY: Record<Gender, string> = { female: "b", male: "a" };
const FREE_HEADS = ["female-b", "male-f"];

export const STYLE_PRICES = { set: 12_000_000, body: 10_000_000, head: 5_000_000 };

// 세트로 파는 모델: female-a(목발 모델 — 옷으로 못 씀)와 female-b(무료 기본 옷+헤어와 같음)는 뺀다.
const SET_MODELS = CHARACTER_HEADS.filter((m) => m !== "female-a" && m !== "female-b");

export type StyleKind = "set" | "body" | "head";
export interface StyleItem {
  key: string;
  kind: StyleKind;
  gender: Gender | null; // 옷·세트는 성별 모델이 정해져 있다(헤어는 성별 무관)
  model: string; // body: 몸 모델 글자(a~f), head/set: 모델 이름(female-c 등)
  price: number;
  owned: boolean;
}

const bodyKey = (gender: Gender, body: string) => `body:${gender}:${body}`;
const headKey = (head: string) => `head:${head}`;
const setParts = (model: string) => {
  const [gender, letter] = model.split("-") as [Gender, string];
  return [bodyKey(gender, letter), headKey(model)];
};

function unlockedKeys(userId: number): Set<string> {
  const rows = db.prepare("SELECT item_key FROM character_unlocks WHERE user_id = ?").all(userId) as {
    item_key: string;
  }[];
  const keys = new Set(rows.map((r) => r.item_key));
  (["female", "male"] as Gender[]).forEach((g) => keys.add(bodyKey(g, FREE_BODY[g])));
  FREE_HEADS.forEach((h) => keys.add(headKey(h)));
  return keys;
}

/** 지금 쓸 수 있는 옷·헤어 목록(무료 기본 포함). 꾸미기 창에서 잠금 표시에 쓴다. */
export function listUnlocks(userId: number): { bodies: Record<Gender, string[]>; heads: string[] } {
  const keys = unlockedKeys(userId);
  return {
    bodies: {
      female: CHARACTER_BODIES.female.filter((b) => keys.has(bodyKey("female", b))),
      male: CHARACTER_BODIES.male.filter((b) => keys.has(bodyKey("male", b))),
    },
    heads: CHARACTER_HEADS.filter((h) => keys.has(headKey(h))),
  };
}

/** 스타일샵 진열 목록: 세트 → 옷 → 헤어 순. 무료 기본 품목은 팔지 않는다. */
export function listStyleShop(userId: number): StyleItem[] {
  const keys = unlockedKeys(userId);
  const sets: StyleItem[] = SET_MODELS.map((m) => ({
    key: `set:${m}`,
    kind: "set",
    gender: m.split("-")[0] as Gender,
    model: m,
    price: STYLE_PRICES.set,
    owned: setParts(m).every((k) => keys.has(k)),
  }));
  const bodies: StyleItem[] = (["female", "male"] as Gender[]).flatMap((g) =>
    CHARACTER_BODIES[g]
      .filter((b) => b !== FREE_BODY[g])
      .map((b) => ({
        key: bodyKey(g, b),
        kind: "body" as const,
        gender: g,
        model: b,
        price: STYLE_PRICES.body,
        owned: keys.has(bodyKey(g, b)),
      }))
  );
  const heads: StyleItem[] = CHARACTER_HEADS.filter((h) => !FREE_HEADS.includes(h)).map((h) => ({
    key: headKey(h),
    kind: "head",
    gender: null,
    model: h,
    price: STYLE_PRICES.head,
    owned: keys.has(headKey(h)),
  }));
  return [...sets, ...bodies, ...heads];
}

export function buyStyleItem(userId: number, key: string): { balance: number } {
  const item = listStyleShop(userId).find((i) => i.key === key);
  if (!item) throw { status: 404, message: "없는 상품입니다." };
  if (item.owned) throw { status: 409, message: "이미 해금한 상품입니다." };
  const { balance } = applyLedgerEntry(userId, "캐릭터꾸미기", -item.price);
  const insert = db.prepare("INSERT OR IGNORE INTO character_unlocks (user_id, item_key) VALUES (?, ?)");
  for (const k of item.kind === "set" ? [key, ...setParts(item.model)] : [key]) insert.run(userId, k);
  return { balance };
}

export interface CharacterConfig {
  gender: "female" | "male";
  body: string;
  head: string;
  height: number;
  skin: number;
  hair: number;
  face: "photo" | "model"; // photo = 프로필 사진을 얼굴 스티커로 붙인다
  faceSize: number;
}

function invalid(field: string): never {
  throw { status: 400, message: `캐릭터 설정이 올바르지 않습니다 (${field}).` };
}

export function validateCharacter(raw: any): CharacterConfig {
  if (!raw || typeof raw !== "object") invalid("형식");
  const gender = raw.gender;
  if (gender !== "female" && gender !== "male") invalid("성별");
  if (!CHARACTER_BODIES[gender as "female" | "male"].includes(raw.body)) invalid("옷 스타일");
  if (!CHARACTER_HEADS.includes(raw.head)) invalid("헤어스타일");
  const height = Math.round(Number(raw.height));
  if (!(height >= CHARACTER_LIMITS.heightMin && height <= CHARACTER_LIMITS.heightMax)) invalid("키");
  const skin = Number(raw.skin);
  if (!Number.isInteger(skin) || skin < 0 || skin >= CHARACTER_LIMITS.skinCount) invalid("피부색");
  const hair = Number(raw.hair);
  if (!Number.isInteger(hair) || hair < 0 || hair >= CHARACTER_LIMITS.hairCount) invalid("헤어 색");
  if (raw.face !== "photo" && raw.face !== "model") invalid("얼굴");
  const faceSize = Number(raw.faceSize);
  if (!(faceSize >= CHARACTER_LIMITS.faceSizeMin && faceSize <= CHARACTER_LIMITS.faceSizeMax)) invalid("사진 크기");
  return {
    gender,
    body: raw.body,
    head: raw.head,
    height,
    skin,
    hair,
    face: raw.face,
    faceSize: Math.round(faceSize * 100) / 100,
  };
}

export function getCharacter(userId: number): CharacterConfig | null {
  const row = db.prepare("SELECT config FROM user_characters WHERE user_id = ?").get(userId) as
    | { config: string }
    | undefined;
  if (!row) return null;
  try {
    return validateCharacter(JSON.parse(row.config));
  } catch {
    return null; // 옵션 목록이 바뀌어 옛 설정이 더는 유효하지 않으면 새로 꾸미게 한다
  }
}

export function saveCharacter(userId: number, raw: unknown): CharacterConfig {
  const config = validateCharacter(raw);
  const keys = unlockedKeys(userId);
  if (!keys.has(bodyKey(config.gender, config.body))) {
    throw { status: 403, message: "아직 해금하지 않은 옷이에요. 스타일샵에서 먼저 사주세요." };
  }
  if (!keys.has(headKey(config.head))) {
    throw { status: 403, message: "아직 해금하지 않은 헤어스타일이에요. 스타일샵에서 먼저 사주세요." };
  }
  db.prepare(
    `INSERT INTO user_characters (user_id, config, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(config));
  return config;
}
