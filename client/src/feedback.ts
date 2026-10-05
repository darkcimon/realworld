// 동작마다 짧은 효과음과 진동(햅틱)을 낸다. 소리는 Web Audio로 그 자리에서 합성해서 음원 파일이 필요 없다.
// 소리/진동은 사이드 메뉴에서 따로 끌 수 있고(이 브라우저에 기억), 진동을 지원하지 않는 기기(iOS 등)는 소리만 난다.
// 브라우저는 사용자가 한 번 누르기 전에는 소리를 막으므로, 첫 터치 때 AudioContext를 깨운다(installTapFeedback).

export type Cue =
  | "tap" // 버튼 누름(아주 작게)
  | "drive" // 차로 출발
  | "walk" // 걸어서 출발
  | "tired" // 지친 걸음
  | "door" // 건물 도착
  | "locked" // 잠긴 건물
  | "refuel" // 주유·주차장 충전
  | "coin" // 돈이 들어옴(수입·보상·판매)
  | "purchase" // 돈을 냄(구매)
  | "correct" // 정답·성공
  | "wrong" // 오답
  | "error" // 요청 실패
  | "jackpot" // 큰 당첨·칭찬
  | "heart" // 하트·인연
  | "message" // 새 메시지·알림
  | "eat" // 먹기·요리 완성
  | "sleep" // 잠자기
  | "hit"; // 리듬게임 박자 맞춤

const SOUND_KEY = "rw_sound_off";
const HAPTIC_KEY = "rw_haptic_off";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, off: boolean) {
  try {
    if (off) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // 저장이 막혀 있으면 이번 세션에서만 적용된다.
  }
}

let soundOff = readFlag(SOUND_KEY);
let hapticOff = readFlag(HAPTIC_KEY);

