// 계산기형 숫자 키패드(README 6.3). 알바 계산은 "직접 계산해서 금액을 입력"하는 것이 본질이라
// 객관식으로 바꾸지 않고, 풀 키보드 대신 숫자 버튼만 제공해 타이핑 마찰만 줄인다.
const MAX_DIGITS = 9;

export function NumberKeypad({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  function press(d: string) {
    if (value.length >= MAX_DIGITS) return;
    if (value === "0") onChange(d === "0" || d === "00" ? "0" : d);
    else onChange(value + d);
  }

  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"];

  return (
    <div className="keypad">
      <div className="keypad-display" aria-live="polite">
        {value === "" ? "0" : Number(value).toLocaleString()}
        <span>원</span>
      </div>
      <div className="keypad-grid">
        {keys.map((k) => (
          <button key={k} type="button" disabled={disabled} onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <button type="button" className="keypad-back" disabled={disabled} onClick={() => onChange(value.slice(0, -1))}>
          ⌫
        </button>
      </div>
      <div className="keypad-actions">
        <button type="button" className="ghost" disabled={disabled} onClick={() => onChange("")}>
          지우기
        </button>
        <button type="button" disabled={disabled || value === ""} onClick={onSubmit}>
          계산하기
        </button>
      </div>
    </div>
  );
}
