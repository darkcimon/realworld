// 채팅창·칠판은 수식 렌더러 없이 글자 그대로 보여준다. LLM이 프롬프트 지시를 어기고 LaTeX/마크다운
// 수식($a_n = a_1 + (n-1)d$, \frac{1}{2}, x^2, **굵게**)을 섞어 보내면 기호가 그대로 노출되므로,
// 흔한 표기를 읽기 쉬운 유니코드 텍스트(aₙ = a₁ + (n−1)d, 1/2, x²)로 바꾼다. 완벽한 LaTeX 변환이
// 목적이 아니라 학생 눈에 "이상한 문자"가 안 보이게 하는 안전망이다.
import type { BoardCommand } from "./AIProvider.js";

const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ",
  r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};
const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", x: "ˣ", k: "ᵏ", m: "ᵐ",
};

const SYMBOLS: [RegExp, string][] = [
  [/\\times/g, "×"],
  [/\\cdot/g, "·"],
  [/\\div/g, "÷"],
  [/\\pm/g, "±"],
  [/\\leq?/g, "≤"],
  [/\\geq?/g, "≥"],
  [/\\neq?/g, "≠"],
  [/\\approx/g, "≈"],
  [/\\infty/g, "∞"],
  [/\\pi/g, "π"],
  [/\\theta/g, "θ"],
  [/\\alpha/g, "α"],
  [/\\beta/g, "β"],
  [/\\Delta/g, "Δ"],
  [/\\sum/g, "Σ"],
  [/\\rightarrow|\\to/g, "→"],
  [/\\Rightarrow/g, "⇒"],
  [/\\angle/g, "∠"],
  [/\\triangle/g, "△"],
  [/\\circ/g, "°"],
  [/\\%/g, "%"],
  [/\\[,;:! ]/g, " "],
  [/\\quad|\\qquad/g, " "],
];

/** 모든 글자를 위/아래 첨자로 바꿀 수 있을 때만 바꾸고, 아니면 _(…)/^(…) 꼴로 남긴다. */
function script(body: string, table: Record<string, string>, mark: string): string {
  const chars = [...body];
  if (chars.every((c) => table[c])) return chars.map((c) => table[c]).join("");
  return body.length === 1 ? `${mark}${body}` : `${mark}(${body})`;
}

function convertMath(src: string): string {
  let s = src;
  // \frac{a}{b} → (a)/(b) — 한 글자/숫자면 괄호 생략
  const wrap = (x: string) => (/^(\d+(\.\d+)?|[A-Za-z])$/.test(x) ? x : `(${x})`);
  s = s.replace(/\^\{?\\circ\}?/g, "°");
  // 안쪽부터 풀어야 \frac{-b \pm \sqrt{…}}{2a}처럼 중첩된 것도 처리된다.
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_, a) => `√${wrap(a)}`);
    s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => `${wrap(a)}/${wrap(b)}`);
  }
  s = s.replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\left|\\right/g, "");
  for (const [re, to] of SYMBOLS) s = s.replace(re, to);
  // 첨자: a_{n-1}, a_n, x^{2}, x^2
  s = s.replace(/_\{([^{}]*)\}/g, (_, b) => script(b, SUB, "_"));
  s = s.replace(/_([A-Za-z0-9])/g, (_, b) => script(b, SUB, "_"));
  s = s.replace(/\^\{([^{}]*)\}/g, (_, b) => script(b, SUP, "^"));
  s = s.replace(/\^([A-Za-z0-9])/g, (_, b) => script(b, SUP, "^"));
  s = s.replace(/[{}]/g, "");
  // 남은 알 수 없는 명령어(\foo)는 이름만 남긴다.
  s = s.replace(/\\([A-Za-z]+)/g, "$1");
  return s;
}

export function plainMath(text: string): string {
  if (!text) return text;
  // 개인 수업 답변은 JSON으로 오므로 "\frac", "\times", "\beta", "\right"의 앞부분이 JSON 이스케이프
  // (\f 폼피드, \t 탭, \b 백스페이스, \r 캐리지리턴)로 먹혀 들어온다 — 뒤에 글자가 이어지면 명령어로 되돌린다.
  let s = text
    .replace(/\f/g, "\\f")
    .replace(/\x08/g, "\\b")
    .replace(/\t(?=[a-z])/g, "\\t")
    .replace(/\r(?=[a-z])/gi, "\\r");
  // $$…$$, $…$, \(…\), \[…\] 안쪽만 수식으로 변환하고 구분 기호는 지운다.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => convertMath(m));
  // 한 줄 수식은 "$ 바로 뒤와 닫는 $ 바로 앞이 공백이 아니고, 닫는 $ 뒤에 숫자가 없을 때"만 수식으로 본다
  // ("$5 와 $10" 같은 금액 표기는 건드리지 않는다).
  s = s.replace(/\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_, m) => convertMath(m));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => convertMath(m));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => convertMath(m));
  // 구분 기호 없이 쓴 LaTeX 명령어도 처리한다(예: "1 \times 3").
  if (/\\[A-Za-z]/.test(s)) s = convertMath(s);
  // 마크다운 강조/코드 표시 제거
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  return s;
}

export function plainMathBoard(board: BoardCommand[]): BoardCommand[] {
  return board.map((c) => (c.type === "text" ? { ...c, text: plainMath(c.text) } : c));
}
