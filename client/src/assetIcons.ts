// 자산(자동차/집/명품) 이모지. 사이드바·프로필처럼 가볍게 보여줄 곳에서 쓴다
// (3D 뷰어 AssetViewer.tsx는 three.js가 무거워 lazy로만 불러오므로 거기서 가져오지 않는다).
const BY_NAME: Record<string, string> = {
  경차: "🚙",
  "준중형 세단": "🚗",
  스포츠카: "🏎️",
  슈퍼카: "🏎️",
  원룸: "🏠",
  "84㎡ 아파트": "🏢",
  펜트하우스: "🏙️",
  "명품 선글라스": "🕶️",
  "명품 운동화": "👟",
  "명품 스탠드 조명": "💡",
  "명품 시계": "⌚",
  "명품 가죽 소파": "🛋️",
};

const BY_CATEGORY: Record<string, string> = { car: "🚗", apartment: "🏠", luxury: "💎" };

export function assetIcon(category: string, name: string): string {
  return BY_NAME[name] ?? BY_CATEGORY[category] ?? "✨";
}
