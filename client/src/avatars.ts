// 최초 게임 시작(비회원/회원가입) 시 고를 수 있는 기본 아바타 프리셋.
// 사진 업로드(PhotoCropper)로 만든 데이터 URL과 저장 방식을 동일하게 맞추기 위해,
// 각 프리셋도 <img src="data:image/svg+xml..."> 로 바로 그릴 수 있는 데이터 URL로 만들어 둔다
// (그래야 서버/클라이언트 어디서도 "프리셋인지 사진인지" 따로 구분할 필요 없이 avatarUrl 문자열 하나로 통일된다).
export interface AvatarPreset {
  id: string;
  label: string;
  dataUrl: string;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function wrap(bg: string, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="clip"><circle cx="50" cy="50" r="50"/></clipPath></defs><circle cx="50" cy="50" r="50" fill="${bg}"/><g clip-path="url(#clip)">${inner}</g></svg>`;
}

const PRESET_DEFS: { id: string; label: string; bg: string; inner: string }[] = [
  {
    id: "male",
    label: "남자",
    bg: "#4a7dff",
    inner: `
      <ellipse cx="50" cy="29" rx="19" ry="14" fill="#3b2e25"/>
      <circle cx="50" cy="41" r="17" fill="#ffdcb8"/>
      <rect x="42" y="52" width="16" height="14" fill="#ffdcb8"/>
      <ellipse cx="50" cy="100" rx="34" ry="27" fill="#33488a"/>
    `,
  },
  {
    id: "female",
    label: "여자",
    bg: "#ffd6e6",
    inner: `
      <ellipse cx="50" cy="32" rx="20" ry="16" fill="#4a3628"/>
      <ellipse cx="30" cy="55" rx="8" ry="20" fill="#4a3628"/>
      <ellipse cx="70" cy="55" rx="8" ry="20" fill="#4a3628"/>
      <circle cx="50" cy="41" r="17" fill="#ffdcb8"/>
      <rect x="42" y="52" width="16" height="14" fill="#ffdcb8"/>
      <ellipse cx="50" cy="100" rx="34" ry="27" fill="#c9457e"/>
    `,
  },
  {
    id: "rabbit",
    label: "토끼",
    bg: "#f2e6ff",
    inner: `
      <ellipse cx="35" cy="18" rx="8" ry="24" fill="#fff" transform="rotate(-12 35 18)"/>
      <ellipse cx="35" cy="20" rx="4" ry="18" fill="#ffc2d6" transform="rotate(-12 35 20)"/>
      <ellipse cx="65" cy="18" rx="8" ry="24" fill="#fff" transform="rotate(12 65 18)"/>
      <ellipse cx="65" cy="20" rx="4" ry="18" fill="#ffc2d6" transform="rotate(12 65 20)"/>
      <circle cx="50" cy="55" r="28" fill="#fff"/>
      <circle cx="40" cy="50" r="4" fill="#333"/>
      <circle cx="60" cy="50" r="4" fill="#333"/>
      <path d="M50 58l-5 6h10z" fill="#ff8fae"/>
    `,
  },
  {
    id: "dog",
    label: "강아지",
    bg: "#ffe8c2",
    inner: `
      <ellipse cx="22" cy="45" rx="14" ry="22" fill="#b5793f" transform="rotate(-15 22 45)"/>
      <ellipse cx="78" cy="45" rx="14" ry="22" fill="#b5793f" transform="rotate(15 78 45)"/>
      <circle cx="50" cy="55" r="28" fill="#f4c893"/>
      <circle cx="40" cy="52" r="4" fill="#333"/>
      <circle cx="60" cy="52" r="4" fill="#333"/>
      <ellipse cx="50" cy="62" rx="6" ry="4" fill="#333"/>
      <path d="M50 66q0 8 -8 8" stroke="#333" stroke-width="2" fill="none"/>
    `,
  },
  {
    id: "cat",
    label: "고양이",
    bg: "#ffdca8",
    inner: `
      <path d="M22 30l14 22-24 4z" fill="#ff9d3f"/>
      <path d="M78 30l-14 22 24 4z" fill="#ff9d3f"/>
      <circle cx="50" cy="56" r="27" fill="#ffb84d"/>
      <ellipse cx="39" cy="53" rx="4" ry="5" fill="#333"/>
      <ellipse cx="61" cy="53" rx="4" ry="5" fill="#333"/>
      <path d="M50 60l-4 4h8z" fill="#c9457e"/>
      <path d="M20 58h14M20 64h14M66 58h14M66 64h14" stroke="#7a5326" stroke-width="1.5"/>
    `,
  },
  {
    id: "capybara",
    label: "카피바라",
    bg: "#ead9b8",
    inner: `
      <circle cx="34" cy="30" r="6" fill="#a9825a"/>
      <circle cx="66" cy="30" r="6" fill="#a9825a"/>
      <rect x="18" y="34" width="64" height="46" rx="23" fill="#c9a26a"/>
      <ellipse cx="38" cy="55" rx="3" ry="2" fill="#3a2f22"/>
      <ellipse cx="62" cy="55" rx="3" ry="2" fill="#3a2f22"/>
      <rect x="42" y="66" width="16" height="8" rx="4" fill="#3a2f22"/>
    `,
  },
  {
    id: "earthworm",
    label: "지렁이",
    bg: "#dff2c2",
    inner: `
      <path d="M25,65 C35,45 45,85 55,65 C65,45 75,85 85,65" stroke="#e8879e" stroke-width="16" stroke-linecap="round" fill="none"/>
      <circle cx="26" cy="63" r="2.2" fill="#333"/>
      <circle cx="24" cy="69" r="2.2" fill="#333"/>
    `,
  },
  {
    id: "mole",
    label: "두더지",
    bg: "#cfc6bb",
    inner: `
      <ellipse cx="50" cy="58" rx="30" ry="26" fill="#6b5c52"/>
      <ellipse cx="50" cy="78" rx="12" ry="9" fill="#8a7a6e"/>
      <circle cx="38" cy="50" r="1.8" fill="#1a1a1a"/>
      <circle cx="62" cy="50" r="1.8" fill="#1a1a1a"/>
      <ellipse cx="50" cy="80" rx="5" ry="4" fill="#ff9db0"/>
    `,
  },
];

export const AVATAR_PRESETS: AvatarPreset[] = PRESET_DEFS.map((p) => ({
  id: p.id,
  label: p.label,
  dataUrl: svgToDataUrl(wrap(p.bg, p.inner)),
}));