export function isSoundOn(): boolean {
  return !soundOff;
}
export function isHapticOn(): boolean {
  return !hapticOff;
}
export function setSoundOn(on: boolean) {
  soundOff = !on;
  writeFlag(SOUND_KEY, soundOff);
}
export function setHapticOn(on: boolean) {
  hapticOff = !on;
  writeFlag(HAPTIC_KEY, hapticOff);
  if (!on) haptic(0);
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): AudioContext | null {
  if (soundOff) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 음 하나: 시작 시각(초, 지금부터), 길이, 주파수(끝 주파수가 있으면 미끄러진다), 파형, 크기. */
function tone(at: number, dur: number, freq: number, opts: { to?: number; type?: OscillatorType; vol?: number } = {}) {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
  const vol = opts.vol ?? 0.5;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** 짧은 잡음(발소리·금전등록기 철컥). */
function noise(at: number, dur: number, opts: { vol?: number; lowpass?: number } = {}) {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime + at;
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = opts.lowpass ?? 2000;
  const g = c.createGain();
  g.gain.value = opts.vol ?? 0.4;
  src.connect(filter).connect(g).connect(master);
  src.start(t);
}

/** 진동만(설정에서 진동을 껐으면 무시). */
export function haptic(pattern: number | number[]) {
  if (hapticOff && pattern !== 0) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 진동을 지원하지 않는 기기는 그냥 넘어간다.
  }
}

const SOUNDS: Record<Cue, () => void> = {
  tap: () => tone(0, 0.03, 1400, { type: "triangle", vol: 0.08 }),
  drive: () => {
    tone(0, 0.5, 70, { to: 160, type: "sawtooth", vol: 0.18 });
    tone(0.05, 0.45, 140, { to: 320, type: "square", vol: 0.05 });
  },
  walk: () => {
    noise(0, 0.06, { vol: 0.25, lowpass: 700 });
    noise(0.22, 0.06, { vol: 0.25, lowpass: 700 });
  },
  tired: () => tone(0, 0.6, 330, { to: 160, type: "triangle", vol: 0.3 }),
  door: () => {
    tone(0, 0.25, 784, { vol: 0.35 });
    tone(0.18, 0.4, 587, { vol: 0.35 });
  },
  locked: () => {
    noise(0, 0.05, { vol: 0.4, lowpass: 1200 });
    tone(0.03, 0.15, 180, { type: "square", vol: 0.12 });
  },
  refuel: () => {
    for (let i = 0; i < 5; i++) tone(i * 0.09, 0.08, 300 + i * 70, { to: 500 + i * 80, vol: 0.3 });
  },
  coin: () => {
    tone(0, 0.08, 988, { type: "square", vol: 0.15 });
    tone(0.08, 0.3, 1319, { type: "square", vol: 0.15 });
  },
  purchase: () => {
    noise(0, 0.04, { vol: 0.3, lowpass: 4000 });
    tone(0.04, 0.12, 1568, { type: "triangle", vol: 0.3 });
    tone(0.12, 0.35, 2093, { type: "triangle", vol: 0.25 });
  },
  correct: () => {
    tone(0, 0.12, 523, { type: "triangle", vol: 0.35 });
    tone(0.09, 0.12, 659, { type: "triangle", vol: 0.35 });
    tone(0.18, 0.25, 784, { type: "triangle", vol: 0.35 });
  },
  wrong: () => tone(0, 0.3, 200, { to: 140, type: "square", vol: 0.15 }),
  error: () => {
    tone(0, 0.12, 300, { type: "triangle", vol: 0.25 });
    tone(0.12, 0.2, 220, { type: "triangle", vol: 0.25 });
  },
  jackpot: () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(i * 0.08, 0.2, f, { type: "square", vol: 0.12 }));
    tone(0.42, 0.6, 1568, { type: "triangle", vol: 0.3 });
  },
  heart: () => {
    tone(0, 0.2, 1047, { vol: 0.3 });
    tone(0.1, 0.35, 1568, { vol: 0.25 });
  },
  message: () => {
    tone(0, 0.08, 880, { vol: 0.3 });
    tone(0.1, 0.15, 1175, { vol: 0.3 });
  },
  eat: () => {
    noise(0, 0.05, { vol: 0.25, lowpass: 1500 });
    noise(0.15, 0.05, { vol: 0.25, lowpass: 1500 });
    tone(0.3, 0.25, 659, { to: 880, vol: 0.3 });
  },
  sleep: () => {
    [784, 659, 523, 392].forEach((f, i) => tone(i * 0.22, 0.4, f, { vol: 0.25 }));
  },
  hit: () => tone(0, 0.07, 1200, { type: "triangle", vol: 0.25 }),
};

const HAPTICS: Partial<Record<Cue, number | number[]>> = {
  tap: 8,
  drive: [40, 30, 60],
  walk: [15, 200, 15],
  tired: 120,
  door: 20,
  locked: [30, 40, 30],
  refuel: [20, 60, 20, 60, 20],
  coin: 25,
  purchase: [20, 40, 40],
  correct: 30,
  wrong: [60, 40, 60],
  error: [50, 50, 50],
  jackpot: [60, 40, 60, 40, 150],
  heart: [30, 60, 30],
  message: [20, 50, 20],
  eat: [20, 100, 20],
  sleep: 200,
  hit: 12,
};

/** 효과음과 진동을 함께 낸다. 실패해도 화면 동작에는 영향이 없다. */
export function feedback(cue: Cue) {
  try {
    SOUNDS[cue]();
  } catch {
    // 오디오 오류는 무시한다.
  }
  const h = HAPTICS[cue];
  if (h) haptic(h);
}

/**
 * 모든 버튼에 아주 작은 "톡" 소리와 짧은 진동을 붙인다(첫 터치로 오디오도 깨운다).
 * 버튼에 data-quiet를 달면 빠진다(리듬게임처럼 자체 소리가 있는 곳).
 */
export function installTapFeedback(): () => void {
  const onDown = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.("button");
    if (!el || (el as HTMLButtonElement).disabled || el.closest("[data-quiet]")) return;
    feedback("tap");
  };
  document.addEventListener("pointerdown", onDown, { capture: true });
  return () => document.removeEventListener("pointerdown", onDown, { capture: true });
}
