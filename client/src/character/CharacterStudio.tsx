import { Suspense, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import {
  BODIES,
  FACE_SIZE_RANGE,
  FREE_UNLOCKS,
  HAIR_COLORS,
  HEADS,
  HEIGHT_RANGE,
  SKIN_COLORS,
  defaultCharacter,
  randomCharacter,
  type CharacterConfig,
  type CharacterUnlocks,
} from "./options";
import { CharacterStage } from "./characterLazy";

// 캐릭터 꾸미기 창. 첫 시작(firstTime)에는 "나만의 캐릭터 만들기"로, 이후에는 사이드 메뉴에서 연다.
// 성별·얼굴·키·피부색·헤어 색은 자유롭게 고르고, 옷·헤어스타일은 스타일샵에서 해금한 것만 고를 수 있다(잠긴 건 🔒).
// 얼굴 "사진"은 프로필 사진(avatarUrl)을 동그란 스티커로 붙인다 — 프로필 사진을 바꾸면 캐릭터 얼굴도 바뀐다.
export function CharacterStudio({
  initial,
  photoUrl,
  firstTime = false,
  onSaved,
  onClose,
}: {
  initial: CharacterConfig | null;
  photoUrl: string | null;
  firstTime?: boolean;
  onSaved: (config: CharacterConfig) => void;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<CharacterConfig>(initial ?? defaultCharacter());
  const [hairLocked, setHairLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocks, setUnlocks] = useState<CharacterUnlocks>(FREE_UNLOCKS);
  const set = (patch: Partial<CharacterConfig>) => setConfig((c) => ({ ...c, ...patch }));

  useEffect(() => {
    api.get<CharacterUnlocks>("/profile/character/unlocks").then(setUnlocks, () => {});
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put<{ character: CharacterConfig }>("/profile/character", { character: config });
      onSaved(r.character);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal character-studio" onClick={(e) => e.stopPropagation()}>
        <div className="character-studio-head">
          <h2>{firstTime ? "🧍 나만의 캐릭터 만들기" : "🧍 캐릭터 꾸미기"}</h2>
          <button type="button" className="ghost" onClick={() => setConfig(randomCharacter(unlocks))}>
            🎲 랜덤
          </button>
        </div>
        {firstTime && <p className="muted">다른 사람이 내 프로필을 열면 이 캐릭터가 보여요. 나중에 사이드 메뉴에서 언제든 바꿀 수 있어요.</p>}

        <div className="character-studio-body">
          <Suspense fallback={<div className="character-stage" />}>
            <CharacterStage config={config} photoUrl={photoUrl} showActions onHairLock={setHairLocked} />
          </Suspense>

          <div className="character-options">
            <Field label="얼굴">
              <Seg
                items={[["photo", "사진 얼굴"], ["model", "캐릭터 얼굴"]]}
                value={config.face}
                onPick={(v) => set({ face: v as CharacterConfig["face"] })}
              />
              {config.face === "photo" && !photoUrl && (
                <small className="muted">프로필 사진이 없어서 캐릭터 얼굴로 보여요. 사이드 메뉴에서 프로필 사진을 바꿔 보세요.</small>
              )}
              {config.face === "photo" && photoUrl && (
                <>
                  <small className="muted">내 프로필 사진을 얼굴에 붙여요. 프로필 사진은 원래 다른 사람에게도 보여요.</small>
                  <Range
                    label="사진 크기"
                    value={config.faceSize}
                    min={FACE_SIZE_RANGE.min}
                    max={FACE_SIZE_RANGE.max}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => set({ faceSize: v })}
                  />
                </>
              )}
            </Field>

            <Field label="성별">
              <Seg
                items={[["female", "여자"], ["male", "남자"]]}
                value={config.gender}
                onPick={(v) => setConfig((c) => ({ ...defaultCharacter(v as CharacterConfig["gender"]), skin: c.skin, hair: c.hair, face: c.face, faceSize: c.faceSize }))}
              />
            </Field>
            <Field label="옷 스타일">
              <Seg
                items={BODIES[config.gender]}
                value={config.body}
                onPick={(v) => set({ body: v })}
                locked={(v) => !unlocks.bodies[config.gender].includes(v)}
                small
              />
            </Field>
            <Field label="헤어스타일">
              <Seg items={HEADS} value={config.head} onPick={(v) => set({ head: v })} locked={(v) => !unlocks.heads.includes(v)} small />
            </Field>
            <small className="muted">🔒 잠긴 옷·헤어스타일은 마을의 👗 스타일샵(내 집 옆)에서 해금할 수 있어요.</small>
            <Range
              label="키"
              value={config.height}
              min={HEIGHT_RANGE.min}
              max={HEIGHT_RANGE.max}
              step={1}
              format={(v) => `${v}cm`}
              onChange={(v) => set({ height: v })}
            />
            <div className="character-colors">
              <Field label="피부색">
                <Swatches colors={SKIN_COLORS} value={config.skin} label="피부색" onPick={(i) => set({ skin: i })} />
              </Field>
              <Field label="헤어 색">
                <Swatches colors={HAIR_COLORS} value={config.hair} label="헤어 색" onPick={(i) => set({ hair: i })} />
                {hairLocked && config.hair !== 0 && (
                  <small className="muted">이 헤어는 캐릭터 얼굴일 때 색을 바꿀 수 없어요(눈과 같은 색이라).</small>
                )}
              </Field>
            </div>
          </div>
        </div>

        {error && <p className="error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onClose}>
            {firstTime ? "나중에 할게요" : "닫기"}
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장하기"}
          </button>
        </div>
        <small className="muted character-credit">캐릭터 모델: Kenney "Mini Characters" (CC0)</small>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="character-field">
      <span className="character-field-label">{label}</span>
      {children}
    </div>
  );
}

function Seg({
  items,
  value,
  onPick,
  locked,
  small = false,
}: {
  items: [string, string][];
  value: string;
  onPick: (v: string) => void;
  locked?: (v: string) => boolean;
  small?: boolean;
}) {
  return (
    <div className={`character-seg${small ? " small" : ""}`}>
      {items.map(([v, label]) => {
        const isLocked = locked?.(v) ?? false;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            className={value === v ? "active" : ""}
            disabled={isLocked}
            title={isLocked ? "스타일샵에서 해금하세요" : undefined}
            onClick={() => onPick(v)}
          >
            {isLocked ? `🔒 ${label}` : label}
          </button>
        );
      })}
    </div>
  );
}

function Swatches({
  colors,
  value,
  label,
  onPick,
}: {
  colors: (string | null)[];
  value: number;
  label: string;
  onPick: (i: number) => void;
}) {
  return (
    <div className="character-swatches">
      {colors.map((c, i) => (
        <button
          key={i}
          type="button"
          className={`character-swatch${value === i ? " active" : ""}`}
          style={c ? { background: c } : undefined}
          aria-label={c ? `${label} ${i}` : `${label} 원래 색`}
          aria-pressed={value === i}
          onClick={() => onPick(i)}
        >
          {c ? "" : "원래"}
        </button>
      ))}
    </div>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="character-field">
      <span className="character-field-label">
        {label} <output>{format(value)}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
