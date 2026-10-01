// 캐릭터 꾸미기 선택지. 서버(server/src/social/character.ts)의 허용 목록과 같아야 한다.
export interface CharacterConfig {
  gender: "female" | "male";
  body: string;
  head: string;
  height: number;
  skin: number; // 0 = 모델 원래 색
  hair: number; // 0 = 모델 원래 색
  face: "photo" | "model"; // photo = 프로필 사진을 얼굴 스티커로
  faceSize: number;
}

// 옷 스타일(몸 모델). female-a는 목발이 붙은 모델이라 옷으로는 쓰지 않는다.
export const BODIES: Record<CharacterConfig["gender"], [string, string][]> = {
  female: [["b", "캐주얼"], ["c", "목걸이"], ["d", "정장"], ["e", "가운"], ["f", "멜빵"]],
  male: [["a", "캐주얼"], ["b", "반팔"], ["c", "경찰"], ["d", "정장"], ["e", "작업복"], ["f", "멜빵"]],
};

export const HEADS: [string, string][] = [
  ["female-a", "묶은 머리"], ["female-b", "포니테일"], ["female-c", "올림머리"], ["female-d", "단발 묶음"],
  ["female-e", "긴 생머리"], ["female-f", "웨이브"], ["male-a", "곱슬+안경"], ["male-b", "민머리 수염"],
  ["male-c", "경찰 모자"], ["male-d", "뾰족 머리"], ["male-e", "앞머리+안경"], ["male-f", "짧은 머리"],
];

// null = 모델 원래 색
export const SKIN_COLORS: (string | null)[] = [null, "#ffe3cc", "#f3c39b", "#d99a6c", "#a8693f", "#6e4228"];
export const HAIR_COLORS: (string | null)[] = [null, "#1d1716", "#5a3a28", "#c99a52", "#d9d4cc", "#c74b3a", "#7c8cff"];

export const HEIGHT_RANGE = { min: 145, max: 190 };
export const FACE_SIZE_RANGE = { min: 0.7, max: 1.25 };

export function defaultCharacter(gender: CharacterConfig["gender"] = "female"): CharacterConfig {
  return gender === "female"
    ? { gender, body: "c", head: "female-b", height: 162, skin: 0, hair: 0, face: "photo", faceSize: 1 }
    : { gender, body: "a", head: "male-f", height: 174, skin: 0, hair: 0, face: "photo", faceSize: 1 };
}

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

export function randomCharacter(): CharacterConfig {
  const gender = Math.random() < 0.5 ? "female" : "male";
  return {
    gender,
    body: pick(BODIES[gender])[0],
    head: pick(HEADS.filter(([k]) => k.startsWith(gender)))[0],
    height: HEIGHT_RANGE.min + Math.floor(Math.random() * (HEIGHT_RANGE.max - HEIGHT_RANGE.min + 1)),
    skin: Math.floor(Math.random() * SKIN_COLORS.length),
    hair: Math.floor(Math.random() * HAIR_COLORS.length),
    face: "photo",
    faceSize: 1,
  };
}
