// 출생 연월 고르기(자기 신고 연령 확인). "정답"을 암시하지 않도록 기본값 없이 비워 두고, 몇 살부터인지도 미리 말하지 않는다.
const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 100 }, (_, i) => THIS_YEAR - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** value: "YYYY-MM" 또는 "" (아직 안 고름) */
export function BirthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [y, m] = value ? value.split("-") : ["", ""];
  const set = (year: string, month: string) => onChange(year && month ? `${year}-${month}` : year || month ? `${year}-${month}` : "");
  return (
    <div className="birth-picker">
      <span className="hint">태어난 해와 달</span>
      <div className="row">
        <select value={y} onChange={(e) => set(e.target.value, m)} aria-label="태어난 해">
          <option value="">년</option>
          {YEARS.map((n) => (
            <option key={n} value={n}>
              {n}년
            </option>
          ))}
        </select>
        <select value={m} onChange={(e) => set(y, e.target.value)} aria-label="태어난 달">
          <option value="">월</option>
          {MONTHS.map((n) => (
            <option key={n} value={String(n).padStart(2, "0")}>
              {n}월
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** 년·월을 모두 골랐는지 */
export function birthComplete(v: string): boolean {
  return /^\d{4}-\d{2}$/.test(v);
}

// 만 14세 미만으로 가입이 막히면 이 기기에서 하루 동안 다시 시도하지 못하게 기억한다(나이를 바꿔 재시도하는 것 방지).
const UNDERAGE_KEY = "rw_underage_at";
export function markUnderage() {
  try {
    localStorage.setItem(UNDERAGE_KEY, String(Date.now()));
  } catch {
    // 저장이 막혀 있으면 서버 거부만으로 막는다.
  }
}
export function underageLocked(): boolean {
  try {
    const at = Number(localStorage.getItem(UNDERAGE_KEY));
    return !!at && Date.now() - at < 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}
