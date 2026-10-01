// 3D 캐릭터 꾸미기(1단계): 성별·옷(몸 모델)·헤어(머리 모델)·키·피부색·헤어 색·얼굴(사진/캐릭터).
// 모델은 Kenney "Mini Characters"(CC0, client/public/models/characters). 같은 뼈대라 몸과 머리를 섞어 쓴다.
// 서버는 설정값이 허용 목록 안에 있는지만 검사하고 JSON으로 저장한다 — 그리는 일은 전부 클라이언트가 한다.
import { db } from "../db.js";

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
  db.prepare(
    `INSERT INTO user_characters (user_id, config, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(config));
  return config;
}
