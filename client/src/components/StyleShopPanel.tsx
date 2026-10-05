import { Suspense, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Profile } from "../types";
import { CharacterStage } from "../character/characterLazy";
import { BODIES, HEADS, SET_LABELS, defaultCharacter, type CharacterConfig } from "../character/options";
import { confirmDialog } from "./ConfirmDialog";
import { feedback } from "../feedback";

// 스타일샵(내 집 옆): 캐릭터 세트(옷+헤어)·옷·헤어스타일을 사서 해금한다. 해금한 건 여기서 바로 입거나
// 사이드 메뉴의 캐릭터 꾸미기에서 고를 수 있다. 사기 전에 "입어보기"로 내 캐릭터에 걸쳐 볼 수 있다.
interface StyleItem {
  key: string;
  kind: "set" | "body" | "head";
  gender: CharacterConfig["gender"] | null;
  model: string;
  price: number;
  owned: boolean;
}

const SECTIONS: { kind: StyleItem["kind"]; title: string }[] = [
  { kind: "set", title: "🧍 캐릭터 (옷 + 헤어 세트)" },
  { kind: "body", title: "👕 옷" },
  { kind: "head", title: "💇 헤어스타일" },
];

const GENDER_LABEL = { female: "여", male: "남" } as const;

function itemLabel(item: StyleItem): string {
  if (item.kind === "set") return SET_LABELS[item.model] ?? item.model;
  if (item.kind === "body") {
    const name = BODIES[item.gender!].find(([k]) => k === item.model)?.[1] ?? item.model;
    return `${name} (${GENDER_LABEL[item.gender!]})`;
  }
  return HEADS.find(([k]) => k === item.model)?.[1] ?? item.model;
}

/** 지금 캐릭터에 이 상품을 걸친 설정. 옷·세트는 성별 모델이 정해져 있어 성별도 따라 바뀐다. */
function wearing(base: CharacterConfig, item: StyleItem): CharacterConfig {
  if (item.kind === "set") return { ...base, gender: item.gender!, body: item.model.split("-")[1], head: item.model };
  if (item.kind === "body") return { ...base, gender: item.gender!, body: item.model };
  return { ...base, head: item.model };
}

export function StyleShopPanel({
  onBalanceChange,
  onProfileChange,
}: {
  onBalanceChange: () => void;
  onProfileChange: () => void;
}) {
  const [items, setItems] = useState<StyleItem[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [preview, setPreview] = useState<StyleItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadItems() {
    setItems(await api.get<StyleItem[]>("/profile/style-shop"));
  }

  useEffect(() => {
    loadItems().catch((e) => setError(e instanceof ApiError ? e.message : "상품을 불러오지 못했습니다."));
    api.get<Profile>("/profile").then(setProfile, () => {});
  }, []);

  const base = profile?.character ?? defaultCharacter();
  const shown = preview ? wearing(base, preview) : base;

  async function buy(item: StyleItem) {
    if (!(await confirmDialog(`${itemLabel(item)}을(를) ${item.price.toLocaleString()}원에 살까요?`, { title: "구매 확인", confirmText: "사기" }))) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.post("/profile/style-shop/buy", { key: item.key });
      feedback("purchase");
      setMessage(`${itemLabel(item)} 해금! "입기"를 누르면 바로 입을 수 있어요.`);
      await loadItems();
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "구매에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function wear(item: StyleItem) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api.put<{ character: CharacterConfig }>("/profile/character", { character: wearing(base, item) });
      setProfile((p) => (p ? { ...p, character: r.character } : p));
      setPreview(null);
      setMessage(`${itemLabel(item)}(으)로 갈아입었어요.`);
      onProfileChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "입지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>스타일샵</h3>
      <p className="muted">성별·얼굴·키·피부색·헤어 색은 캐릭터 꾸미기에서 무료로 바꿀 수 있어요. 새 옷·헤어스타일은 여기서 해금해요.</p>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      <div className="style-preview">
        <Suspense fallback={<div className="character-stage" />}>
          <CharacterStage config={shown} photoUrl={profile?.avatarUrl ?? null} />
        </Suspense>
        <div className="style-preview-caption">
          <span className="muted">{preview ? `입어보는 중: ${itemLabel(preview)}` : "지금 내 캐릭터"}</span>
          {preview && (
            <button className="ghost" onClick={() => setPreview(null)}>
              원래대로
            </button>
          )}
        </div>
      </div>

      {SECTIONS.map((s) => (
        <div key={s.kind} className="style-section">
          <h4>{s.title}</h4>
          <ul className="catalog-list">
            {items
              .filter((i) => i.kind === s.kind)
              .map((i) => (
                <li key={i.key} className={preview?.key === i.key ? "previewing" : undefined}>
                  <div>
                    <strong>{itemLabel(i)}</strong>
                    <div className="muted">{i.owned ? "✅ 보유" : `${i.price.toLocaleString()}원`}</div>
                  </div>
                  <div className="catalog-actions">
                    <button className="ghost" onClick={() => setPreview(i)}>
                      입어보기
                    </button>
                    {i.owned ? (
                      <button onClick={() => wear(i)} disabled={busy}>
                        입기
                      </button>
                    ) : (
                      <button onClick={() => buy(i)} disabled={busy}>
                        사기
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
